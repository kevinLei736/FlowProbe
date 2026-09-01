import type { Encoding, Terminator, FramingConfig } from '@shared/protocol'

/** 将用户输入按编码转为字节 */
export function encodeContent(content: string, encoding: Encoding, terminator: Terminator = ''): Buffer {
  let body: Buffer
  if (encoding === 'hex') {
    const clean = content.replace(/[^0-9a-fA-F]/g, '')
    const even = clean.length % 2 === 0 ? clean : clean.slice(0, -1)
    body = Buffer.from(even, 'hex')
  } else if (encoding === 'base64') {
    body = Buffer.from(content, 'base64')
  } else {
    body = Buffer.from(content, 'utf8')
  }
  const term =
    terminator === 'cr' ? '\r' : terminator === 'lf' ? '\n' : terminator === 'crlf' ? '\r\n' : ''
  return term ? Buffer.concat([body, Buffer.from(term, 'utf8')]) : body
}

/**
 * 分帧器：按配置把 TCP/串口字节流切分为逻辑帧，解决粘包/半包。
 * 每次 push 返回本次可交付的完整帧数组（可能为空）。
 */
export class FrameSplitter {
  private buf: Buffer = Buffer.alloc(0)
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private cfg: FramingConfig,
    private onIdleFlush?: (frame: Buffer) => void
  ) {}

  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    switch (this.cfg.mode) {
      case 'delimiter':
        return this.byDelimiter()
      case 'length':
        return this.byLength()
      case 'timeout':
        this.scheduleIdle()
        return []
      case 'none':
      default: {
        const out = this.buf
        this.buf = Buffer.alloc(0)
        return out.length ? [out] : []
      }
    }
  }

  private byDelimiter(): Buffer[] {
    const delimHex = this.cfg.delimiter && this.cfg.delimiter.length ? this.cfg.delimiter : '0a'
    const delim = Buffer.from(delimHex.replace(/[^0-9a-fA-F]/g, ''), 'hex')
    if (delim.length === 0) {
      const out = this.buf
      this.buf = Buffer.alloc(0)
      return out.length ? [out] : []
    }
    const frames: Buffer[] = []
    let idx: number
    while ((idx = this.buf.indexOf(delim)) !== -1) {
      const frame = this.buf.subarray(0, idx + delim.length)
      frames.push(Buffer.from(frame))
      this.buf = this.buf.subarray(idx + delim.length)
    }
    return frames
  }

  private byLength(): Buffer[] {
    const offset = this.cfg.lengthFieldOffset ?? 0
    const size = this.cfg.lengthFieldBytes ?? 2
    const adjust = this.cfg.lengthAdjust ?? 0
    const be = this.cfg.lengthBigEndian !== false
    const frames: Buffer[] = []
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.buf.length < offset + size) break
      const len = be
        ? this.buf.readUIntBE(offset, size)
        : this.buf.readUIntLE(offset, size)
      const total = offset + size + len + adjust
      if (total <= 0 || this.buf.length < total) break
      frames.push(Buffer.from(this.buf.subarray(0, total)))
      this.buf = this.buf.subarray(total)
    }
    return frames
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const ms = this.cfg.idleMs ?? 20
    this.idleTimer = setTimeout(() => {
      if (this.buf.length && this.onIdleFlush) {
        const out = this.buf
        this.buf = Buffer.alloc(0)
        this.onIdleFlush(out)
      }
    }, ms)
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.buf = Buffer.alloc(0)
  }
}
