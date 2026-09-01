import * as http from 'node:http'
import * as https from 'node:https'
import * as zlib from 'node:zlib'
import { URL } from 'node:url'
import type { HttpTestRequest, HttpTestResponse, HttpHeaderKV } from '@shared/protocol'

const MAX_REDIRECTS = 5

function enabledKV(list: HttpHeaderKV[]): [string, string][] {
  return (list ?? [])
    .filter((x) => x.enabled !== false && x.key.trim())
    .map((x) => [x.key.trim(), x.value])
}

function buildBody(req: HttpTestRequest): Buffer | undefined {
  switch (req.bodyType) {
    case 'none':
      return undefined
    case 'form': {
      const params = new URLSearchParams()
      req.body.split('\n').forEach((line) => {
        const idx = line.indexOf('=')
        if (idx > 0) params.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim())
      })
      return Buffer.from(params.toString(), 'utf8')
    }
    case 'binary':
      try {
        return Buffer.from(req.body, 'base64')
      } catch {
        return Buffer.from('')
      }
    default:
      return Buffer.from(req.body ?? '', 'utf8')
  }
}

function defaultContentType(req: HttpTestRequest): string | null {
  switch (req.bodyType) {
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

export async function sendHttpTest(req: HttpTestRequest): Promise<HttpTestResponse> {
  const started = Date.now()
  try {
    // 组装 URL + query
    const u = new URL(req.url)
    for (const [k, v] of enabledKV(req.query)) u.searchParams.append(k, v)

    const headers: Record<string, string> = {}
    for (const [k, v] of enabledKV(req.headers)) headers[k] = v

    // 认证
    const auth = req.auth
    if (auth) {
      if (auth.type === 'basic') {
        const token = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64')
        headers['Authorization'] = `Basic ${token}`
      } else if (auth.type === 'bearer') {
        headers['Authorization'] = `Bearer ${auth.token ?? ''}`
      } else if (auth.type === 'apikey' && auth.apiKeyName) {
        if (auth.apiKeyIn === 'query') u.searchParams.append(auth.apiKeyName, auth.apiKeyValue ?? '')
        else headers[auth.apiKeyName] = auth.apiKeyValue ?? ''
      }
    }

    const body = buildBody(req)
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      const ct = defaultContentType(req)
      if (ct) headers['Content-Type'] = ct
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept-encoding')) {
      headers['Accept-Encoding'] = 'gzip, deflate, br'
    }

    const result = await doRequest(
      u,
      req.method || 'GET',
      headers,
      body,
      req.timeoutMs ?? 30000,
      req.followRedirects !== false,
      req.rejectUnauthorized !== false,
      0
    )
    return { ...result, durationMs: Date.now() - started }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      headers: {},
      bodyBase64: '',
      bodyText: '',
      sizeBytes: 0,
      durationMs: Date.now() - started,
      redirects: 0,
      error: (e as Error).message
    }
  }
}

function doRequest(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  timeoutMs: number,
  followRedirects: boolean,
  rejectUnauthorized: boolean,
  redirectCount: number
): Promise<HttpTestResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const request = mod.request(
      url,
      { method, headers, rejectUnauthorized },
      (res) => {
        const status = res.statusCode ?? 0
        // 处理重定向
        if (
          followRedirects &&
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectCount < MAX_REDIRECTS
        ) {
          res.resume()
          const next = new URL(res.headers.location, url)
          const nextMethod = status === 303 ? 'GET' : method
          const nextBody = status === 303 ? undefined : body
          doRequest(next, nextMethod, headers, nextBody, timeoutMs, followRedirects, rejectUnauthorized, redirectCount + 1)
            .then((r) => resolve({ ...r, redirects: r.redirects + 1 }))
            .catch(reject)
          return
        }

        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let raw = Buffer.concat(chunks)
          const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
          try {
            if (enc === 'gzip') raw = zlib.gunzipSync(raw)
            else if (enc === 'deflate') raw = zlib.inflateSync(raw)
            else if (enc === 'br') raw = zlib.brotliDecompressSync(raw)
          } catch {
            // 解压失败则保留原始字节
          }
          const outHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
          }
          resolve({
            ok: status >= 200 && status < 400,
            status,
            statusText: res.statusMessage ?? '',
            headers: outHeaders,
            bodyBase64: raw.toString('base64'),
            bodyText: raw.toString('utf8'),
            sizeBytes: raw.length,
            durationMs: 0,
            redirects: 0
          })
        })
      }
    )
    request.on('error', (err) => reject(err))
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    if (body) request.write(body)
    request.end()
  })
}