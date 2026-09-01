import type {
  HttpBodyType,
  HttpHeaderKV,
  HttpLogEntry,
  HttpMethod,
  HttpMockRoute
} from '@shared/protocol'

/**
 * 把 Mock 会话捕获到的真实请求日志，反推成可复用的 Mock 路由。
 *
 * 为什么需要它：手写 Mock 路由是这个工具里最枯燥的一段活 —— 明明真实后端就在那儿跑着，
 * 却要人肉把每个接口的路径、状态码、响应体抄一遍。开着代理透传把真实流量放过去，
 * 顺手就能把响应留档；这里负责把「一堆请求日志」整理成「一批干净的路由」。
 */

/** 一条待生成的路由草稿。UI 会把它列出来让用户确认后再落地。 */
export interface RouteDraft {
  /** 去重键：方法 + 推断后的路径模式 */
  key: string
  method: HttpMethod
  /** 推断出的路径模式，如 /api/users/:userId */
  pattern: string
  /** 原始示例路径（给用户核对推断对不对） */
  samplePath: string
  /** 这批日志里命中该模式的请求数 */
  count: number
  status: number
  bodyType: HttpBodyType
  body: string
  respHeaders: HttpHeaderKV[]
  /** 推断出的参数名 */
  params: string[]
  /**
   * 同一模式下出现了不同的响应体。
   *
   * 这不是错误，而是提醒：列表接口按分页参数返回不同内容很正常，
   * 但直接转成静态路由就只能回放其中一份。用户看到这个标记可以决定改用脚本模式。
   */
  varied: boolean
  /** 参与合并的日志 id，便于回溯 */
  sourceIds: string[]
}

/**
 * 响应头白名单之外要丢掉的字段。
 *
 * content-length 必须去掉：路由的响应体后续会被编辑，长度对不上浏览器会直接判定报文损坏。
 * 逐跳头（connection / transfer-encoding / keep-alive）属于这一次 TCP 连接的属性，
 * 复制到 Mock 上没有意义；date / etag / age 这类时效头留着只会误导。
 */
const DROP_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'date',
  'age',
  'etag',
  'last-modified',
  'server',
  'set-cookie',
  'content-encoding',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials'
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_ID_RE = /^[0-9a-f]{16,}$/i
const NUM_RE = /^\d+$/

/** 把 users / companies / boxes 这类复数段还原成单数，用于生成可读的参数名 */
function singular(seg: string): string {
  if (/(ses|xes|zes|ches|shes)$/i.test(seg)) return seg.slice(0, -2)
  if (/ies$/i.test(seg)) return seg.slice(0, -3) + 'y'
  if (/s$/i.test(seg) && !/ss$/i.test(seg)) return seg.slice(0, -1)
  return seg
}

/** 段是否看起来是一个 id 而不是固定路径 */
function looksLikeId(seg: string): boolean {
  if (NUM_RE.test(seg)) return true
  if (UUID_RE.test(seg)) return true
  if (HEX_ID_RE.test(seg)) return true
  return false
}

/**
 * 从具体路径推断路径模式。
 *
 * 参数名取「前一段的单数 + Id」而不是统一叫 :id —— `/api/users/1/orders/2` 会得到
 * `:userId` 与 `:orderId`，之后在响应模板里写 {{path.userId}} 才读得懂。
 * 同名冲突时追加序号，避免模板变量互相覆盖。
 */
export function inferPathPattern(path: string): { pattern: string; params: string[] } {
  const segs = path.split('/')
  const params: string[] = []
  const out = segs.map((seg, i) => {
    if (!seg || !looksLikeId(seg)) return seg
    const prev = segs[i - 1]
    let name = prev && !looksLikeId(prev) ? singular(prev) + 'Id' : 'id'
    // 参数名只保留标识符字符：路径段可能带连字符，写进 {{path.xxx}} 会解析不出来
    name = name.replace(/[^0-9a-zA-Z_]/g, '')
    if (!name || NUM_RE.test(name[0])) name = 'id'
    let final = name
    let n = 2
    while (params.includes(final)) final = name + String(n++)
    params.push(final)
    return ':' + final
  })
  return { pattern: out.join('/') || '/', params }
}

/** 由 Content-Type 推断响应体类型；识别不出按文本处理 */
export function inferBodyType(contentType: string | undefined): HttpBodyType {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('text/') || ct.includes('javascript') || ct.includes('urlencoded')) return 'text'
  if (!ct) return 'text'
  // 图片、二进制流这类没法当文本回放，交给 base64 模式
  if (ct.startsWith('image/') || ct.includes('octet-stream') || ct.startsWith('audio/') || ct.startsWith('video/')) {
    return 'base64'
  }
  return 'text'
}

/** JSON 响应重新缩进：真实后端多半是压缩输出，直接塞进编辑框没法读 */
function prettify(body: string, type: HttpBodyType): string {
  if (type !== 'json') return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function pickHeaders(headers: Record<string, string>): HttpHeaderKV[] {
  return Object.entries(headers)
    .filter(([k]) => !DROP_HEADERS.has(k.toLowerCase()))
    .map(([key, value]) => ({ key, value, enabled: true }))
}

export interface DraftOptions {
  /**
   * 只转换没命中任何路由的请求（含代理透传）。
   *
   * 默认开启：已经有路由在管的接口再转一遍只会生成重复项，
   * 而录制的价值恰恰在「还没建路由的那些」。
   */
  onlyUnmatched?: boolean
  /** 忽略 4xx/5xx 响应。默认开启，错误响应通常不是想固化的契约 */
  skipErrors?: boolean
}

/**
 * 把一批请求日志合并成路由草稿。
 *
 * 合并规则：同 method + 同推断模式算一条。示例响应取「最后一条成功响应」——
 * 后录的通常是调试稳定后的结果，比第一条更可信；全都不成功时退回最后一条。
 */
export function draftsFromLogs(logs: HttpLogEntry[], opts: DraftOptions = {}): RouteDraft[] {
  const onlyUnmatched = opts.onlyUnmatched !== false
  const skipErrors = opts.skipErrors !== false

  const byKey = new Map<string, RouteDraft>()
  for (const log of logs) {
    // CORS 预检不是业务接口，转成路由纯属噪声
    if (log.method === 'OPTIONS') continue
    if (onlyUnmatched && log.matchedRoute && log.matchedRoute !== '代理透传') continue
    if (skipErrors && log.status >= 400) continue

    const { pattern, params } = inferPathPattern(log.path)
    const method = log.method.toUpperCase() as HttpMethod
    const key = method + ' ' + pattern
    const ct = log.respHeaders?.['content-type'] ?? log.respHeaders?.['Content-Type']
    const bodyType = inferBodyType(ct)
    const body = prettify(log.respBody ?? '', bodyType)

    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, {
        key,
        method,
        pattern,
        samplePath: log.path,
        count: 1,
        status: log.status,
        bodyType,
        body,
        respHeaders: pickHeaders(log.respHeaders ?? {}),
        params,
        varied: false,
        sourceIds: [log.id]
      })
      continue
    }
    prev.count += 1
    prev.sourceIds.push(log.id)
    if (prev.body !== body) prev.varied = true
    // 后来的成功响应覆盖示例；已有成功响应时不被失败响应挤掉
    const prevOk = prev.status < 400
    const curOk = log.status < 400
    if (curOk || !prevOk) {
      prev.status = log.status
      prev.bodyType = bodyType
      prev.body = body
      prev.respHeaders = pickHeaders(log.respHeaders ?? {})
      prev.samplePath = log.path
    }
  }

  return [...byKey.values()].sort((a, b) => {
    // 先按「具体程度」降序：参数少、层级深的路径更具体。
    // 为什么不直接按频次排：频次高的往往是 /api/list 这类宽路径，
    // 排在前面会把 /api/list/:id 挡住，匹配结果就错了。
    const sa = specificity(a)
    const sb = specificity(b)
    if (sa !== sb) return sb - sa
    if (a.count !== b.count) return b.count - a.count
    return a.key.localeCompare(b.key)
  })
}

/** 具体程度：固定段越多越具体，参数段拉低分值 */
function specificity(d: RouteDraft): number {
  const segs = d.pattern.split('/').filter(Boolean)
  const fixed = segs.filter((s) => !s.startsWith(':')).length
  const dyn = segs.length - fixed
  return fixed * 10 - dyn * 3
}

/**
 * 草稿转路由。
 *
 * 优先级直接用具体程度：Mock 引擎按 priority 从大到小匹配，
 * 让固定路径天然压过带参数的路径，用户不必手动调数字。
 */
export function draftToRoute(d: RouteDraft, existingId?: string): HttpMockRoute {
  return {
    id: existingId ?? Math.random().toString(36).slice(2),
    name: d.method + ' ' + d.pattern,
    enabled: true,
    method: d.method,
    pathPattern: d.pattern,
    priority: Math.max(0, specificity(d)),
    mode: 'template',
    respStatus: d.status,
    respHeaders: d.respHeaders,
    bodyType: d.bodyType,
    respBody: d.body,
    delayMs: 0
  }
}

/** 该草稿在现有路由表里是否已有同方法同路径的条目 */
export function findExisting(routes: HttpMockRoute[], d: RouteDraft): HttpMockRoute | undefined {
  return routes.find((r) => r.method === d.method && r.pathPattern === d.pattern)
}

/** 场景默认名：带时间戳，方便多次录制形成前后对照 */
export function snapshotName(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `真实快照 ${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
}
