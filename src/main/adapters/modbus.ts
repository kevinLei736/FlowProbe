import * as net from 'node:net'
import { SerialPort } from 'serialport'
import type {
  ConnectionKind,
  ModbusConfig,
  ModbusPoint,
  ModbusPointValue,
  OutgoingFrame,
  SessionConfig
} from '@shared/protocol'
import { BaseAdapter } from './base'
import { Backoff, formatWait, normalizeBackoff } from './reconnect'
import {
  appendCrc,
  buildReadPdu,
  buildWriteCoilPdu,
  buildWriteRegisterPdu,
  buildWriteRegistersPdu,
  checkCrc,
  decodeValue,
  defaultModbusConfig,
  encodeValue,
  parsePdu,
  planReads,
  sliceForPoint,
  wrapMbap
} from '../modbus/pdu'

interface Pending {
  /** 期望的从站地址与功能码，用于校验响应是否对得上 */
  unitId: number
  func: number
  /** TCP 的事务标识；RTU 恒为 0 */
  txId: number
  resolve: (pdu: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Modbus 主站适配器（TCP / RTU / RTU over TCP）。
 *
 * 关键约束：Modbus 是严格的「一问一答」协议，同一条链路上不允许并发请求。
 * 因此这里用一个串行队列，所有读写都排队执行，队列之间按 gapMs 留间隔。
 * 不排队的话从站会直接丢包或返回「设备忙」，现场表现为读数随机缺失。
 */
export class ModbusAdapter extends BaseAdapter {
  readonly kind: ConnectionKind
  private socket: net.Socket | null = null
  private port: SerialPort | null = null
  private backoff: Backoff
  private manualStop = false
  private everConnected = false
  private txId = 1
  private pending: Pending | null = null
  /** RTU 接收缓冲：串口按字节流到达，需要自己判帧 */
  private rxBuf: Buffer = Buffer.alloc(0)
  private rtuTimer: NodeJS.Timeout | null = null
  /** 串行队列：Modbus 不允许同链路并发 */
  private queue: Array<() => Promise<void>> = []
  private draining = false
  private pollTimers: NodeJS.Timeout[] = []
  /** 点位最近一次的值，供渲染层初始化 */
  private lastValues = new Map<string, ModbusPointValue>()

  constructor(id: string, config: SessionConfig, kind: ConnectionKind = 'modbus-tcp') {
    super(id, config)
    this.kind = kind
    this.backoff = new Backoff(normalizeBackoff(config))
  }

  private get cfg(): ModbusConfig {
    const raw = this.config.modbus
    if (raw) return raw as ModbusConfig
    return defaultModbusConfig(this.kind === 'modbus-rtu' ? 'rtu' : 'tcp')
  }

  private get isSerial(): boolean {
    return this.cfg.transport === 'rtu'
  }

  async start(): Promise<void> {
    this.manualStop = false
    this.everConnected = false
    this.backoff.update(normalizeBackoff(this.config))
    this.backoff.reset()
    if (this.isSerial) await this.openSerial()
    else this.openTcp()
  }

  // —— 链路层：TCP ——

  private openTcp(): void {
    const cfg = this.cfg
    const host = String(cfg.host ?? '127.0.0.1')
    const port = Number(cfg.port ?? 502)
    this.emitStatus('connecting', `正在连接 ${host}:${port}`)

    const socket = new net.Socket()
    this.socket = socket
    socket.setNoDelay(true)

    const timer = setTimeout(() => {
      if (socket.connecting) socket.destroy(new Error('连接超时'))
    }, Math.max(1000, Number(cfg.timeoutMs ?? 1000) * 3))

    socket.connect(port, host, () => {
      clearTimeout(timer)
      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everConnected = true
      this.emitStatus('connected', `已连接 ${host}:${port}`)
      this.emitConn(
        `Modbus ${cfg.transport === 'rtu-over-tcp' ? 'RTU over TCP' : 'TCP'} 已连接 ${host}:${port}` +
          ` 从站 ${cfg.unitId}` +
          (retried > 0 ? `（重连第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.startPolling()
    })

    socket.on('data', (chunk) => this.onBytes(chunk))
    socket.on('error', (err) => {
      clearTimeout(timer)
      this.emitError(err.message)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      this.stopPolling()
      this.failPending('链路已断开')
      if (this.manualStop) {
        this.emitStatus('closed', '连接已关闭')
        this.emitConn('连接已关闭（手动停止）', 'info')
        return
      }
      this.emitStatus('closed', '连接断开')
      this.emitConn(this.everConnected ? 'Modbus 连接断开' : 'Modbus 连接未建立', 'warn')
      this.scheduleReconnect()
    })
  }

  // —— 链路层：串口 RTU ——

  private async openSerial(): Promise<void> {
    const cfg = this.cfg
    const path = String(this.config.serialPath ?? 'COM1')
    const baudRate = Number(this.config.baudRate ?? 9600)
    this.emitStatus('connecting', `正在打开 ${path} @ ${baudRate}`)
    try {
      const port = new SerialPort({
        path,
        baudRate,
        dataBits: Number(this.config.dataBits ?? 8) as 5 | 6 | 7 | 8,
        stopBits: Number(this.config.stopBits ?? 1) as 1 | 1.5 | 2,
        parity: (this.config.parity as 'none' | 'even' | 'odd') ?? 'none',
        autoOpen: false
      })
      this.port = port
      port.on('data', (chunk: Buffer) => this.onBytes(chunk))
      port.on('error', (err: Error) => this.emitError(err.message))
      port.on('close', () => {
        this.stopPolling()
        this.failPending('串口已关闭')
        this.emitStatus('closed', '串口已关闭')
        if (this.manualStop) {
          this.emitConn('串口已关闭（手动停止）', 'info')
          return
        }
        this.emitConn(this.everConnected ? '串口意外断开' : '串口未打开', 'warn')
        this.scheduleReconnect()
      })
      await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())))
      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everConnected = true
      this.emitStatus('connected', `已打开 ${path}`)
      this.emitConn(
        `Modbus RTU 已打开 ${path} @ ${baudRate} 从站 ${cfg.unitId}` +
          (retried > 0 ? `（重试第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.startPolling()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      this.emitError(msg)
      this.emitStatus('error', msg)
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.config.autoReconnect === false || this.manualStop) return
    const planned = this.backoff.schedule(() => {
      if (this.isSerial) void this.openSerial()
      else this.openTcp()
    })
    if (!planned) {
      const limit = normalizeBackoff(this.config).maxAttempts
      this.emitConn(`已重连 ${limit} 次仍未成功，停止重连`, 'error')
      this.emitStatus('error', '重连次数已用尽')
      return
    }
    this.emitConn(`第 ${planned.attempt} 次重连将在 ${formatWait(planned.delayMs)} 后开始`, 'warn')
  }

  // —— 判帧 ——

  /**
   * 收到字节。
   * Modbus TCP 有 MBAP 长度域，可精确切帧；
   * RTU 没有长度域，标准做法是靠 3.5 个字符时间的静默判帧。
   * 这里用「按功能码推算期望长度 + 静默兜底」双保险：
   * 纯靠静默在高波特率下容易把两帧粘在一起。
   */
  private onBytes(chunk: Buffer): void {
    this.rxBuf = this.rxBuf.length ? Buffer.concat([this.rxBuf, chunk]) : chunk
    if (this.cfg.transport === 'tcp') {
      while (this.rxBuf.length >= 6) {
        const len = this.rxBuf.readUInt16BE(4)
        if (this.rxBuf.length < 6 + len) break
        const txId = this.rxBuf.readUInt16BE(0)
        const pdu = Buffer.from(this.rxBuf.subarray(6, 6 + len))
        this.rxBuf = this.rxBuf.subarray(6 + len)
        this.deliver(pdu, txId)
      }
      return
    }
    // RTU / RTU over TCP：先试按期望长度切，切不出来再等静默
    this.tryCutRtu()
    this.scheduleRtuIdle()
  }

  private tryCutRtu(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const expect = expectedRtuLength(this.rxBuf)
      if (expect <= 0 || this.rxBuf.length < expect) return
      const frame = Buffer.from(this.rxBuf.subarray(0, expect))
      this.rxBuf = this.rxBuf.subarray(expect)
      this.handleRtuFrame(frame)
    }
  }

  private scheduleRtuIdle(): void {
    if (this.rtuTimer) clearTimeout(this.rtuTimer)
    // 3.5 字符时间：9600 波特下约 4ms，这里给下限 8ms 兼顾 USB 转串口的批量投递
    const baud = Number(this.config.baudRate ?? 9600)
    const charMs = (11 * 1000) / Math.max(1200, baud)
    const idle = Math.max(8, Math.ceil(charMs * 3.5))
    this.rtuTimer = setTimeout(() => {
      if (this.rxBuf.length === 0) return
      const frame = Buffer.from(this.rxBuf)
      this.rxBuf = Buffer.alloc(0)
      this.handleRtuFrame(frame)
    }, idle)
  }

  private handleRtuFrame(frame: Buffer): void {
    if (!checkCrc(frame)) {
      this.emitSystem(`丢弃 CRC 校验失败的帧：${frame.toString('hex')}`, 'warn')
      return
    }
    this.deliver(Buffer.from(frame.subarray(0, frame.length - 2)), 0)
  }

  /** 把收到的 PDU 交给等待中的请求 */
  private deliver(pdu: Buffer, txId: number): void {
    const p = this.pending
    if (!p) {
      this.emitSystem(`收到无人认领的响应：${pdu.toString('hex')}`, 'warn')
      return
    }
    if (this.cfg.transport === 'tcp' && txId !== p.txId) {
      // 事务号对不上说明是上一次超时请求的迟到响应，丢掉但记一笔
      this.emitSystem(`忽略事务号不匹配的响应（期望 ${p.txId}，实到 ${txId}）`, 'warn')
      return
    }
    clearTimeout(p.timer)
    this.pending = null
    p.resolve(pdu)
  }

  private failPending(reason: string): void {
    const p = this.pending
    if (!p) return
    clearTimeout(p.timer)
    this.pending = null
    p.reject(new Error(reason))
  }

  // —— 请求执行 ——

  private writeBytes(bytes: Buffer): void {
    if (this.isSerial) this.port?.write(bytes)
    else this.socket?.write(bytes)
  }

  /** 发一个 PDU 并等响应。串行队列保证同时只有一个在飞。 */
  private request(pdu: Buffer, note: string): Promise<Buffer> {
    const cfg = this.cfg
    return new Promise<Buffer>((resolve, reject) => {
      const linkUp = this.isSerial ? this.port?.isOpen : this.socket && !this.socket.destroyed
      if (!linkUp) {
        reject(new Error('链路未建立'))
        return
      }
      const txId = this.cfg.transport === 'tcp' ? this.nextTxId() : 0
      const wire = this.cfg.transport === 'tcp' ? wrapMbap(txId, pdu) : appendCrc(pdu)
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`响应超时（${cfg.timeoutMs}ms）`))
      }, Math.max(100, Number(cfg.timeoutMs ?? 1000)))
      this.pending = {
        unitId: pdu.readUInt8(0),
        func: pdu.readUInt8(1),
        txId,
        resolve,
        reject,
        timer
      }
      this.writeBytes(wire)
      this.emitData('tx', wire, 'hex', undefined, {
        funcCode: pdu.readUInt8(1),
        unitId: pdu.readUInt8(0),
        note
      })
    })
  }

  private nextTxId(): number {
    this.txId = (this.txId + 1) & 0xffff
    if (this.txId === 0) this.txId = 1
    return this.txId
  }

  /** 带重试的请求。重试次数用尽后抛错，由调用方决定如何报告。 */
  private async requestWithRetry(pdu: Buffer, note: string): Promise<Buffer> {
    const retries = Math.max(0, Number(this.cfg.retries ?? 0))
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.request(pdu, attempt === 0 ? note : `${note}（重试 ${attempt}）`)
      } catch (e) {
        lastErr = e as Error
        this.rxBuf = Buffer.alloc(0)
      }
    }
    throw lastErr ?? new Error('请求失败')
  }

  /** 入队。队列串行执行，每次之间留 gapMs，避免把从站打爆。 */
  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    const gap = Math.max(0, Number(this.cfg.gapMs ?? 0))
    while (this.queue.length) {
      const job = this.queue.shift()!
      try {
        await job()
      } catch (e) {
        this.emitError(String((e as Error)?.message ?? e))
      }
      if (gap > 0 && this.queue.length) await sleep(gap)
    }
    this.draining = false
  }

  // —— 轮询 ——

  /**
   * 按点位的 pollMs 分组起定时器。
   * 同一组内的点位先合并成批量读，再排队执行——
   * 40 个点位如果逐点读要 40 次往返，合并后通常只剩几次。
   */
  private startPolling(): void {
    this.stopPolling()
    const cfg = this.cfg
    const active = cfg.points.filter((p) => p.enabled && p.pollMs > 0)
    if (active.length === 0) return
    const groups = new Map<number, ModbusPoint[]>()
    for (const p of active) {
      const key = Math.max(50, p.pollMs)
      const list = groups.get(key)
      if (list) list.push(p)
      else groups.set(key, [p])
    }
    for (const [interval, points] of groups) {
      const tick = (): void => this.enqueue(() => this.readPoints(points))
      tick()
      this.pollTimers.push(setInterval(tick, interval))
    }
  }

  private stopPolling(): void {
    for (const t of this.pollTimers) clearInterval(t)
    this.pollTimers = []
    this.queue = []
  }

  /** 读一组点位（内部先做批量合并） */
  private async readPoints(points: ModbusPoint[]): Promise<void> {
    const cfg = this.cfg
    const plans = planReads(points, cfg)
    const values: ModbusPointValue[] = []
    for (const plan of plans) {
      const pdu = buildReadPdu(cfg.unitId, plan.func, plan.startAddr, plan.quantity)
      const note = `读 ${describeFunc(plan.func)} ${plan.startAddr}×${plan.quantity}`
      try {
        const resp = await this.requestWithRetry(pdu, note)
        const parsed = parsePdu(resp)
        if (typeof parsed === 'string') {
          this.emitSystem(`${note} 解析失败：${parsed}`, 'error')
          continue
        }
        this.emitData('rx', resp, 'hex', undefined, {
          funcCode: parsed.func,
          unitId: parsed.unitId,
          addr: plan.startAddr,
          quantity: plan.quantity,
          exceptionCode: parsed.exception?.code,
          note: parsed.exception ? parsed.exception.message : note
        })
        if (parsed.exception) {
          this.emitSystem(`${note} 返回异常：${parsed.exception.message}`, 'error')
          for (const item of plan.items) {
            values.push({
              pointId: item.point.id,
              ts: Date.now(),
              value: null,
              rawHex: '',
              error: parsed.exception.message
            })
          }
          continue
        }
        const data = parsed.data ?? Buffer.alloc(0)
        for (const item of plan.items) {
          const slice = sliceForPoint(plan, item, data)
          const decoded = decodeValue(item.point, slice, cfg)
          values.push({
            pointId: item.point.id,
            ts: Date.now(),
            value: decoded.value,
            rawHex: decoded.rawHex,
            error: decoded.error
          })
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        this.emitSystem(`${note} 失败：${msg}`, 'warn')
        for (const item of plan.items) {
          values.push({ pointId: item.point.id, ts: Date.now(), value: null, rawHex: '', error: msg })
        }
      }
    }
    if (values.length) {
      for (const v of values) this.lastValues.set(v.pointId, v)
      this.emitRaw({ type: 'modbusValues', sessionId: this.id, values })
    }
  }

  /** 手动读单个点位 */
  readPoint(pointId: string): void {
    const point = this.cfg.points.find((p) => p.id === pointId)
    if (!point) return
    this.enqueue(() => this.readPoints([point]))
  }

  /** 写入点位。写完立刻回读一次，界面上能立即看到生效结果。 */
  writePoint(pointId: string, input: number | boolean): void {
    const cfg = this.cfg
    const point = cfg.points.find((p) => p.id === pointId)
    if (!point) return
    if (!point.writable) {
      this.emitError(`点位「${point.name}」未开启写入权限`)
      return
    }
    this.enqueue(async () => {
      let pdu: Buffer
      let note: string
      if (point.func === 1) {
        const on = typeof input === 'boolean' ? input : Number(input) !== 0
        pdu = buildWriteCoilPdu(cfg.unitId, point.addr, on)
        note = `写线圈 ${point.addr} = ${on ? 1 : 0}`
      } else if (point.func === 3 || point.func === 4) {
        const encoded = encodeValue(point, Number(input), cfg)
        if (typeof encoded === 'string') {
          this.emitError(`写入「${point.name}」失败：${encoded}`)
          return
        }
        if (encoded.length === 1) {
          pdu = buildWriteRegisterPdu(cfg.unitId, point.addr, encoded[0])
          note = `写寄存器 ${point.addr} = ${input}`
        } else {
          pdu = buildWriteRegistersPdu(cfg.unitId, point.addr, encoded)
          note = `写多寄存器 ${point.addr}×${encoded.length} = ${input}`
        }
      } else {
        this.emitError(`点位「${point.name}」的功能码 ${point.func} 不支持写入`)
        return
      }
      try {
        const resp = await this.requestWithRetry(pdu, note)
        const parsed = parsePdu(resp)
        if (typeof parsed === 'string') {
          this.emitSystem(`${note} 响应异常：${parsed}`, 'error')
          return
        }
        this.emitData('rx', resp, 'hex', undefined, {
          funcCode: parsed.func,
          unitId: parsed.unitId,
          addr: parsed.echoAddr,
          exceptionCode: parsed.exception?.code,
          note: parsed.exception ? parsed.exception.message : note + ' 成功'
        })
        if (parsed.exception) {
          this.emitSystem(`${note} 被拒绝：${parsed.exception.message}`, 'error')
          return
        }
        this.emitSystem(`${note} 成功`, 'success')
      } catch (e) {
        this.emitSystem(`${note} 失败：${String((e as Error)?.message ?? e)}`, 'warn')
        return
      }
      // 回读确认
      await this.readPoints([point])
    })
  }

  /** 点表变更：重新排轮询计划，不断开链路 */
  updatePoints(points: ModbusPoint[]): void {
    const cfg = this.cfg
    cfg.points = points
    this.config.modbus = cfg
    const running = this.isSerial ? this.port?.isOpen : this.socket && !this.socket.destroyed
    if (running) this.startPolling()
  }

  /** 已缓存的点位值，供界面初次渲染 */
  snapshotValues(): ModbusPointValue[] {
    return [...this.lastValues.values()]
  }

  /** 允许直接发原始 PDU（HEX），方便调试非标准功能码 */
  async send(out: OutgoingFrame): Promise<void> {
    const hex = out.content.replace(/[^0-9a-fA-F]/g, '')
    if (hex.length < 4) {
      this.emitError('请输入至少两个字节的 PDU（从站地址 + 功能码）')
      return
    }
    const pdu = Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, 'hex')
    this.enqueue(async () => {
      try {
        const resp = await this.requestWithRetry(pdu, '手动 PDU')
        const parsed = parsePdu(resp)
        this.emitData('rx', resp, 'hex', undefined, {
          funcCode: typeof parsed === 'string' ? undefined : parsed.func,
          note: typeof parsed === 'string' ? parsed : parsed.exception?.message
        })
      } catch (e) {
        this.emitSystem(`手动 PDU 失败：${String((e as Error)?.message ?? e)}`, 'warn')
      }
    })
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.backoff.cancel()
    this.stopPolling()
    if (this.rtuTimer) clearTimeout(this.rtuTimer)
    this.rtuTimer = null
    this.failPending('会话已停止')
    this.rxBuf = Buffer.alloc(0)
    this.socket?.destroy()
    this.socket = null
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()))
    }
    this.port = null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function describeFunc(func: number): string {
  switch (func) {
    case 1:
      return '线圈'
    case 2:
      return '离散输入'
    case 3:
      return '保持寄存器'
    case 4:
      return '输入寄存器'
    default:
      return `功能码 ${func}`
  }
}

/**
 * 按功能码推算 RTU 响应的完整长度（含 CRC）。
 * 返回 0 表示还看不出来，需要继续等字节。
 */
function expectedRtuLength(buf: Buffer): number {
  if (buf.length < 2) return 0
  const func = buf.readUInt8(1)
  // 异常响应固定 5 字节：地址 + 功能码|0x80 + 异常码 + CRC2
  if (func & 0x80) return 5
  if (func >= 1 && func <= 4) {
    if (buf.length < 3) return 0
    return 3 + buf.readUInt8(2) + 2
  }
  // 写响应固定 8 字节：地址 + 功能码 + 地址2 + 值/数量2 + CRC2
  if (func === 5 || func === 6 || func === 15 || func === 16) return 8
  return 0
}
