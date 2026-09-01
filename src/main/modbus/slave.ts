import type {
  ModbusArea,
  ModbusSlaveConfig,
  ModbusSlaveRegion,
  ModbusSlaveRegionValues
} from '@shared/protocol'
import { describeException } from './pdu'

/**
 * Modbus 从站数据模型与请求处理。
 *
 * 为什么单独一层而不写进适配器：这一层是纯函数式的「请求进、响应出」，
 * 不碰 socket 也不碰串口。这样 TCP 从站、RTU over TCP 从站、串口 RTU 从站
 * 三种链路共用同一份语义实现，且能脱离硬件直接跑单测。
 */

/** 四个数据区的地址空间。位区存 0/1，寄存器区存 0..65535。 */
interface Store {
  coil: Map<number, number>
  discrete: Map<number, number>
  holding: Map<number, number>
  input: Map<number, number>
}

/** 功能码 -> 它操作哪个区。写死成表比散在 switch 里好核对。 */
const FUNC_AREA: Record<number, { area: ModbusArea; write: boolean; bit: boolean }> = {
  1: { area: 'coil', write: false, bit: true },
  2: { area: 'discrete', write: false, bit: true },
  3: { area: 'holding', write: false, bit: false },
  4: { area: 'input', write: false, bit: false },
  5: { area: 'coil', write: true, bit: true },
  6: { area: 'holding', write: true, bit: false },
  15: { area: 'coil', write: true, bit: true },
  16: { area: 'holding', write: true, bit: false }
}

/** 单次请求的数量上限（协议约束，超了要回 0x03 而不是照做） */
const READ_LIMIT: Record<number, number> = { 1: 2000, 2: 2000, 3: 125, 4: 125 }

export interface SlaveResult {
  /** 要回给主站的 PDU（含从站地址与功能码，不含 CRC/MBAP）。null = 不应答 */
  pdu: Buffer | null
  /** 给日志用的一句话说明 */
  note: string
  /** 有值表示这是异常响应 */
  exceptionCode?: number
  /** 本次请求改动了哪些区，供界面局部刷新 */
  touched?: ModbusArea[]
}

export class ModbusSlaveStore {
  private store: Store = {
    coil: new Map(),
    discrete: new Map(),
    holding: new Map(),
    input: new Map()
  }
  private cfg: ModbusSlaveConfig
  /** ramp/sine 需要自己的相位，按区记 */
  private phase = new Map<string, number>()

  constructor(cfg: ModbusSlaveConfig) {
    this.cfg = cfg
    this.rebuild()
  }

  update(cfg: ModbusSlaveConfig): void {
    this.cfg = cfg
    this.rebuild()
  }

  get config(): ModbusSlaveConfig {
    return this.cfg
  }

  /**
   * 按区定义重建地址空间。
   *
   * 保留已有地址的当前值：改一个区的名字或动画参数不该把主站已经写进去的数据清零，
   * 那会让「写下去再读回来」的验证流程莫名失败。
   */
  private rebuild(): void {
    const next: Store = { coil: new Map(), discrete: new Map(), holding: new Map(), input: new Map() }
    for (const r of this.cfg.regions) {
      if (!r.enabled) continue
      const map = next[r.area]
      const old = this.store[r.area]
      const max = r.area === 'coil' || r.area === 'discrete' ? 1 : 0xffff
      const init = clamp(Math.round(Number(r.initial ?? 0)), 0, max)
      for (let i = 0; i < Math.max(0, r.count); i++) {
        const addr = r.start + i
        map.set(addr, old.has(addr) ? old.get(addr)! : init)
      }
    }
    this.store = next
  }

  /** 界面用：各区当前值快照 */
  snapshot(): ModbusSlaveRegionValues[] {
    const ts = Date.now()
    return this.cfg.regions
      .filter((r) => r.enabled)
      .map((r) => ({
        regionId: r.id,
        ts,
        values: Array.from({ length: Math.max(0, r.count) }, (_, i) => this.store[r.area].get(r.start + i) ?? 0)
      }))
  }

  /** 界面直接改值（模拟现场量变化），返回是否落到了已定义地址 */
  writeFromUi(area: ModbusArea, addr: number, value: number): boolean {
    const map = this.store[area]
    if (!map.has(addr)) return false
    const max = area === 'coil' || area === 'discrete' ? 1 : 0xffff
    map.set(addr, clamp(Math.round(value), 0, max))
    return true
  }

  /**
   * 推进一次自动变化。
   *
   * 由适配器按固定节拍调用（而不是每个区各起一个定时器）：区可能有几十个，
   * 几十个定时器不仅浪费，还会让界面收到几十条互相错开的刷新事件而闪烁。
   */
  tick(now: number): ModbusArea[] {
    const touched = new Set<ModbusArea>()
    for (const r of this.cfg.regions) {
      if (!r.enabled) continue
      const mode = r.animate ?? 'none'
      if (mode === 'none') continue
      const periodMs = Math.max(100, Number(r.animateMs ?? 1000))
      const last = this.phase.get(r.id + ':t') ?? 0
      if (now - last < periodMs) continue
      this.phase.set(r.id + ':t', now)
      this.animateRegion(r, now)
      touched.add(r.area)
    }
    return [...touched]
  }

  private animateRegion(r: ModbusSlaveRegion, now: number): void {
    const map = this.store[r.area]
    const bit = r.area === 'coil' || r.area === 'discrete'
    const lo = bit ? 0 : Math.round(Number(r.animateMin ?? 0))
    const hi = bit ? 1 : Math.round(Number(r.animateMax ?? 1000))
    const span = Math.max(1, hi - lo)
    const mode = r.animate ?? 'none'
    const step = Math.max(1, Math.round(Number(r.animateStep ?? 1)))
    for (let i = 0; i < Math.max(0, r.count); i++) {
      const addr = r.start + i
      if (!map.has(addr)) continue
      const cur = map.get(addr) ?? 0
      let next = cur
      if (mode === 'toggle') next = cur ? 0 : 1
      else if (mode === 'random') next = lo + Math.floor(Math.random() * (span + 1))
      else if (mode === 'ramp') {
        next = cur + step
        // 到顶折返而不是清零：清零会在曲线上留一条竖直线，看起来像丢数
        if (next > hi) next = lo
      } else if (mode === 'sine') {
        // 每个地址错开相位，一整片寄存器同步起落不像真实现场
        const t = (now / periodOf(r)) * Math.PI * 2 + i * 0.4
        next = Math.round(lo + ((Math.sin(t) + 1) / 2) * span)
      }
      map.set(addr, clamp(next, bit ? 0 : 0, bit ? 1 : 0xffff))
    }
  }

  /**
   * 处理一个请求 PDU（首字节为从站地址）。
   *
   * 返回的 SlaveResult.pdu 为 null 表示「不是给我的，不应答」——
   * 这是 Modbus 的正确行为：从站地址不匹配时必须保持静默，
   * 回一个异常码反而会污染总线上其他从站的应答。
   */
  handle(req: Buffer): SlaveResult {
    if (req.length < 2) return { pdu: null, note: '请求过短，丢弃' }
    const unitId = req.readUInt8(0)
    const func = req.readUInt8(1)
    const mine =
      this.cfg.acceptAnyUnit === true ||
      unitId === (this.cfg.unitId & 0xff) ||
      // 地址 0 是广播：从站要执行但不应答
      unitId === 0
    if (!mine) {
      return { pdu: null, note: `从站地址 ${unitId} 非本机（本机 ${this.cfg.unitId}），静默丢弃` }
    }
    const spec = FUNC_AREA[func]
    if (!spec) return { pdu: this.exception(unitId, func, 0x01), note: `不支持的功能码 ${func}`, exceptionCode: 0x01 }

    // 强制异常注入：放在功能码校验之后，这样「不支持的功能码」仍按真实语义回 0x01
    const inj = this.cfg.exception
    if (inj?.enabled && (!inj.funcs?.length || inj.funcs.includes(func))) {
      const code = clamp(Math.round(Number(inj.code ?? 4)), 1, 0xff)
      return {
        pdu: this.exception(unitId, func, code),
        note: `注入异常 ${describeException(code).message}`,
        exceptionCode: code
      }
    }

    try {
      if (func >= 1 && func <= 4) return this.doRead(unitId, func as 1 | 2 | 3 | 4, req)
      if (func === 5) return this.doWriteCoil(unitId, req)
      if (func === 6) return this.doWriteRegister(unitId, req)
      if (func === 15) return this.doWriteCoils(unitId, req)
      if (func === 16) return this.doWriteRegisters(unitId, req)
    } catch {
      // 请求字节数不足时 Buffer 读取会抛，这在协议上属于 0x03 非法数据值
      return { pdu: this.exception(unitId, func, 0x03), note: '请求格式不合法', exceptionCode: 0x03 }
    }
    return { pdu: this.exception(unitId, func, 0x01), note: `功能码 ${func} 未实现`, exceptionCode: 0x01 }
  }

  // —— 读 ——

  private doRead(unitId: number, func: 1 | 2 | 3 | 4, req: Buffer): SlaveResult {
    const addr = req.readUInt16BE(2)
    const quantity = req.readUInt16BE(4)
    const spec = FUNC_AREA[func]
    if (quantity < 1 || quantity > (READ_LIMIT[func] ?? 125)) {
      return { pdu: this.exception(unitId, func, 0x03), note: `数量 ${quantity} 超出协议上限`, exceptionCode: 0x03 }
    }
    const map = this.store[spec.area]
    for (let i = 0; i < quantity; i++) {
      if (!map.has(addr + i)) {
        return {
          pdu: this.exception(unitId, func, 0x02),
          note: `地址 ${addr + i} 未定义（${areaLabel(spec.area)}）`,
          exceptionCode: 0x02
        }
      }
    }
    let data: Buffer
    if (spec.bit) {
      const bytes = Math.ceil(quantity / 8)
      data = Buffer.alloc(bytes)
      for (let i = 0; i < quantity; i++) {
        if (map.get(addr + i)) data[Math.floor(i / 8)] |= 1 << i % 8
      }
    } else {
      data = Buffer.alloc(quantity * 2)
      for (let i = 0; i < quantity; i++) data.writeUInt16BE((map.get(addr + i) ?? 0) & 0xffff, i * 2)
    }
    const pdu = Buffer.alloc(3 + data.length)
    pdu.writeUInt8(unitId, 0)
    pdu.writeUInt8(func, 1)
    pdu.writeUInt8(data.length, 2)
    data.copy(pdu, 3)
    return { pdu, note: `读 ${areaLabel(spec.area)} ${addr}×${quantity}` }
  }

  // —— 写 ——

  /** 写请求的公共前置检查：地址是否存在、区是否只读 */
  private guardWrite(unitId: number, func: number, area: ModbusArea, addr: number, count: number): SlaveResult | null {
    const map = this.store[area]
    for (let i = 0; i < count; i++) {
      if (!map.has(addr + i)) {
        return {
          pdu: this.exception(unitId, func, 0x02),
          note: `写入地址 ${addr + i} 未定义`,
          exceptionCode: 0x02
        }
      }
    }
    const region = this.cfg.regions.find(
      (r) => r.enabled && r.area === area && addr >= r.start && addr + count - 1 < r.start + r.count
    )
    if (region?.readOnly) {
      return {
        pdu: this.exception(unitId, func, 0x02),
        note: `区「${region.name}」为只读，拒绝写入`,
        exceptionCode: 0x02
      }
    }
    return null
  }

  private doWriteCoil(unitId: number, req: Buffer): SlaveResult {
    const addr = req.readUInt16BE(2)
    const raw = req.readUInt16BE(4)
    if (raw !== 0x0000 && raw !== 0xff00) {
      return { pdu: this.exception(unitId, 5, 0x03), note: `写线圈值必须为 0x0000 或 0xFF00，实到 0x${hex4(raw)}`, exceptionCode: 0x03 }
    }
    const bad = this.guardWrite(unitId, 5, 'coil', addr, 1)
    if (bad) return bad
    this.store.coil.set(addr, raw === 0xff00 ? 1 : 0)
    return { pdu: Buffer.from(req.subarray(0, 6)), note: `写线圈 ${addr} = ${raw === 0xff00 ? 1 : 0}`, touched: ['coil'] }
  }

  private doWriteRegister(unitId: number, req: Buffer): SlaveResult {
    const addr = req.readUInt16BE(2)
    const value = req.readUInt16BE(4)
    const bad = this.guardWrite(unitId, 6, 'holding', addr, 1)
    if (bad) return bad
    this.store.holding.set(addr, value)
    return { pdu: Buffer.from(req.subarray(0, 6)), note: `写寄存器 ${addr} = ${value}`, touched: ['holding'] }
  }

  private doWriteCoils(unitId: number, req: Buffer): SlaveResult {
    const addr = req.readUInt16BE(2)
    const quantity = req.readUInt16BE(4)
    const byteCount = req.readUInt8(6)
    if (quantity < 1 || quantity > 1968 || byteCount !== Math.ceil(quantity / 8) || req.length < 7 + byteCount) {
      return { pdu: this.exception(unitId, 15, 0x03), note: '数量与字节数不一致', exceptionCode: 0x03 }
    }
    const bad = this.guardWrite(unitId, 15, 'coil', addr, quantity)
    if (bad) return bad
    for (let i = 0; i < quantity; i++) {
      const byte = req.readUInt8(7 + Math.floor(i / 8))
      this.store.coil.set(addr + i, (byte >> i % 8) & 1)
    }
    return { pdu: Buffer.from(req.subarray(0, 6)), note: `写多线圈 ${addr}×${quantity}`, touched: ['coil'] }
  }

  private doWriteRegisters(unitId: number, req: Buffer): SlaveResult {
    const addr = req.readUInt16BE(2)
    const quantity = req.readUInt16BE(4)
    const byteCount = req.readUInt8(6)
    if (quantity < 1 || quantity > 123 || byteCount !== quantity * 2 || req.length < 7 + byteCount) {
      return { pdu: this.exception(unitId, 16, 0x03), note: '数量与字节数不一致', exceptionCode: 0x03 }
    }
    const bad = this.guardWrite(unitId, 16, 'holding', addr, quantity)
    if (bad) return bad
    for (let i = 0; i < quantity; i++) this.store.holding.set(addr + i, req.readUInt16BE(7 + i * 2))
    return { pdu: Buffer.from(req.subarray(0, 6)), note: `写多寄存器 ${addr}×${quantity}`, touched: ['holding'] }
  }

  /** 异常响应：功能码最高位置 1 + 异常码 */
  private exception(unitId: number, func: number, code: number): Buffer {
    const pdu = Buffer.alloc(3)
    pdu.writeUInt8(unitId, 0)
    pdu.writeUInt8((func | 0x80) & 0xff, 1)
    pdu.writeUInt8(code & 0xff, 2)
    return pdu
  }
}

function periodOf(r: ModbusSlaveRegion): number {
  return Math.max(100, Number(r.animateMs ?? 1000)) * 8
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return n < min ? min : n > max ? max : n
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0').toUpperCase()
}

export function areaLabel(area: ModbusArea): string {
  switch (area) {
    case 'coil':
      return '线圈'
    case 'discrete':
      return '离散输入'
    case 'holding':
      return '保持寄存器'
    case 'input':
      return '输入寄存器'
  }
}

/** 从站默认配置：给一套能直接跑通的示例数据区 */
export function defaultSlaveConfig(transport: ModbusSlaveConfig['transport'] = 'tcp'): ModbusSlaveConfig {
  return {
    transport,
    host: '0.0.0.0',
    port: 502,
    unitId: 1,
    acceptAnyUnit: false,
    responseDelayMs: 0,
    dropRate: 0,
    exception: { enabled: false, code: 4, funcs: [] },
    maxClients: 8,
    regions: [
      {
        id: 'rg-holding',
        name: '保持寄存器 0-19',
        area: 'holding',
        start: 0,
        count: 20,
        initial: 0,
        animate: 'ramp',
        animateMs: 1000,
        animateMin: 0,
        animateMax: 1000,
        animateStep: 7,
        enabled: true,
        note: '默认递增，用来验证主站轮询与曲线'
      },
      {
        id: 'rg-input',
        name: '输入寄存器 0-9',
        area: 'input',
        start: 0,
        count: 10,
        initial: 0,
        readOnly: true,
        animate: 'sine',
        animateMs: 500,
        animateMin: 200,
        animateMax: 800,
        enabled: true,
        note: '正弦波，模拟温度等模拟量'
      },
      {
        id: 'rg-coil',
        name: '线圈 0-15',
        area: 'coil',
        start: 0,
        count: 16,
        initial: 0,
        animate: 'none',
        enabled: true,
        note: '可被主站写入，用来验证写回读'
      },
      {
        id: 'rg-discrete',
        name: '离散输入 0-15',
        area: 'discrete',
        start: 0,
        count: 16,
        initial: 0,
        readOnly: true,
        animate: 'toggle',
        animateMs: 2000,
        enabled: true,
        note: '交替翻转，模拟开关量'
      }
    ]
  }
}
