import { buildHar, harToJson, type HarEntryInput } from '@shared/har'
import type { HttpLogEntry } from '@shared/protocol'

/**
 * Mock 请求日志 → HAR。
 *
 * 典型用法：代理透传抓到线上真实流量后，导出 HAR 发给前端同事，
 * 对方拖进 Chrome 开发者工具就能看到每个请求的完整头部与响应体，
 * 不用来回问「你那边参数传的是什么」。
 */

/**
 * 把日志行拼成完整 URL。
 *
 * 为什么必须补 base：日志里只有 path，而 HAR 规范要求 request.url 是绝对地址。
 * 只给 /api/x 的话 DevTools 会拒绝整个文件（不是跳过这一条，是整份不认）。
 */
function fullUrl(base: string, log: HttpLogEntry): string {
  const path = log.path.startsWith('/') ? log.path : '/' + log.path
  return base.replace(/\/$/, '') + path + (log.query ? '?' + log.query : '')
}

export function mockLogsToHarInputs(logs: HttpLogEntry[], base: string): HarEntryInput[] {
  return logs.map((l) => {
    const notes: string[] = ['来源：HTTP Mock 请求日志']
    if (l.matchedRoute) notes.push('命中路由：' + l.matchedRoute)
    // 场景名要带上：同一个路由在不同场景下返回完全不同，缺了它这份 HAR 会让人对不上
    if (l.scenario) notes.push('场景：' + l.scenario)
    if (!l.matchedRoute) notes.push('未命中任何路由（代理透传或 404）')
    return {
      startedAt: l.ts,
      timeMs: l.durationMs,
      method: l.method,
      url: fullUrl(base, l),
      reqHeaders: l.reqHeaders,
      reqBody: l.reqBody,
      status: l.status,
      respHeaders: l.respHeaders,
      respBody: l.respBody,
      comment: notes.join('；')
    }
  })
}

export function mockLogsToHarJson(
  logs: HttpLogEntry[],
  base: string,
  appVersion: string,
  sessionName: string
): string {
  return harToJson(
    buildHar(mockLogsToHarInputs(logs, base), appVersion, 'Mock 会话：' + sessionName)
  )
}
