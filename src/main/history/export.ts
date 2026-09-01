import type { HistoryFrameRow, HistoryHttpRow } from '@shared/protocol'
import { buildHar, harToJson, type HarEntryInput } from '@shared/har'

function csvEscape(v: string): string {
  return '"' + v.replace(/"/g, '""') + '"'
}

/**
 * 本地时间字符串。不用 toISOString：那是 UTC，导出的表格拿去对时间会差 8 小时，
 * 排查现场问题时非常容易看错。
 */
function localTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes()) +
    ':' +
    p(d.getSeconds()) +
    '.' +
    p(d.getMilliseconds(), 3)
  )
}

function hex(base64: string): string {
  if (!base64) return ''
  return [...Buffer.from(base64, 'base64')].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

/** 历史报文导出 CSV。同时给 TEXT 与 HEX 两列，表格里既能读也能核字节。 */
export function historyFramesToCsv(rows: HistoryFrameRow[]): string {
  const head = ['序号', '时间', '会话', '分组', '类型', '方向', '字节数', '对端', '连接日志', 'TEXT', 'HEX'].join(',')
  const body = rows.map((r, i) =>
    [
      String(i + 1),
      csvEscape(localTime(r.ts)),
      csvEscape(r.sessionName),
      csvEscape(r.sessionGroup),
      csvEscape(String(r.sessionKind)),
      r.direction,
      String(r.size),
      csvEscape(r.peerLabel),
      r.conn ? '是' : '',
      csvEscape(r.text),
      csvEscape(hex(r.rawBase64))
    ].join(',')
  )
  return [head, ...body].join('\r\n')
}

/** 历史 HTTP 请求导出 CSV */
export function historyHttpToCsv(rows: HistoryHttpRow[]): string {
  const head = ['序号', '时间', '会话', '方法', '路径', 'Query', '状态码', '耗时(ms)', '命中路由', '场景', '请求体', '响应体'].join(',')
  const body = rows.map((r, i) =>
    [
      String(i + 1),
      csvEscape(localTime(r.ts)),
      csvEscape(r.sessionName),
      r.method,
      csvEscape(r.path),
      csvEscape(r.query),
      String(r.status),
      String(r.durationMs),
      csvEscape(r.matchedRoute),
      csvEscape(r.scenario),
      csvEscape(r.reqBody),
      csvEscape(r.respBody)
    ].join(',')
  )
  return [head, ...body].join('\r\n')
}

/**
 * 历史 HTTP 请求导出 HAR 1.2。
 *
 * 历史库落盘时**没有存请求头与响应头**（表结构里只有 method/path/query/status/
 * duration/req_body/resp_body）。补表会让每条记录多存两份 JSON，而历史库是按
 * 十万行量级设计的，那部分体积多数时候不会被读到。
 *
 * 因此这里导出的是「不含头部的 HAR」：DevTools 依然能打开并显示方法、URL、
 * 状态码、耗时与正文，只是头部一栏为空。每条 entry 的 comment 里写明了这一点，
 * 拿到文件的人不会误以为请求真的没带头。需要完整头部时用 Mock 会话里的
 * 「导出 HAR」——那里的日志是内存态，头部齐全。
 */
export function historyHttpToHar(rows: HistoryHttpRow[], appVersion: string): string {
  const inputs: HarEntryInput[] = rows.map((r) => ({
    startedAt: r.ts,
    timeMs: r.durationMs,
    method: r.method,
    // 历史库不存 host，用占位 origin 拼成绝对地址：HAR 规范要求绝对 URL，
    // 给相对路径会导致整份文件被 DevTools 拒绝，而不只是跳过某一条
    url: 'http://localhost' + (r.path.startsWith('/') ? r.path : '/' + r.path) + (r.query ? '?' + r.query : ''),
    reqBody: r.reqBody,
    status: r.status,
    respBody: r.respBody,
    comment: [
      '来源：本地历史库（' + r.sessionName + '）',
      r.matchedRoute ? '命中路由：' + r.matchedRoute : '',
      r.scenario ? '场景：' + r.scenario : '',
      '历史库未保存请求头与响应头，故 headers 为空'
    ]
      .filter(Boolean)
      .join('；')
  }))
  return harToJson(buildHar(inputs, appVersion, '导出自报文历史库'))
}
