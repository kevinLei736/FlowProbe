import * as net from 'node:net'
import { SerialPort } from 'serialport'
import type {
  ConnectionKind,
  ModbusArea,
  ModbusSlaveConfig,
  ModbusSlaveRegion,
  ModbusSlaveRegionValues,
  OutgoingFrame,
  Peer,
  SessionConfig
} from '@shared/protocol'
import { BaseAdapter } from './base'
import { appendCrc, checkCrc, wrapMbap } from '../modbus/pdu'
import { ModbusSlaveStore, areaLabel, defaultSlaveConfig } from '../modbus/slave'

interface ClientEntry {
  peer: Peer
  socket: net.Socket
  /** 每条连接各有自己的接收缓冲：MBAP 切帧必须按连接独立进行 */
  rx: Buffer
}

/**
 * Modbus 从站模拟适配器（TCP / RTU over TCP 监听，或串口 RTU 应答）。
 *
 * 为什么需要它：项目已有 Modbus 主站，但没有真实设备时点表配得对不对无法自证。
 * 字序、寄存器偏移、工程值换算恰恰是最容易配错、且错了还「读得出数」的三处。
 * 有了从站，主站的配置就能在本机闭环验证。
 *
 * 与主站适配器的角色对调：这里是「等请求、给应答」，所以没有轮询、没有串行队列、
 * 也没有重连——监听失败就是失败（端口被占），退避重试只会掩盖问题。
 */
export class ModbusSlaveAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'modbus-slave'
  private server: net.Server | null = null
  private port: SerialPort | null = null
  private clients = new Map<string, ClientEntry>()
  private seq = 0
  private store: ModbusSlaveStore
  /** 串口 RTU 的接收缓冲与静默判帧定时器 */
  private rxBuf: Buffer = Buffer.alloc(0)
  private rtuTimer: NodeJS.Timeout | null = null
  private animTimer: NodeJS.Timeout | null = null
  private pushTimer: NodeJS.Timeout | null = null
  /** 待推送给界面的区，合并后统一发一次，避免每次改值都过一趟 IPC */
  private dirty = new Set<ModbusArea>()
  private reqCount = 0

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    this.store = new ModbusSlaveStore(this.cfg)
  }

  private get cfg(): ModbusSlaveConfig {
    const raw = this.config.modbusSlave
    if (raw) return raw as ModbusSlaveConfig
    return defaultSlaveConfig('tcp')
  }

  private get isSerial(): boolean {
    return this.cfg.transport === 'rtu'
  }

  async start(): Promise<void> {
    this.store.update(this.cfg)
    if (this.isSerial) await this.openSerial()
    else this.listenTcp()
  }

  // —— 链路：TCP 监听 ——

  private listenTcp(): void {
    const cfg = this.cfg
    const host = String(cfg.host ?? '0.0.0.0')
    const port = Number(cfg.port ?? 502)
    this.emitStatus('connecting', `正在监听 ${host}:${port}`)
    const server = net.createServer()
    this.server = server

    server.on('connection', (socket) => {
      const max = Math.max(1, Number(cfg.maxClients ?? 8))
      if (this.clients.size >= max) {
        // 明确拒绝而不是静默排队：主站连不上时能立刻看到原因
        this.emitSystem(`已达最大连接数 ${max}，拒绝 ${socket.remoteAddress}:${socket.remotePort}`, 'warn')
        socket.destroy()
        return
      }
      this.seq += 1
      const id = 'c' + this.seq
      const label = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`
      const entry: ClientEntry = { peer: { id, label, connectedAt: Date.now() }, socket, rx: Buffer.alloc(0) }
      this.clients.set(id, entry)
      socket.setNoDelay(true)
      this.emitPeer(entry.peer, true)
      this.emitConn(`主站接入 ${label}`, 'success')

      socket.on('data', (chunk) => this.onTcpBytes(entry, chunk))
      socket.on('error', (err) => this.emitSystem(`${label} 连接错误：${err.message}`, 'warn')) 
      socket.on('close', () => {
        this.clients.delete(id)
        this.emitPeer(entry.peer, false)
        this.emitConn(`主站断开 ${label}`, 'info')
      })
    })

    server.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用。Modbus 默认端口 502 在部分系统上需要管理员权限，可改用 5020 等高位端口`
        : err.message
      this.emitError(msg)
      this.emitStatus('error', msg)
    })

    server.listen(port, host, () => {
      this.emitStatus('listening', `监听 ${host}:${port}`)
      this.emitConn(
        `Modbus 从站已监听 ${host}:${port}（${cfg.transport === 'rtu-over-tcp' ? 'RTU over TCP' : 'TCP'}）` +
          `，从站地址 ${cfg.acceptAnyUnit ? '任意' : cfg.unitId}`,
        'success'
      )
      this.describeRegions()
      this.startAnimation()
    })
  }

  // —— 链路：串口 RTU ——

  private async openSerial(): Promise<void> {
    const cfg = this.cfg
    const path = String(this.config.serialPath ?? 'COM1')
    const baudRate = Number(this.config.baudRate ?? 9600)
    this.emitStatus('connecting', `正在打开 ${path} @ ${baudRate}`)
    try {
      const sp = new SerialPort({
        path,
        baudRate,
        dataBits: Number(this.config.dataBits ?? 8) as 5 | 6 | 7 | 8,
        stopBits: Number(this.config.stopBits ?? 1) as 1 | 1.5 | 2,
        parity: (this.config.parity as 'none' | 'even' | 'odd') ?? 'none',
        autoOpen: false
      })
      this.port = sp
      sp.on('data', (chunk: Buffer) => this.onSerialBytes(chunk))
      sp.on('error', (err: Error) => this.emitError(err.message))
      sp.on('close', () => {
        this.stopAnimation()
        this.emitStatus('closed', '串口已关闭')
      })
      await new Promise<void>((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())))
      // 串口从站没有「连接」概念，但状态机里 listening 最贴近「已就绪等请求」
      this.emitStatus('listening', `已打开 ${path}`)
      this.emitConn(
        `Modbus RTU 从站已就绪 ${path} @ ${baudRate}，从站地址 ${cfg.acceptAnyUnit ? '任意' : cfg.unitId}`,
        'success'
      )
      this.describeRegions()
      this.startAnimation()
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      this.emitError(msg)
      this.emitStatus('error', msg)
    }
  }

  /** 启动时把地址空间打印一遍：主站报「非法数据地址」时可以直接对照 */
  private describeRegions(): void {
    const active = this.cfg.regions.filter((r) => r.enabled)
    if (active.length === 0) {
      this.emitSystem('未定义任何数据区，所有读请求都会返回「非法数据地址」', 'warn')
      return
    }
    const text = active
      .map((r) => `${areaLabel(r.area)} ${r.start}–${r.start + r.count - 1}${r.readOnly ? '(只读)' : ''}`)
      .join('；')
    this.emitSystem('数据区：' + text)
  }

  // —— 切帧 ——

  private onTcpBytes(entry: ClientEntry, chunk: Buffer): void {
    entry.rx = entry.rx.length ? Buffer.concat([entry.rx, chunk]) : chunk
    if (this.cfg.transport === 'tcp') {
      while (entry.rx.length >= 6) {
        const len = entry.rx.readUInt16BE(4)
        if (len < 2 || len > 260) {
          // 长度域离谱说明对面不是 Modbus TCP（常见于误把 RTU over TCP 连过来）
          this.emitSystem(`${entry.peer.label} 的 MBAP 长度域异常（${len}），丢弃缓冲。若主站用的是 RTU over TCP，请把从站也改成该模式`, 'warn')
          entry.rx = Buffer.alloc(0)
          return
        }
        if (entry.rx.length < 6 + len) break
        const txId = entry.rx.readUInt16BE(0)
        const req = Buffer.from(entry.rx.subarray(6, 6 + len))
        entry.rx = entry.rx.subarray(6 + len)
        void this.serve(req, entry, txId)
      }
      return
    }
    // RTU over TCP：帧尾带 CRC，靠 CRC 校验找边界
    this.cutRtuFrom(entry)
  }

  /**
   * RTU over TCP 的切帧。
   *
   * 没有长度域，只能按「功能码推算长度」切。与主站侧的区别在于这里推算的是
   * **请求**长度（读请求恒 8 字节、写多寄存器看字节数域），而主站推的是响应长度。
   */
  private cutRtuFrom(entry: ClientEntry): void {
    for (;;) {
      const expect = expectedRequestLength(entry.rx)
      if (expect <= 0 || entry.rx.length < expect) return
      const frame = Buffer.from(entry.rx.subarray(0, expect))
      entry.rx = entry.rx.subarray(expect)
      if (!checkCrc(frame)) {
        this.emitSystem(`丢弃 CRC 错误的请求：${frame.toString('hex')}`, 'warn')
        continue
      }
      void this.serve(Buffer.from(frame.subarray(0, frame.length - 2)), entry, 0)
    }
  }

  private onSerialBytes(chunk: Buffer): void {
    this.rxBuf = this.rxBuf.length ? Buffer.concat([this.rxBuf, chunk]) : chunk
    for (;;) {
      const expect = expectedRequestLength(this.rxBuf)
      if (expect <= 0 || this.rxBuf.length < expect) break
      const frame = Buffer.from(this.rxBuf.subarray(0, expect))
      this.rxBuf = this.rxBuf.subarray(expect)
      this.handleSerialFrame(frame)
    }
    // 静默兜底：推算不出长度时（非标准功能码）等一段静默再当整帧处理
    if (this.rtuTimer) clearTimeout(this.rtuTimer)
    if (this.rxBuf.length > 0) {
      const baud = Number(this.config.baudRate ?? 9600)
      const charMs = (11 * 1000) / Math.max(1200, baud)
      const idle = Math.max(8, Math.ceil(charMs * 3.5))
      this.rtuTimer = setTimeout(() => {
        if (this.rxBuf.length === 0) return
        const frame = Buffer.from(this.rxBuf)
        this.rxBuf = Buffer.alloc(0)
        this.handleSerialFrame(frame)
      }, idle)
    }
  }

  private handleSerialFrame(frame: Buffer): void {
    if (!checkCrc(frame)) {
      this.emitSystem(`丢弃 CRC 错误的请求：${frame.toString('hex')}`, 'warn')
      return
    }
    void this.serve(Buffer.from(frame.subarray(0, frame.length - 2)), null, 0)
  }

  // —— 应答 ——

  /**
   * 处理一个请求并回应答。
   *
   * 丢包与延迟都在这里做，而不是在数据层：它们是链路特性而非协议语义，
   * 混进 store 会让那一层没法单测。
   */
  private async serve(req: Buffer, entry: ClientEntry | null, txId: number): Promise<void> {
    this.reqCount += 1
    const cfg = this.cfg
    const peer = entry ? { id: entry.peer.id, label: entry.peer.label } : undefined
    this.emitData('rx', req, 'hex', peer, {
      unitId: req.length > 0 ? req.readUInt8(0) : undefined,
      funcCode: req.length > 1 ? req.readUInt8(1) : undefined,
      addr: req.length >= 4 ? req.readUInt16BE(2) : undefined,
      quantity: req.length >= 6 ? req.readUInt16BE(4) : undefined
    })

    const drop = Math.min(1, Math.max(0, Number(cfg.dropRate ?? 0)))
    if (drop > 0 && Math.random() < drop) {
      this.emitSystem(`按丢包率 ${Math.round(drop * 100)}% 丢弃本次请求（主站应超时重试）`, 'warn')
      return
    }

    const result = this.store.handle(req)
    if (!result.pdu) {
      if (result.note) this.emitSystem(result.note, 'info')
      return
    }
    if (result.touched?.length) {
      for (const a of result.touched) this.dirty.add(a)
      this.schedulePush()
    }

    const delay = Math.max(0, Number(cfg.responseDelayMs ?? 0))
    if (delay > 0) await sleep(delay)

    const wire = cfg.transport === 'tcp' ? wrapMbap(txId, result.pdu) : appendCrc(result.pdu)
    if (entry) {
      if (entry.socket.destroyed) return
      entry.socket.write(wire)
    } else {
      this.port?.write(wire)
    }
    this.emitData('tx', wire, 'hex', peer, {
      unitId: result.pdu.readUInt8(0),
      funcCode: result.pdu.readUInt8(1),
      exceptionCode: result.exceptionCode,
      note: result.note
    })
    if (result.exceptionCode !== undefined) this.emitSystem(result.note, 'warn')
  }

  // —— 自动变化 ——

  /**
   * 单一节拍驱动所有区的动画。
   * 200ms 是折中：比它更密，界面刷新与 IPC 开销上来了却看不出差别；
   * 更疏则 500ms 周期的正弦波会明显卡顿。各区自己的周期在 store.tick 里判。
   */
  private startAnimation(): void {
    this.stopAnimation()
    const hasAnim = this.cfg.regions.some((r) => r.enabled && r.animate && r.animate !== 'none')
    if (!hasAnim) {
      // 没有动画也要推一次初值，否则界面上寄存器表格是空的
      this.pushSnapshot()
      return
    }
    this.animTimer = setInterval(() => {
      const touched = this.store.tick(Date.now())
      if (touched.length) {
        for (const a of touched) this.dirty.add(a)
        this.schedulePush()
      }
    }, 200)
    this.pushSnapshot()
  }

  private stopAnimation(): void {
    if (this.animTimer) clearInterval(this.animTimer)
    this.animTimer = null
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = null
    this.dirty.clear()
  }

  /** 合并推送：一次动画节拍可能改了多个区，攒 120ms 发一次就够界面用 */
  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.dirty.clear()
      this.pushSnapshot()
    }, 120)
  }

  private pushSnapshot(): void {
    this.emitRaw({ type: 'modbusSlaveValues', sessionId: this.id, regions: this.store.snapshot() })
  }

  // —— 对外接口 ——

  listPeers(): Peer[] {
    return [...this.clients.values()].map((c) => c.peer)
  }

  kickPeer(peerId: string): void {
    const entry = this.clients.get(peerId)
    if (!entry) return
    entry.socket.destroy()
    this.emitSystem(`已断开主站 ${entry.peer.label}`)
  }

  /** 界面改单个地址的值 */
  writeRegister(area: ModbusArea, addr: number, value: number): void {
    if (!this.store.writeFromUi(area, addr, value)) {
      this.emitError(`地址 ${addr} 不在已定义的${areaLabel(area)}区内`)
      return
    }
    this.dirty.add(area)
    this.schedulePush()
    this.emitSystem(`手动置值：${areaLabel(area)} ${addr} = ${value}`)
  }

  /** 数据区定义变更：重建地址空间并重排动画，不断链路 */
  updateRegions(regions: ModbusSlaveRegion[]): void {
    const cfg = this.cfg
    cfg.regions = regions
    this.config.modbusSlave = cfg
    this.store.update(cfg)
    const running = this.isSerial ? this.port?.isOpen : Boolean(this.server?.listening)
    if (running) {
      this.describeRegions()
      this.startAnimation()
    }
  }

  snapshotRegions(): ModbusSlaveRegionValues[] {
    return this.store.snapshot()
  }

  /**
   * 从站没有「主动发送」的概念，发送区在这里改成手动置值的快捷入口：
   * 输入 `holding 5 1234` 就把保持寄存器 5 置成 1234。
   * 比留一个点了没反应的发送按钮诚实。
   */
  async send(out: OutgoingFrame): Promise<void> {
    const parts = out.content.trim().split(/\s+/)
    if (parts.length < 3) {
      this.emitError('从站不主动发送。如需置值请输入「区 地址 值」，例如 holding 5 1234（区可填 coil / discrete / holding / input）')
      return
    }
    const areaMap: Record<string, ModbusArea> = {
      coil: 'coil',
      discrete: 'discrete',
      holding: 'holding',
      input: 'input',
      线圈: 'coil',
      离散输入: 'discrete',
      保持寄存器: 'holding',
      输入寄存器: 'input'
    }
    const area = areaMap[parts[0].toLowerCase()] ?? areaMap[parts[0]]
    if (!area) {
      this.emitError(`未知数据区「${parts[0]}」，可填 coil / discrete / holding / input`)
      return
    }
    const addr = Number(parts[1])
    const value = Number(parts[2])
    if (!Number.isFinite(addr) || !Number.isFinite(value)) {
      this.emitError('地址与值必须是数字')
      return
    }
    this.writeRegister(area, addr, value)
  }

  async stop(): Promise<void> {
    this.stopAnimation()
    if (this.rtuTimer) clearTimeout(this.rtuTimer)
    this.rtuTimer = null
    this.rxBuf = Buffer.alloc(0)
    for (const c of this.clients.values()) c.socket.destroy()
    this.clients.clear()
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()))
    }
    this.port = null
    this.emitStatus('closed', `已停止（共处理 ${this.reqCount} 个请求）`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 按功能码推算 RTU **请求**长度（含 CRC）。返回 0 = 还看不出来。
 *
 * 与主站侧的 expectedRtuLength 是镜像关系：读请求在请求侧是固定 8 字节
 * （地址+功能码+起始地址2+数量2+CRC2），而在响应侧才是变长。
 */
function expectedRequestLength(buf: Buffer): number {
  if (buf.length < 2) return 0
  const func = buf.readUInt8(1)
  // 读 1–4、写单个 5/6：固定 8 字节
  if ((func >= 1 && func <= 6) || func === 0) return 8
  // 写多个 15/16：第 7 字节是字节数域
  if (func === 15 || func === 16) {
    if (buf.length < 7) return 0
    return 9 + buf.readUInt8(6)
  }
  return 0
}
