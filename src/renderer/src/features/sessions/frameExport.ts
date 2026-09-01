import type { Encoding, Frame } from '@shared/protocol'

/** 把 base64 原始字节按目标视图解码成可读字符串 */
export function decodeFrame(frame: Pick<Frame, 'rawBase64' | 'text'>, view: Encoding): string {
  if (!frame.rawBase64) return frame.text ?? ''
  const bytes = base64ToBytes(frame.rawBase64)
  if (view === 'hex') return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  if (view === 'base64') return frame.rawBase64
  return new TextDecoder().decode(bytes)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 报文时间戳格式化为 HH:mm:ss.SSS */
export function formatTs(ts: number): string {
  return (
    new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' +
    String(ts % 1000).padStart(3, '0')
  )
}

function csvEscape(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * 导出为 CSV。同时给出 TEXT 与 HEX 两列，表格里既能读内容也能核字节。
 * 字段内的引号按 CSV 规范翻倍转义，换行保留在引号内。
 */
export function framesToCsv(frames: Frame[]): string {
  const head = ['序号', '时间', '方向', '字节数', '对端', 'TEXT', 'HEX'].join(',')
  const body = frames.map((f, i) =>
    [
      String(i + 1),
      csvEscape(new Date(f.ts).toISOString()),
      f.direction,
      String(f.size ?? 0),
      csvEscape(f.peerLabel ?? ''),
      csvEscape(decodeFrame(f, 'utf8')),
      csvEscape(decodeFrame(f, 'hex'))
    ].join(',')
  )
  return [head, ...body].join('\r\n')
}

/** 导出为纯文本，保留时间轴的阅读顺序与当前显示格式 */
export function framesToText(frames: Frame[], view: Encoding): string {
  return frames
    .map((f) => {
      const dir = f.direction === 'tx' ? 'TX' : f.direction === 'rx' ? 'RX' : '--'
      const peer = f.peerLabel ? ' [' + f.peerLabel + ']' : ''
      return formatTs(f.ts) + '  ' + dir + '  ' + String(f.size ?? 0) + 'B' + peer + '  ' + decodeFrame(f, view)
    })
    .join('\r\n')
}
