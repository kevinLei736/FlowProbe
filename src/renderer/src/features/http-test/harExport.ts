import { buildHar, harToJson, type HarEntryInput } from '@shared/har'
import type { HttpHeaderKV, HttpTestRequest } from '@shared/protocol'
import { applyVars, type HistoryItem } from './useApiClient'

/**
 * 接口测试历史 → HAR。
 *
 * 为什么要单独一层而不是直接在面板里拼：面板已经很重，而这段映射有几个
 * 容易踩的点（变量替换、query 合并、认证头补齐），值得能单独看懂。
 */

function kvToRecord(list: HttpHeaderKV[] | undefined, vars: HttpHeaderKV[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const kv of list ?? []) {
    if (kv.enabled === false) continue
    const key = kv.key.trim()
    if (!key) continue
    out[key] = applyVars(kv.value, vars)
  }
  return out
}

/**
 * 把请求里的认证配置还原成真实发出去的头部。
 *
 * 为什么要做这件事：HAR 的价值在于「对方拖进 DevTools 就能重放」。认证信息
 * 只存在 auth 配置里而不落到 headers 上的话，导出的请求必然 401，看起来像
 * 接口坏了。这里把它补齐，与主进程 sendHttpTest 的行为保持一致。
 *
 * 注意这会把 token 写进文件，界面上对此有明确提示。
 */
function withAuthHeaders(
  req: HttpTestRequest,
  headers: Record<string, string>,
  vars: HttpHeaderKV[]
): Record<string, string> {
  const auth = req.auth
  if (!auth || auth.type === 'none') return headers
  const out = { ...headers }
  if (auth.type === 'basic') {
    const user = applyVars(auth.username ?? '', vars)
    const pass = applyVars(auth.password ?? '', vars)
    // btoa 对非 ASCII 会抛错，先转成 UTF-8 字节再编码
    try {
      const bytes = new TextEncoder().encode(user + ':' + pass)
      let bin = ''
      bytes.forEach((b) => { bin += String.fromCharCode(b) })
      out.Authorization = 'Basic ' + btoa(bin)
    } catch {
      // 编码失败时宁可不写，也不要塞一个错的凭据进去让人以为能重放
    }
  } else if (auth.type === 'bearer') {
    out.Authorization = 'Bearer ' + applyVars(auth.token ?? '', vars)
  } else if (auth.type === 'apikey' && auth.apiKeyName) {
    // apiKeyIn === 'query' 时它在 URL 上，不属于头部
    if (auth.apiKeyIn !== 'query') {
      out[auth.apiKeyName] = applyVars(auth.apiKeyValue ?? '', vars)
    }
  }
  return out
}

/**
 * 合成最终 URL：把 query 表里启用的行拼到 URL 上。
 * 用 URL 对象而不是字符串拼接，才能正确处理「URL 里已经带了 ?」的情况。
 */
function fullUrl(req: HttpTestRequest, vars: HttpHeaderKV[]): string {
  const base = applyVars(req.url, vars)
  const extra = (req.query ?? []).filter((kv) => kv.enabled !== false && kv.key.trim())
  const apiKeyInQuery =
    req.auth && req.auth.type === 'apikey' && req.auth.apiKeyIn === 'query' && req.auth.apiKeyName
  if (extra.length === 0 && !apiKeyInQuery) return base
  try {
    const u = new URL(base)
    for (const kv of extra) u.searchParams.append(kv.key.trim(), applyVars(kv.value, vars))
    if (apiKeyInQuery && req.auth) {
      u.searchParams.append(req.auth.apiKeyName as string, applyVars(req.auth.apiKeyValue ?? '', vars))
    }
    return u.toString()
  } catch {
    // URL 里还留着未解析的 {{var}} 时 new URL 会抛错。原样返回比丢掉整条记录好
    return base
  }
}

/**
 * 按 bodyType 推断 Content-Type。
 *
 * 必须和主进程 sendHttpTest 的兜底逻辑一致：真实发出去的请求带的是
 * application/json，而用户并没有手写这个头。HAR 里缺了它，DevTools 会把 JSON
 * 载荷当二进制看（mimeType 落成 application/octet-stream），Payload 页显示不成形。
 */
function defaultContentType(bodyType: HttpTestRequest['bodyType']): string | null {
  switch (bodyType) {
    case 'json':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    case 'text':
      return 'text/plain'
    case 'form':
      return 'application/x-www-form-urlencoded'
    default:
      return null
  }
}

/** 请求体文本。binary 是 base64，直接原样给出，HAR 消费方按 mimeType 处理 */
function bodyText(req: HttpTestRequest, vars: HttpHeaderKV[]): string | undefined {
  if (!req.body || req.bodyType === 'none') return undefined
  if (req.bodyType === 'binary') return req.body
  return applyVars(req.body, vars)
}

export function historyToHarInputs(items: HistoryItem[], vars: HttpHeaderKV[]): HarEntryInput[] {
  return items.map((h) => {
    const req = h.request
    const headers = withAuthHeaders(req, kvToRecord(req.headers, vars), vars)
    const body = bodyText(req, vars)
    if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      const ct = defaultContentType(req.bodyType)
      if (ct) headers['Content-Type'] = ct
    }
    const notes: string[] = ['来源：HTTP 接口测试历史']
    if (h.respTruncated) notes.push('响应体已截断（历史只保留前 8 KB）')
    if (h.respHeaders === undefined) notes.push('该条历史记录于旧版本，缺少响应头与响应体')
    return {
      startedAt: h.ts,
      timeMs: h.durationMs,
      method: h.method || req.method,
      url: h.url || fullUrl(req, vars),
      reqHeaders: headers,
      reqBody: body,
      status: h.status,
      statusText: h.statusText,
      respHeaders: h.respHeaders,
      respBody: h.respBody,
      respSize: h.respSize,
      comment: notes.join('；')
    }
  })
}

export function historyToHarJson(
  items: HistoryItem[],
  vars: HttpHeaderKV[],
  appVersion: string,
  envName?: string
): string {
  const inputs = historyToHarInputs(items, vars)
  const comment = envName ? '环境：' + envName : undefined
  return harToJson(buildHar(inputs, appVersion, comment))
}
