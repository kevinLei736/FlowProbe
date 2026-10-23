import type {
  HttpAuth,
  HttpEnvironment,
  HttpHeaderKV,
  HttpTestBodyType,
  HttpTestRequest,
  SavedHttpRequest
} from './protocol'

/**
 * 集合互通：Postman Collection v2.1 与 OpenAPI 3.x。
 *
 * 只做纯数据转换，不碰 UI 与 IPC：导入导出是最容易写错又最难回归的部分，
 * 保持成无副作用的函数，才能单独拿一份真实集合跑一遍对比结果。
 */

export type CollectionFormat = 'postman' | 'openapi' | 'unknown'

export interface ImportedCollection {
  name: string
  requests: SavedHttpRequest[]
  /** 导入时跳过或降级的条目，界面直接提示出来，避免「少了几条也不知道」 */
  warnings: string[]
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36).slice(-4)
}

function blankRequest(): HttpTestRequest {
  return {
    method: 'GET',
    url: '',
    query: [],
    headers: [],
    bodyType: 'none',
    body: '',
    auth: { type: 'none' },
    timeoutMs: 30000,
    followRedirects: true,
    rejectUnauthorized: true
  }
}

export function detectCollectionFormat(text: string): CollectionFormat {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>
    if (doc && typeof doc === 'object') {
      if ('openapi' in doc || 'swagger' in doc) return 'openapi'
      const info = doc.info as Record<string, unknown> | undefined
      if (info && typeof info.schema === 'string' && info.schema.includes('schema.getpostman.com')) {
        return 'postman'
      }
      if (Array.isArray(doc.item)) return 'postman'
    }
  } catch {
    // 落到 unknown
  }
  return 'unknown'
}

export function importCollection(text: string): ImportedCollection {
  const format = detectCollectionFormat(text)
  if (format === 'postman') return importPostman(text)
  if (format === 'openapi') return importOpenApi(text)
  throw new Error('无法识别集合格式：需要 Postman Collection v2.x 或 OpenAPI 3.x JSON')
}

// —— Postman ——

interface PostmanItem {
  name?: string
  item?: PostmanItem[]
  request?: unknown
}

function decodeQuery(rawQuery: string): HttpHeaderKV[] {
  if (!rawQuery) return []
  return rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=')
      const key = idx >= 0 ? pair.slice(0, idx) : pair
      const value = idx >= 0 ? pair.slice(idx + 1) : ''
      return { key: safeDecode(key), value: safeDecode(value), enabled: true }
    })
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

function postmanUrl(raw: unknown): { url: string; query: HttpHeaderKV[] } {
  if (typeof raw === 'string') {
    const idx = raw.indexOf('?')
    return {
      url: idx >= 0 ? raw.slice(0, idx) : raw,
      query: idx >= 0 ? decodeQuery(raw.slice(idx + 1)) : []
    }
  }
  if (!raw || typeof raw !== 'object') return { url: '', query: [] }
  const u = raw as Record<string, unknown>
  const rawText = typeof u.raw === 'string' ? u.raw : ''
  let url = rawText
  if (!url) {
    const protocol = typeof u.protocol === 'string' ? u.protocol + '://' : ''
    const host = Array.isArray(u.host) ? u.host.join('.') : typeof u.host === 'string' ? u.host : ''
    const path = Array.isArray(u.path)
      ? u.path
          .map((p) => (typeof p === 'string' ? p : String((p as { value?: string })?.value ?? '')))
          .join('/')
      : typeof u.path === 'string'
        ? u.path
        : ''
    url = protocol + host + (path ? '/' + path.replace(/^\//, '') : '')
  }
  const query = Array.isArray(u.query)
    ? (u.query as Record<string, unknown>[])
        .filter((q) => typeof q.key === 'string')
        .map((q) => ({
          key: String(q.key),
          value: String(q.value ?? ''),
          enabled: q.disabled !== true
        }))
    : decodeQuery(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  return { url: url.split('?')[0], query }
}

function postmanAuth(raw: unknown): HttpAuth {
  if (!raw || typeof raw !== 'object') return { type: 'none' }
  const a = raw as Record<string, unknown>
  const type = String(a.type ?? 'none')
  const list = (key: string): Record<string, unknown>[] =>
    Array.isArray(a[key]) ? (a[key] as Record<string, unknown>[]) : []
  const get = (key: string, field: string): string =>
    String(list(key).find((x) => x.key === field)?.value ?? '')
  if (type === 'bearer') return { type: 'bearer', token: get('bearer', 'token') }
  if (type === 'basic') {
    return {
      type: 'basic',
      username: get('basic', 'username'),
      password: get('basic', 'password')
    }
  }
  if (type === 'apikey') {
    return {
      type: 'apikey',
      apiKeyName: get('apikey', 'key'),
      apiKeyValue: get('apikey', 'value'),
      apiKeyIn: get('apikey', 'in') === 'query' ? 'query' : 'header'
    }
  }
  return { type: 'none' }
}

function postmanBody(raw: unknown): { bodyType: HttpTestBodyType; body: string } {
  if (!raw || typeof raw !== 'object') return { bodyType: 'none', body: '' }
  const b = raw as Record<string, unknown>
  const mode = String(b.mode ?? '')
  if (mode === 'raw') {
    const text = typeof b.raw === 'string' ? b.raw : ''
    const options = b.options as Record<string, Record<string, unknown>> | undefined
    const lang = String(options?.raw?.language ?? '').toLowerCase()
    if (lang === 'json' || looksLikeJson(text)) return { bodyType: 'json', body: text }
    if (lang === 'xml') return { bodyType: 'xml', body: text }
    return { bodyType: 'text', body: text }
  }
  if (mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
    const lines = (b.urlencoded as Record<string, unknown>[])
      .filter((x) => x.disabled !== true)
      .map((x) => `${String(x.key ?? '')}=${String(x.value ?? '')}`)
    return { bodyType: 'form', body: lines.join('\n') }
  }
  if (mode === 'formdata' && Array.isArray(b.formdata)) {
    const lines = (b.formdata as Record<string, unknown>[])
      .filter((x) => x.disabled !== true && x.type !== 'file')
      .map((x) => `${String(x.key ?? '')}=${String(x.value ?? '')}`)
    return { bodyType: 'form', body: lines.join('\n') }
  }
  return { bodyType: 'none', body: '' }
}

function looksLikeJson(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

function importPostman(text: string): ImportedCollection {
  const doc = JSON.parse(text) as Record<string, unknown>
  const info = doc.info as Record<string, unknown> | undefined
  const name = String(info?.name ?? '导入的集合')
  const requests: SavedHttpRequest[] = []
  const warnings: string[] = []

  const walk = (items: PostmanItem[], folder: string): void => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        walk(item.item, folder ? `${folder} / ${item.name ?? ''}` : String(item.name ?? ''))
        continue
      }
      const raw = item.request
      if (!raw) continue
      const r = typeof raw === 'string' ? { url: raw, method: 'GET' } : (raw as Record<string, unknown>)
      const { url, query } = postmanUrl(r.url)
      if (!url) {
        warnings.push(`「${item.name ?? '未命名'}」缺少 URL，已跳过`)
        continue
      }
      const headers = Array.isArray(r.header)
        ? (r.header as Record<string, unknown>[])
            .filter((h) => typeof h.key === 'string')
            .map((h) => ({
              key: String(h.key),
              value: String(h.value ?? ''),
              enabled: h.disabled !== true
            }))
        : []
      const { bodyType, body } = postmanBody(r.body)
      requests.push({
        id: uid(),
        name: folder ? `${folder} / ${item.name ?? url}` : String(item.name ?? url),
        request: {
          ...blankRequest(),
          method: String(r.method ?? 'GET').toUpperCase(),
          url,
          query,
          headers,
          bodyType,
          body,
          auth: postmanAuth(r.auth)
        },
        assertions: []
      })
    }
  }

  walk(Array.isArray(doc.item) ? (doc.item as PostmanItem[]) : [], '')
  if (requests.length === 0) warnings.push('集合里没有可导入的请求')
  return { name, requests, warnings }
}

// —— OpenAPI 3.x ——

type Json = Record<string, unknown>

function resolveRef(root: Json, schema: unknown): Json {
  if (!schema || typeof schema !== 'object') return {}
  const s = schema as Json
  const ref = typeof s.$ref === 'string' ? s.$ref : ''
  if (!ref.startsWith('#/')) return s
  let cur: unknown = root
  for (const part of ref.slice(2).split('/')) {
    if (!cur || typeof cur !== 'object') return s
    cur = (cur as Json)[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return cur && typeof cur === 'object' ? (cur as Json) : s
}

/**
 * 从 schema 生成一份可发送的示例。
 *
 * 导入 OpenAPI 的价值是「少手敲」，所以不能只给一个空对象：字段名与类型都在
 * schema 里，生成出来用户改两个值就能发。数组只取一个元素，避免生成一大坨。
 */
function sampleFromSchema(root: Json, input: unknown, depth = 0): unknown {
  if (depth > 8) return null
  const schema = resolveRef(root, input)
  if (!schema || typeof schema !== 'object') return null
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Array.isArray(schema.allOf)) {
    const merged: Json = {}
    for (const part of schema.allOf) {
      const v = sampleFromSchema(root, part, depth + 1)
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(merged, v)
    }
    return merged
  }
  const anyOf = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null
  if (anyOf && anyOf.length > 0) return sampleFromSchema(root, anyOf[0], depth + 1)

  const type = typeof schema.type === 'string' ? schema.type : schema.properties ? 'object' : ''
  if (type === 'object' || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, unknown>
    const out: Json = {}
    for (const [key, prop] of Object.entries(props)) out[key] = sampleFromSchema(root, prop, depth + 1)
    return out
  }
  if (type === 'array') {
    const item = sampleFromSchema(root, schema.items, depth + 1)
    return item === null ? [] : [item]
  }
  if (type === 'integer' || type === 'number') return schema.minimum !== undefined ? schema.minimum : 0
  if (type === 'boolean') return false
  if (type === 'string') {
    const format = String(schema.format ?? '')
    if (format === 'date-time') return new Date().toISOString()
    if (format === 'date') return new Date().toISOString().slice(0, 10)
    if (format === 'uuid') return '00000000-0000-4000-8000-000000000000'
    if (format === 'email') return 'user@example.com'
    return ''
  }
  return null
}

function importOpenApi(text: string): ImportedCollection {
  const doc = JSON.parse(text) as Json
  const version = String(doc.openapi ?? doc.swagger ?? '')
  if (!version.startsWith('3.')) {
    throw new Error(`仅支持 OpenAPI 3.x，当前文件是 ${version || '未知版本'}`)
  }
  const info = (doc.info ?? {}) as Json
  const name = String(info.title ?? '导入的 OpenAPI')
  const warnings: string[] = []

  const servers = Array.isArray(doc.servers) ? (doc.servers as Json[]) : []
  let base = typeof servers[0]?.url === 'string' ? String(servers[0].url) : ''
  if (base.includes('{')) {
    // 服务器地址里的变量（如 https://{host}/v1）保留成 {{host}}，交给环境变量替换
    base = base.replace(/\{([^}]+)\}/g, '{{$1}}')
  }
  base = base.replace(/\/$/, '')

  const requests: SavedHttpRequest[] = []
  const paths = (doc.paths ?? {}) as Record<string, Json>
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head']

  for (const [rawPath, pathItemRaw] of Object.entries(paths)) {
    const pathItem = resolveRef(doc, pathItemRaw)
    for (const method of methods) {
      const op = pathItem[method]
      if (!op || typeof op !== 'object') continue
      const operation = op as Json
      const params = Array.isArray(operation.parameters) ? (operation.parameters as Json[]) : []
      const mergedParams = [
        ...(Array.isArray(pathItem.parameters) ? (pathItem.parameters as Json[]) : []),
        ...params
      ].map((p) => resolveRef(doc, p))

      const query: HttpHeaderKV[] = []
      const headers: HttpHeaderKV[] = []
      for (const p of mergedParams) {
        const where = String(p.in ?? '')
        const key = String(p.name ?? '')
        if (!key) continue
        if (where === 'query') {
          const s = resolveRef(doc, p.schema)
          const value = s.example ?? s.default ?? (s.type === 'integer' || s.type === 'number' ? '0' : '')
          // 可选参数也保留：导入的意义是「少手敲」，留着按需删比事后补更快
          query.push({ key, value: String(value ?? ''), enabled: true })
        } else if (where === 'header') {
          const s = resolveRef(doc, p.schema)
          const value = s.example ?? s.default ?? ''
          headers.push({ key, value: String(value ?? ''), enabled: true })
        }
      }

      let bodyType: HttpTestBodyType = 'none'
      let body = ''
      const reqBody = resolveRef(doc, operation.requestBody)
      const content = (reqBody.content ?? {}) as Record<string, Json>
      const jsonType = Object.keys(content).find((t) => t.includes('json'))
      const xmlType = Object.keys(content).find((t) => t.includes('xml'))
      if (jsonType) {
        const media = content[jsonType]
        const sample =
          media.example !== undefined
            ? media.example
            : sampleFromSchema(doc, media.schema)
        bodyType = 'json'
        body = JSON.stringify(sample ?? {}, null, 2)
      } else if (xmlType) {
        bodyType = 'xml'
        body = String(content[xmlType].example ?? '')
      } else if (Object.keys(content).length > 0) {
        const media = content[Object.keys(content)[0]]
        bodyType = 'text'
        body = String(media.example ?? '')
      }

      const urlPath = rawPath.replace(/\{([^}]+)\}/g, '{{$1}}')
      requests.push({
        id: uid(),
        name: String(operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${rawPath}`),
        request: {
          ...blankRequest(),
          method: method.toUpperCase(),
          url: base + urlPath,
          query,
          headers,
          bodyType,
          body
        },
        assertions: []
      })
    }
  }

  if (requests.length === 0) warnings.push('paths 下没有可导入的接口')
  return { name, requests, warnings }
}

// —— 导出 ——

function withQuery(url: string, query: HttpHeaderKV[]): string {
  const active = query.filter((q) => q.enabled !== false && q.key.trim())
  if (active.length === 0) return url
  const qs = active
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)
    .join('&')
    // {{var}} 是模板语法，编码后 Postman 里会变成一串 %7B%7B，再导入回来对不上变量
    .replace(/%7B%7B/g, '{{')
    .replace(/%7D%7D/g, '}}')
  return url + (url.includes('?') ? '&' : '?') + qs
}

function postmanRequest(req: HttpTestRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    method: req.method,
    header: req.headers
      .filter((h) => h.enabled !== false && h.key.trim())
      .map((h) => ({ key: h.key, value: h.value })),
    url: withQuery(req.url, req.query)
  }
  if (req.bodyType === 'form') {
    out.body = {
      mode: 'urlencoded',
      urlencoded: req.body
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf('=')
          return { key: idx >= 0 ? line.slice(0, idx) : line, value: idx >= 0 ? line.slice(idx + 1) : '' }
        })
    }
  } else if (req.bodyType !== 'none') {
    const language = req.bodyType === 'json' ? 'json' : req.bodyType === 'xml' ? 'xml' : 'text'
    out.body = { mode: 'raw', raw: req.body, options: { raw: { language } } }
  }
  if (req.auth.type === 'bearer') {
    out.auth = { type: 'bearer', bearer: [{ key: 'token', value: req.auth.token ?? '' }] }
  } else if (req.auth.type === 'basic') {
    out.auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: req.auth.username ?? '' },
        { key: 'password', value: req.auth.password ?? '' }
      ]
    }
  } else if (req.auth.type === 'apikey') {
    out.auth = {
      type: 'apikey',
      apikey: [
        { key: 'key', value: req.auth.apiKeyName ?? '' },
        { key: 'value', value: req.auth.apiKeyValue ?? '' },
        { key: 'in', value: req.auth.apiKeyIn ?? 'header' }
      ]
    }
  }
  return out
}

export function exportPostman(
  name: string,
  items: SavedHttpRequest[],
  env?: HttpEnvironment | null
): string {
  const doc = {
    info: {
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: items.map((item) => ({
      name: item.name,
      request: postmanRequest(item.request)
    })),
    variable: (env?.variables ?? [])
      .filter((v) => v.key.trim())
      .map((v) => ({ key: v.key, value: v.value }))
  }
  return JSON.stringify(doc, null, 2)
}

/** 把请求 URL 拆成 server + path。{{baseUrl}} 这类变量直接当 server 用 */
function splitBaseUrl(url: string): { base: string; path: string } {
  const varMatch = /^(\{\{[^}]+\}\})(.*)$/.exec(url)
  if (varMatch) return { base: varMatch[1], path: varMatch[2] || '/' }
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i.exec(url)
  if (m) return { base: m[1], path: m[2] || '/' }
  const idx = url.indexOf('/')
  if (idx > 0) return { base: url.slice(0, idx), path: url.slice(idx) }
  return { base: '', path: url || '/' }
}

export function exportOpenApi(
  name: string,
  items: SavedHttpRequest[],
  env?: HttpEnvironment | null
): string {
  const paths: Record<string, Record<string, unknown>> = {}
  const servers = new Set<string>()

  for (const item of items) {
    const { base, path } = splitBaseUrl(item.request.url)
    if (base) servers.add(base)
    const openApiPath = (path || '/').replace(/\{\{([^}]+)\}\}/g, '{$1}')
    const method = item.request.method.toLowerCase()
    const parameters: Record<string, unknown>[] = [
      ...item.request.query
        .filter((q) => q.key.trim())
        .map((q) => ({
          name: q.key,
          in: 'query',
          required: false,
          schema: { type: 'string', example: q.value }
        })),
      ...item.request.headers
        .filter((h) => h.key.trim())
        .map((h) => ({
          name: h.key,
          in: 'header',
          required: false,
          schema: { type: 'string', example: h.value }
        }))
    ]

    const op: Record<string, unknown> = {
      summary: item.name,
      parameters,
      responses: { '200': { description: 'OK' } }
    }
    if (item.request.bodyType !== 'none' && item.request.body) {
      const mediaType =
        item.request.bodyType === 'json'
          ? 'application/json'
          : item.request.bodyType === 'xml'
            ? 'application/xml'
            : 'text/plain'
      let example: unknown = item.request.body
      if (item.request.bodyType === 'json') {
        try {
          example = JSON.parse(item.request.body)
        } catch {
          example = item.request.body
        }
      }
      op.requestBody = {
        content: { [mediaType]: { example } }
      }
    }
    paths[openApiPath] = { ...(paths[openApiPath] ?? {}), [method]: op }
  }

  const doc = {
    openapi: '3.0.3',
    info: { title: name, version: '1.0.0' },
    servers: [...servers].map((url) => ({ url })),
    paths
  }
  return JSON.stringify(doc, null, 2)
}
