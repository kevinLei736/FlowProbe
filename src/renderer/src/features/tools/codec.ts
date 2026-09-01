// 通用编解码与校验工具（纯前端计算，供工具面板与片段使用）

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const even = clean.length % 2 === 0 ? clean : clean.slice(0, -1)
  const out = new Uint8Array(even.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.substr(i * 2, 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array, sep = ' '): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(sep)
}

export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function toBytes(input: string, mode: 'text' | 'hex'): Uint8Array {
  return mode === 'hex' ? hexToBytes(input) : textToBytes(input)
}

// —— 校验算法 ——
export function checksum8(bytes: Uint8Array): number {
  let sum = 0
  for (const b of bytes) sum = (sum + b) & 0xff
  return sum
}

export function lrc(bytes: Uint8Array): number {
  let sum = 0
  for (const b of bytes) sum = (sum + b) & 0xff
  return (0x100 - sum) & 0xff
}

export function xor8(bytes: Uint8Array): number {
  let x = 0
  for (const b of bytes) x ^= b
  return x & 0xff
}

export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001
      else crc >>= 1
    }
  }
  return crc & 0xffff
}

export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021
      else crc <<= 1
      crc &= 0xffff
    }
  }
  return crc & 0xffff
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ChecksumRow {
  name: string
  value: string
}

export function computeChecksums(input: string, mode: 'text' | 'hex'): ChecksumRow[] {
  const bytes = toBytes(input, mode)
  const hx = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, '0')
  return [
    { name: '字节数', value: String(bytes.length) },
    { name: '累加和 (SUM8)', value: hx(checksum8(bytes), 2) },
    { name: 'XOR8', value: hx(xor8(bytes), 2) },
    { name: 'LRC', value: hx(lrc(bytes), 2) },
    { name: 'CRC16/Modbus', value: hx(crc16Modbus(bytes), 4) },
    { name: 'CRC16/CCITT-F', value: hx(crc16CcittFalse(bytes), 4) },
    { name: 'CRC32', value: hx(crc32(bytes), 8) }
  ]
}

// —— 编解码转换 ——
export interface ConvertRows {
  bytes: number
  hex: string
  text: string
  base64: string
  decimal: string
}

export function convertAll(input: string, mode: 'text' | 'hex' | 'base64'): ConvertRows {
  let bytes: Uint8Array
  if (mode === 'hex') bytes = hexToBytes(input)
  else if (mode === 'base64') {
    try {
      const bin = atob(input.trim())
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    } catch {
      bytes = new Uint8Array()
    }
  } else bytes = textToBytes(input)

  let base64 = ''
  try {
    base64 = btoa(String.fromCharCode(...bytes))
  } catch {
    base64 = ''
  }
  return {
    bytes: bytes.length,
    hex: bytesToHex(bytes),
    text: new TextDecoder().decode(bytes),
    base64,
    decimal: [...bytes].join(' ')
  }
}

// —— 时间戳 ——
export function timestampInfo(input: string): { unixSec: string; unixMs: string; iso: string; local: string } {
  const trimmed = input.trim()
  let date: Date
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed)
    date = new Date(trimmed.length > 10 ? n : n * 1000)
  } else {
    date = new Date(trimmed)
  }
  if (isNaN(date.getTime())) return { unixSec: '-', unixMs: '-', iso: '无效', local: '无效' }
  return {
    unixSec: String(Math.floor(date.getTime() / 1000)),
    unixMs: String(date.getTime()),
    iso: date.toISOString(),
    local: date.toLocaleString('zh-CN')
  }
}
