import type { ProtoChecksum, ProtoField, ProtoTemplate } from '@shared/protocol'

/** 单个字段的解析结果 */
export interface ParsedField {
  name: string
  /** 该字段在报文中的字节偏移 */
  offset: number
  /** 实际消耗的字节数 */
  size: number
  /** 该字段的原始字节（HEX 串，便于核对） */
  raw: string
  /** 换算并映射后的显示值 */
  value: string
  /** 数值类型字段换算后的数字（枚举映射前），供曲线取用 */
  num?: number
  /** 该字段是否被标记绘制曲线 */
  chart?: boolean
  unit?: string
  note?: string
  /** 字节不够导致截断 */
  truncated?: boolean
}

export interface ParsedFrame {
  templateName: string
  fields: ParsedField[]
  /** 未被任何字段覆盖的尾部字节 */
  restHex?: string
  /** 校验结果；模板未配校验时为 undefined */
  checksum?: { kind: ProtoChecksum; expected: string; actual: string; ok: boolean }
  error?: string
}

const TYPE_SIZE: Record<string, number> = {
  uint8: 1, int8: 1, bits: 1,
  uint16: 2, int16: 2,
  uint32: 4, int32: 4, float32: 4,
  float64: 8
}

/** 字段占用的字节数；变长类型取 length，length 为 0/空表示吃掉剩余 */
export function fieldSize(f: ProtoField, remaining: number): number {
  const fixed = TYPE_SIZE[f.type]
  if (fixed !== undefined && f.type !== 'bits') return fixed
  const len = Math.max(0, Math.floor(f.length ?? 0))
  if (len > 0) return len
  return remaining
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = (hex ?? '').replace(/[^0-9a-fA-F]/g, '')
  const n = Math.floor(clean.length / 2)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

function readNumber(b: Uint8Array, type: string, big: boolean): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  switch (type) {
    case 'uint8': return dv.getUint8(0)
    case 'int8': return dv.getInt8(0)
    case 'uint16': return dv.getUint16(0, !big)
    case 'int16': return dv.getInt16(0, !big)
    case 'uint32': return dv.getUint32(0, !big)
    case 'int32': return dv.getInt32(0, !big)
    case 'float32': return dv.getFloat32(0, !big)
    case 'float64': return dv.getFloat64(0, !big)
    default: return 0
  }
}

/** BCD：每字节两位十进制，常见于仪表与工业协议的时间/编号字段 */
function readBcd(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += ((x >> 4) & 0x0f).toString() + (x & 0x0f).toString()
  return s
}

function parseEnum(map: string | undefined, key: string): string | null {
  if (!map) return null
  for (const pair of map.split(/[,;\n]/)) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    if (pair.slice(0, i).trim() === key) return pair.slice(i + 1).trim()
  }
  return null
}

export function sum8(b: Uint8Array): number {
  let s = 0
  for (const x of b) s = (s + x) & 0xff
  return s
}

export function xor8(b: Uint8Array): number {
  let s = 0
  for (const x of b) s ^= x
  return s
}

/** Modbus CRC16，工业设备里最常见的一种，低字节在前 */
export function crc16Modbus(b: Uint8Array): number {
  let crc = 0xffff
  for (const x of b) {
    crc ^= x
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
    }
  }
  return crc & 0xffff
}

function checksumBytes(kind: ProtoChecksum): number {
  if (kind === 'sum8' || kind === 'xor8') return 1
  if (kind === 'crc16-modbus') return 2
  return 0
}

/**
 * 按模板把裸字节解析成字段表。
 * 设计取舍：字节不足时不整体失败，而是标记该字段 truncated 并停止——
 * 调试现场经常遇到半包，能看到「前几个字段是对的」比一句"解析失败"有用得多。
 */
export function parseByTemplate(bytes: Uint8Array, tpl: ProtoTemplate): ParsedFrame {
  const out: ParsedFrame = { templateName: tpl.name, fields: [] }
  const ckKind = tpl.checksum ?? 'none'
  const ckLen = checksumBytes(ckKind)
  // 校验位不参与字段解析
  const bodyEnd = Math.max(0, bytes.length - ckLen)
  let pos = 0

  for (const f of tpl.fields) {
    const remaining = bodyEnd - pos
    if (remaining <= 0) {
      out.fields.push({ name: f.name, offset: pos, size: 0, raw: '', value: '(缺字节)', truncated: true })
      break
    }
    const size = Math.min(fieldSize(f, remaining), remaining)
    const slice = bytes.slice(pos, pos + size)
    const truncated = size < fieldSize(f, remaining)
    let value: string
    let numeric: number | undefined

    if (f.type === 'hex') {
      value = bytesToHex(slice)
    } else if (f.type === 'ascii') {
      value = new TextDecoder().decode(slice).replace(/\u0000+$/, '')
    } else if (f.type === 'bcd') {
      value = readBcd(slice)
    } else if (f.type === 'bits') {
      value = [...slice].map((x) => x.toString(2).padStart(8, '0')).join(' ')
    } else {
      const padded = new Uint8Array(TYPE_SIZE[f.type] ?? size)
      padded.set(slice.slice(0, padded.length))
      let num = readNumber(padded, f.type, f.bigEndian !== false)
      const scale = f.scale ?? 1
      const off = f.offset ?? 0
      if (scale !== 1 || off !== 0) num = num * scale + off
      numeric = num
      const rounded = Number.isInteger(num) ? String(num) : String(Number(num.toFixed(6)))
      value = parseEnum(f.enumMap, rounded) ?? rounded
    }

    out.fields.push({
      name: f.name,
      offset: pos,
      size,
      raw: bytesToHex(slice),
      value,
      num: numeric,
      chart: f.chart === true && numeric !== undefined ? true : undefined,
      unit: f.unit,
      note: f.note,
      truncated: truncated || undefined
    })
    pos += size
    if (truncated) break
  }

  if (pos < bodyEnd) out.restHex = bytesToHex(bytes.slice(pos, bodyEnd))

  if (ckLen > 0 && bytes.length >= ckLen) {
    const scope = bytes.slice(0, bodyEnd)
    const tail = bytes.slice(bodyEnd)
    let calc = 0
    if (ckKind === 'sum8') calc = sum8(scope)
    else if (ckKind === 'xor8') calc = xor8(scope)
    else if (ckKind === 'crc16-modbus') calc = crc16Modbus(scope)
    const expected =
      ckKind === 'crc16-modbus'
        ? bytesToHex(new Uint8Array([calc & 0xff, (calc >> 8) & 0xff]))
        : bytesToHex(new Uint8Array([calc]))
    const actual = bytesToHex(tail)
    out.checksum = { kind: ckKind, expected, actual, ok: expected === actual }
  }

  return out
}

/** 模板是否适用于该报文（前缀 + 方向） */
export function templateMatches(
  tpl: ProtoTemplate,
  bytes: Uint8Array,
  direction: 'tx' | 'rx' | 'system'
): boolean {
  const dir = tpl.direction ?? 'any'
  if (dir !== 'any' && dir !== direction) return false
  const prefix = hexToBytes(tpl.matchPrefixHex ?? '')
  if (prefix.length === 0) return true
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}

/** 从模板列表里挑第一个匹配的；前缀更长的更"specific"，优先命中 */
export function pickTemplate(
  templates: ProtoTemplate[],
  bytes: Uint8Array,
  direction: 'tx' | 'rx' | 'system'
): ProtoTemplate | null {
  const usable = templates.filter((t) => t.fields.length > 0 && templateMatches(t, bytes, direction))
  if (usable.length === 0) return null
  return [...usable].sort(
    (a, b) => hexToBytes(b.matchPrefixHex ?? '').length - hexToBytes(a.matchPrefixHex ?? '').length
  )[0]
}
