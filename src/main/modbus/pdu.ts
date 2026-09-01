import type {
  ModbusConfig,
  ModbusException,
  ModbusFunc,
  ModbusPoint,
  ModbusPointType
} from '@shared/protocol'

/**
 * Modbus PDU 编解码。
 *
 * 为什么不用第三方库：Modbus 协议本体极简（PDU 最长 253 字节），
 * 但字序、字节序、判帧超时这三处恰恰是工控现场差异最大的地方，
 * 多数库把它们写死或藏在内部。自己实现能把这三个维度完全开放给用户配置，
 * 也便于复用项目已有的串口适配器与分帧模块。
 */

// —— CRC16 / Modbus ——

/** 预计算 CRC 表。逐位算在高频轮询下会成为热点。 */
const CRC_TABLE = (() => {
  const table = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
    table[i] = crc
  }
  return table
})()

export function crc16Modbus(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0xffff
  for (let i = start; i < end; i++) {
    crc = (crc >> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return crc
}

/** RTU 帧尾追加 CRC（低字节在前） */
export function appendCrc(pdu: Buffer): Buffer {
  const crc = crc16Modbus(pdu)
  const out = Buffer.alloc(pdu.length + 2)
  pdu.copy(out, 0)
  out.writeUInt16LE(crc, pdu.length)
  return out
}

export function checkCrc(frame: Buffer): boolean {
  if (frame.length < 4) return false
  const expect = crc16Modbus(frame, 0, frame.length - 2)
  return frame.readUInt16LE(frame.length - 2) === expect
}

// —— 异常码 ——

const EXCEPTIONS: Record<number, { name: string; message: string }> = {
  0x01: { name: 'ILLEGAL_FUNCTION', message: '非法功能码：从站不支持该功能码' },
  0x02: { name: 'ILLEGAL_DATA_ADDRESS', message: '非法数据地址：起始地址或数量超出从站地址范围' },
  0x03: { name: 'ILLEGAL_DATA_VALUE', message: '非法数据值：请求中的数量或写入值不在允许范围' },
  0x04: { name: 'SLAVE_DEVICE_FAILURE', message: '从站设备故障：执行请求时发生不可恢复的错误' },
  0x05: { name: 'ACKNOWLEDGE', message: '已确认：请求已收到但需要较长处理时间' },
  0x06: { name: 'SLAVE_DEVICE_BUSY', message: '从站设备忙：正在处理长耗时命令，请稍后重试' },
  0x07: { name: 'NEGATIVE_ACKNOWLEDGE', message: '否定确认：从站无法执行该请求' },
  0x08: { name: 'MEMORY_PARITY_ERROR', message: '存储奇偶性差错：从站检测到存储区校验错误' },
  0x0a: { name: 'GATEWAY_PATH_UNAVAILABLE', message: '网关路径不可用：网关未能分配内部通信路径' },
  0x0b: { name: 'GATEWAY_TARGET_NO_RESPONSE', message: '网关目标设备无响应：目标从站未应答' }
}

export function describeException(code: number): ModbusException {
  const hit = EXCEPTIONS[code]
  return {
    code,
    name: hit?.name ?? 'UNKNOWN',
    message: hit?.message ?? `未知异常码 0x${code.toString(16).padStart(2, '0')}`
  }
}

// —— 请求构造 ——

/** 各功能码的单次请求数量上限（协议约束） */
export const MAX_QUANTITY: Record<ModbusFunc, number> = {
  1: 2000,
  2: 2000,
  3: 125,
  4: 125,
  5: 1,
  6: 1,
  15: 1968,
  16: 123
}

/** 读请求 PDU：功能码 + 起始地址 + 数量 */
export function buildReadPdu(unitId: number, func: 1 | 2 | 3 | 4, addr: number, quantity: number): Buffer {
  const buf = Buffer.alloc(6)
  buf.writeUInt8(unitId & 0xff, 0)
  buf.writeUInt8(func, 1)
  buf.writeUInt16BE(addr & 0xffff, 2)
  buf.writeUInt16BE(quantity & 0xffff, 4)
  return buf
}

/** 写单个线圈（05）：值只能是 0x0000 或 0xFF00 */
export function buildWriteCoilPdu(unitId: number, addr: number, on: boolean): Buffer {
  const buf = Buffer.alloc(6)
  buf.writeUInt8(unitId & 0xff, 0)
  buf.writeUInt8(5, 1)
  buf.writeUInt16BE(addr & 0xffff, 2)
  buf.writeUInt16BE(on ? 0xff00 : 0x0000, 4)
  return buf
}

/** 写单个寄存器（06） */
export function buildWriteRegisterPdu(unitId: number, addr: number, value: number): Buffer {
  const buf = Buffer.alloc(6)
  buf.writeUInt8(unitId & 0xff, 0)
  buf.writeUInt8(6, 1)
  buf.writeUInt16BE(addr & 0xffff, 2)
  buf.writeUInt16BE(value & 0xffff, 4)
  return buf
}

/** 写多个寄存器（10 / 16） */
export function buildWriteRegistersPdu(unitId: number, addr: number, words: number[]): Buffer {
  const byteCount = words.length * 2
  const buf = Buffer.alloc(7 + byteCount)
  buf.writeUInt8(unitId & 0xff, 0)
  buf.writeUInt8(16, 1)
  buf.writeUInt16BE(addr & 0xffff, 2)
  buf.writeUInt16BE(words.length, 4)
  buf.writeUInt8(byteCount, 6)
  words.forEach((w, i) => buf.writeUInt16BE(w & 0xffff, 7 + i * 2))
  return buf
}

/** 写多个线圈（0F / 15） */
export function buildWriteCoilsPdu(unitId: number, addr: number, bits: boolean[]): Buffer {
  const byteCount = Math.ceil(bits.length / 8)
  const buf = Buffer.alloc(7 + byteCount)
  buf.writeUInt8(unitId & 0xff, 0)
  buf.writeUInt8(15, 1)
  buf.writeUInt16BE(addr & 0xffff, 2)
  buf.writeUInt16BE(bits.length, 4)
  buf.writeUInt8(byteCount, 6)
  bits.forEach((on, i) => {
    if (!on) return
    const byteIdx = 7 + Math.floor(i / 8)
    buf[byteIdx] |= 1 << i % 8
  })
  return buf
}

/** MBAP 头封装（Modbus TCP）：事务标识 + 协议标识 0 + 长度 */
export function wrapMbap(txId: number, pdu: Buffer): Buffer {
  const out = Buffer.alloc(6 + pdu.length)
  out.writeUInt16BE(txId & 0xffff, 0)
  out.writeUInt16BE(0, 2)
  out.writeUInt16BE(pdu.length, 4)
  pdu.copy(out, 6)
  return out
}

// —— 响应解析 ——

export interface ParsedResponse {
  unitId: number
  func: number
  /** 异常响应时有值 */
  exception?: ModbusException
  /** 读响应的数据区（不含字节计数） */
  data?: Buffer
  /** 写响应回显的地址与数量/值 */
  echoAddr?: number
  echoValue?: number
}

/**
 * 解析一个不含 MBAP / CRC 的 PDU（首字节为 unitId）。
 * 异常响应的功能码最高位置 1（0x83 = 03 的异常）。
 */
export function parsePdu(pdu: Buffer): ParsedResponse | string {
  if (pdu.length < 2) return '响应过短'
  const unitId = pdu.readUInt8(0)
  const rawFunc = pdu.readUInt8(1)
  if (rawFunc & 0x80) {
    if (pdu.length < 3) return '异常响应缺少异常码'
    return { unitId, func: rawFunc & 0x7f, exception: describeException(pdu.readUInt8(2)) }
  }
  if (rawFunc >= 1 && rawFunc <= 4) {
    if (pdu.length < 3) return '读响应缺少字节计数'
    const count = pdu.readUInt8(2)
    if (pdu.length < 3 + count) return `读响应数据不足（声明 ${count} 字节，实到 ${pdu.length - 3}）`
    return { unitId, func: rawFunc, data: pdu.subarray(3, 3 + count) }
  }
  if (rawFunc === 5 || rawFunc === 6 || rawFunc === 15 || rawFunc === 16) {
    if (pdu.length < 6) return '写响应过短'
    return {
      unitId,
      func: rawFunc,
      echoAddr: pdu.readUInt16BE(2),
      echoValue: pdu.readUInt16BE(4)
    }
  }
  return `不支持的功能码 0x${rawFunc.toString(16)}`
}

// —— 数值解码（字序 / 字节序） ——

/** 每种类型占用的寄存器（16 位字）数 */
export function wordsOf(type: ModbusPointType, quantity: number): number {
  switch (type) {
    case 'uint16':
    case 'int16':
      return 1
    case 'uint32':
    case 'int32':
    case 'float32':
      return 2
    case 'float64':
      return 4
    case 'string':
      return Math.max(1, quantity)
    case 'bits':
      return Math.max(1, quantity)
    default:
      return 1
  }
}

/**
 * 按字序与字节序重排多字数据。
 *
 * 同一个 float32 在不同设备上有 ABCD / CDAB / BADC / DCBA 四种排法。
 * 这里用两个独立开关表达：byteOrder 管字内两个字节，wordOrder 管字之间的顺序。
 * 组合起来正好覆盖四种，比给一个四选一的枚举更好解释。
 */
export function reorder(raw: Buffer, wordOrder: 'be' | 'le', byteOrder: 'be' | 'le'): Buffer {
  const out = Buffer.from(raw)
  if (byteOrder === 'le') {
    for (let i = 0; i + 1 < out.length; i += 2) {
      const t = out[i]
      out[i] = out[i + 1]
      out[i + 1] = t
    }
  }
  if (wordOrder === 'le') {
    const words: Buffer[] = []
    for (let i = 0; i + 1 < out.length; i += 2) words.push(out.subarray(i, i + 2))
    words.reverse()
    return Buffer.concat(words)
  }
  return out
}

export interface DecodeResult {
  value: number | number[] | string | null
  rawHex: string
  error?: string
}

/** 把寄存器数据区解码为工程值 */
export function decodeValue(point: ModbusPoint, data: Buffer, cfg: ModbusConfig): DecodeResult {
  const rawHex = data.toString('hex')
  try {
    // 线圈/离散输入：按位取，低位在前
    if (point.func === 1 || point.func === 2 || point.type === 'bits') {
      const bits: number[] = []
      const want = Math.max(1, point.quantity)
      for (let i = 0; i < want; i++) {
        const byte = data[Math.floor(i / 8)]
        if (byte === undefined) break
        bits.push((byte >> i % 8) & 1)
      }
      return { value: bits.length === 1 ? bits[0] : bits, rawHex }
    }
    if (point.type === 'string') {
      // 寄存器按大端拼字符串，去掉尾部 NUL 与空白
      const text = data.toString('latin1').replace(/\u0000+$/g, '').trim()
      return { value: text, rawHex }
    }
    const need = wordsOf(point.type, point.quantity) * 2
    if (data.length < need) {
      return { value: null, rawHex, error: `数据不足：需要 ${need} 字节，实到 ${data.length}` }
    }
    const buf = reorder(data.subarray(0, need), cfg.wordOrder ?? 'be', cfg.byteOrder ?? 'be')
    let n: number
    switch (point.type) {
      case 'uint16':
        n = buf.readUInt16BE(0)
        break
      case 'int16':
        n = buf.readInt16BE(0)
        break
      case 'uint32':
        n = buf.readUInt32BE(0)
        break
      case 'int32':
        n = buf.readInt32BE(0)
        break
      case 'float32':
        n = buf.readFloatBE(0)
        break
      case 'float64':
        n = buf.readDoubleBE(0)
        break
      default:
        n = buf.readUInt16BE(0)
    }
    const scale = point.scale === undefined || point.scale === 0 ? 1 : point.scale
    const offset = point.offset ?? 0
    const engineering = n * scale + offset
    // 浮点换算后消掉二进制误差尾巴，界面上不出现 23.400000000000002
    const value = Number.isInteger(engineering) ? engineering : Number(engineering.toFixed(6))
    return { value, rawHex }
  } catch (e) {
    return { value: null, rawHex, error: String((e as Error)?.message ?? e) }
  }
}

/** 把工程值编码回寄存器字数组（写入用） */
export function encodeValue(point: ModbusPoint, input: number, cfg: ModbusConfig): number[] | string {
  const scale = point.scale === undefined || point.scale === 0 ? 1 : point.scale
  const offset = point.offset ?? 0
  const raw = (input - offset) / scale
  const words = wordsOf(point.type, point.quantity)
  const buf = Buffer.alloc(words * 2)
  try {
    switch (point.type) {
      case 'uint16':
        buf.writeUInt16BE(Math.round(raw) & 0xffff, 0)
        break
      case 'int16':
        buf.writeInt16BE(clamp(Math.round(raw), -32768, 32767), 0)
        break
      case 'uint32':
        buf.writeUInt32BE(Math.round(raw) >>> 0, 0)
        break
      case 'int32':
        buf.writeInt32BE(clamp(Math.round(raw), -2147483648, 2147483647), 0)
        break
      case 'float32':
        buf.writeFloatBE(raw, 0)
        break
      case 'float64':
        buf.writeDoubleBE(raw, 0)
        break
      default:
        return '该类型不支持写入'
    }
  } catch (e) {
    return String((e as Error)?.message ?? e)
  }
  // 写入时做与读取相反的重排，保证「读出 23.4 写回 23.4」是幂等的
  const ordered = reorder(buf, cfg.wordOrder ?? 'be', cfg.byteOrder ?? 'be')
  const out: number[] = []
  for (let i = 0; i + 1 < ordered.length; i += 2) out.push(ordered.readUInt16BE(i))
  return out
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n
}

// —— 批量读计划 ——

export interface ReadPlan {
  func: 1 | 2 | 3 | 4
  startAddr: number
  quantity: number
  /** 该请求覆盖的点位，含各自在数据区中的字偏移 */
  items: Array<{ point: ModbusPoint; wordOffset: number }>
}

/**
 * 把点位合并成批量读请求。
 *
 * 一张 40 个点位的表如果逐点读就是 40 次往返，在 9600 波特的串口上要好几秒。
 * 地址相邻的点位合并成一次读之后通常只剩 3-5 次请求。
 * mergeGap 控制「相隔多少个寄存器以内值得一起读」——读回来的空洞数据被丢弃，
 * 所以间隔太大反而浪费带宽。
 */
export function planReads(points: ModbusPoint[], cfg: ModbusConfig): ReadPlan[] {
  const gap = Math.max(0, cfg.mergeGap ?? 8)
  const active = points.filter((p) => p.enabled)
  const byFunc = new Map<1 | 2 | 3 | 4, ModbusPoint[]>()
  for (const p of active) {
    const list = byFunc.get(p.func)
    if (list) list.push(p)
    else byFunc.set(p.func, [p])
  }
  const plans: ReadPlan[] = []
  for (const [func, list] of byFunc) {
    const sorted = [...list].sort((a, b) => a.addr - b.addr)
    const limit = MAX_QUANTITY[func]
    let cur: ReadPlan | null = null
    for (const p of sorted) {
      const span = func === 1 || func === 2 ? Math.max(1, p.quantity) : wordsOf(p.type, p.quantity)
      const end = p.addr + span
      if (
        cur &&
        p.addr - (cur.startAddr + cur.quantity) <= gap &&
        end - cur.startAddr <= limit
      ) {
        cur.quantity = Math.max(cur.quantity, end - cur.startAddr)
        cur.items.push({ point: p, wordOffset: p.addr - cur.startAddr })
      } else {
        cur = {
          func,
          startAddr: p.addr,
          quantity: span,
          items: [{ point: p, wordOffset: 0 }]
        }
        plans.push(cur)
      }
    }
  }
  return plans
}

/** 从批量读回的数据区里切出某个点位对应的片段 */
export function sliceForPoint(
  plan: ReadPlan,
  item: { point: ModbusPoint; wordOffset: number },
  data: Buffer
): Buffer {
  if (plan.func === 1 || plan.func === 2) {
    // 位数据按位偏移取，交给 decodeValue 处理位序；这里对齐到字节
    const byteOffset = Math.floor(item.wordOffset / 8)
    return data.subarray(byteOffset)
  }
  const start = item.wordOffset * 2
  const len = wordsOf(item.point.type, item.point.quantity) * 2
  return data.subarray(start, start + len)
}

export function defaultModbusConfig(transport: 'tcp' | 'rtu' = 'tcp'): ModbusConfig {
  return {
    transport,
    host: '127.0.0.1',
    port: 502,
    unitId: 1,
    timeoutMs: 1000,
    retries: 1,
    gapMs: 20,
    wordOrder: 'be',
    byteOrder: 'be',
    mergeGap: 8,
    points: []
  }
}
