/**
 * HAR 1.2 构建与序列化。
 *
 * 为什么单独抽一层纯函数：HAR 有三个来源 —— Mock 请求日志、接口测试历史、
 * 历史库落盘记录。前两者在渲染层，第三个在主进程。共用一份字段映射，才不会
 * 出现「同一次请求从不同入口导出，字段长得不一样」这种最难解释的分歧。
 *
 * 为什么选 HAR 而不是自定义 JSON：HAR 是 Chrome DevTools、Postman、Fiddler、
 * Charles 都能直接打开的格式。排查时把文件发给同事，对方拖进浏览器就看到完整的
 * 请求与响应，不需要先装这个工具。自定义格式等于把协作成本转嫁给对方。
 */

export interface HarNameValue {
  name: string
  value: string
}

export interface HarPostData {
  mimeType: string
  text: string
  params?: HarNameValue[]
}

export interface HarRequest {
  method: string
  url: string
  httpVersion: string
  cookies: HarNameValue[]
  headers: HarNameValue[]
  queryString: HarNameValue[]
  postData?: HarPostData
  headersSize: number
  bodySize: number
}

export interface HarContent {
  size: number
  mimeType: string
  text?: string
  /** 仅二进制响应会带上，值固定为 base64 */
  encoding?: string
}

export interface HarResponse {
  status: number
  statusText: string
  httpVersion: string
  cookies: HarNameValue[]
  headers: HarNameValue[]
  content: HarContent
  redirectURL: string
  headersSize: number
  bodySize: number
}

export interface HarEntry {
  startedDateTime: string
  time: number
  request: HarRequest
  response: HarResponse
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number }
  comment?: string
}

export interface HarFile {
  log: {
    version: string
    creator: { name: string; version: string; comment?: string }
    entries: HarEntry[]
  }
}

/** 构建一条 entry 所需的最小信息。各来源把自己的行映射成这个形状即可 */
export interface HarEntryInput {
  startedAt: number
  /** 总耗时毫秒。为 0 或缺失时写 -1（HAR 规范里 -1 表示未知，写 0 会被理解成瞬时完成）*/
  timeMs?: number
  method: string
  /** 完整 URL。Mock 日志只有路径，调用方需要先拼上 base */
  url: string
  reqHeaders?: Record<string, string>
  reqBody?: string
  status: number
  statusText?: string
  respHeaders?: Record<string, string>
  respBody?: string
  /** 二进制响应给 base64（与 respBody 二选一，优先用它）*/
  respBodyBase64?: string
  respSize?: number
  /** 写进 entry.comment，用来标注来源或缺失项 */
  comment?: string
}

/**
 * 本地时区的 ISO 8601 时间戳。
 *
 * 不用 toISOString()：那是 UTC，导出的 HAR 在 DevTools 里会整体差 8 小时，
 * 和现场日志对时间时非常容易看错。HAR 规范本身要求带时区偏移，
 * 所以带 +08:00 才是更规范的写法。
 */
function localIso(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    'T' + p(d.getHours()) +
    ':' + p(d.getMinutes()) +
    ':' + p(d.getSeconds()) +
    '.' + p(d.getMilliseconds(), 3) +
    sign + p(Math.floor(abs / 60)) + ':' + p(abs % 60)
  )
}

function toNameValues(h?: Record<string, string>): HarNameValue[] {
  if (!h) return []
  return Object.entries(h).map(([name, value]) => ({ name, value: String(value ?? '') }))
}

function headerOf(h: Record<string, string> | undefined, key: string): string {
  if (!h) return ''
  const lower = key.toLowerCase()
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return String(v ?? '')
  }
  return ''
}

/**
 * 从 URL 里拆 query。
 *
 * 用 URL 而不是手写切分：编码过的参数（中文、+、%2F）手写必然处理不全，
 * 而 HAR 消费方会按解码后的值展示。相对路径先补一个占位 origin 再解析，
 * 因为 Mock 日志给的就是 /api/x?y=1 这种形式。
 */
function parseQuery(url: string): HarNameValue[] {
  try {
    const u = url.includes('://') ? new URL(url) : new URL(url, 'http://localhost')
    const out: HarNameValue[] = []
    u.searchParams.forEach((value, name) => out.push({ name, value }))
    return out
  } catch {
    return []
  }
}

/** 字节长度。用 TextEncoder 而不是 length：中文一个字符不是一个字节，写 length 会让 bodySize 偏小 */
function byteLen(s: string): number {
  if (!s) return 0
  try {
    return new TextEncoder().encode(s).length
  } catch {
    return s.length
  }
}

export function toHarEntry(input: HarEntryInput): HarEntry {
  const reqMime = headerOf(input.reqHeaders, 'content-type') || 'application/octet-stream'
  const respMime = headerOf(input.respHeaders, 'content-type') || 'text/plain'
  const hasReqBody = typeof input.reqBody === 'string' && input.reqBody.length > 0
  const base64 = input.respBodyBase64
  const text = base64 ?? input.respBody ?? ''
  const size = input.respSize ?? (base64 ? Math.floor((base64.length * 3) / 4) : byteLen(text))
  /*
    时间为 0 时写 -1：HAR 规范用 -1 表示「未知」。写 0 的话 DevTools 会画成
    一条零宽的时间条，看起来像请求瞬间完成，比不显示更容易误判。
  */
  const time = input.timeMs && input.timeMs > 0 ? input.timeMs : -1
  const content: HarContent = { size, mimeType: respMime }
  if (text) content.text = text
  if (base64) content.encoding = 'base64'
  const entry: HarEntry = {
    startedDateTime: localIso(input.startedAt),
    time,
    request: {
      method: (input.method || 'GET').toUpperCase(),
      url: input.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toNameValues(input.reqHeaders),
      queryString: parseQuery(input.url),
      headersSize: -1,
      bodySize: hasReqBody ? byteLen(input.reqBody as string) : 0,
      /*
        postData 是 DevTools「Payload」页读的字段。只填 bodySize 的话
        字节数对得上但载荷是空的，看起来像请求没带 body —— 而 body 恰恰是
        排查 POST 接口时最先要看的东西。
      */
      ...(hasReqBody
        ? { postData: { mimeType: reqMime, text: input.reqBody as string } }
        : {})
    },
    response: {
      status: input.status,
      statusText: input.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: toNameValues(input.respHeaders),
      content,
      redirectURL: headerOf(input.respHeaders, 'location'),
      headersSize: -1,
      bodySize: size
    },
    cache: {},
    /*
      timings 三项之和必须等于 time，否则 DevTools 会拒绝这条 entry。
      本工具测不到 DNS/连接/首字节的分段耗时，只有一个总时长，
      因此全部记在 wait 上 —— 这也是「等服务端响应」的实际语义。
    */
    timings: { send: 0, wait: time, receive: 0 }
  }
  if (input.comment) entry.comment = input.comment
  return entry
}

export function buildHar(inputs: HarEntryInput[], creatorVersion: string, comment?: string): HarFile {
  const creator: HarFile['log']['creator'] = {
    name: 'FlowProbe',
    version: creatorVersion
  }
  if (comment) creator.comment = comment
  return {
    log: {
      version: '1.2',
      creator,
      // 按时间升序：HAR 消费方普遍按数组顺序画时间轴，倒序会让瀑布图整体翻过来
      entries: [...inputs].sort((a, b) => a.startedAt - b.startedAt).map(toHarEntry)
    }
  }
}

/** 序列化。缩进 2 空格：HAR 经常要人工翻一眼确认字段，压成一行反而增加成本 */
export function harToJson(har: HarFile): string {
  return JSON.stringify(har, null, 2)
}
