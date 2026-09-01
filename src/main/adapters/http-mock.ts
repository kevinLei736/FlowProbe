import * as http from 'node:http'
import * as https from 'node:https'
import * as zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionKind,
  HttpMockConfig,
  HttpLogEntry,
  OutgoingFrame,
  SessionConfig
} from '@shared/protocol'
import { BaseAdapter } from './base'
import { HttpMockEngine, defaultHttpMockConfig, type ParsedRequest } from '../http-mock/engine'
import { inspectCert } from '../tls/certStore'

const MAX_BODY = 5 * 1024 * 1024 // 5MB 请求体上限
/**
 * 日志里保留的响应正文上限。
 *
 * 原来是 4KB，对「看一眼响应对不对」够用，但录制转路由要拿这段正文当 Mock 响应体，
 * 4KB 会把稍长的列表接口 JSON 切断，生成的路由直接是坏的 JSON。提到 256KB：
 * 既能覆盖绝大多数业务响应，也不至于让工作区与历史库膨胀失控。
 */
const MAX_LOG_BODY = 256 * 1024

/**
 * 按 content-encoding 解压响应正文。
 *
 * 解不开时退回原始字节的 utf8 视图，而不是抛错 —— 录制场景下宁可拿到一段可疑文本，
 * 也不该让一个压缩格式异常把整条请求日志丢掉。
 */
function decodeBody(buf: Buffer, encoding: string): string {
  const enc = encoding.toLowerCase().trim()
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf).toString('utf8')
    if (enc === 'deflate') return zlib.inflateSync(buf).toString('utf8')
    if (enc === 'br') return zlib.brotliDecompressSync(buf).toString('utf8')
  } catch {
    // 落到下面按原始字节处理
  }
  return buf.toString('utf8')
}

export class HttpMockAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'http-mock'
  private server: http.Server | https.Server | null = null
  private httpMock: HttpMockEngine

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    const cfg = (config.httpMock as HttpMockConfig) ?? defaultHttpMockConfig()
    this.httpMock = new HttpMockEngine(cfg)
  }

  updateHttpMock(cfg: HttpMockConfig): void {
    this.httpMock.update(cfg)
    this.config.httpMock = cfg
    const sc = this.httpMock.activeScenarioName()
    this.emitSystem(
      `Mock 配置已更新（${cfg.enabled ? '启用' : '停用'}，路由 ${cfg.routes?.length ?? 0} 条${sc ? `，场景「${sc}」` : '，默认场景'}）`
    )
  }

  async start(): Promise<void> {
    const port = Number(this.config.port ?? 3000)
    const useHttps = this.config.https === true
    this.emitStatus('connecting', `正在启动 HTTP Mock :${port}`)

    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      this.handleRequest(req, res)
    }

    try {
      if (useHttps) {
        const cert = String(this.config.tlsCert ?? '')
        const key = String(this.config.tlsKey ?? '')
        /**
         * 起服务前先体检证书。
         *
         * 不校验的话，缺证书会抛一个「mac verify failure」之类的底层错误，
         * 证书和私钥配错对更糟——createServer 不报错，直到第一次握手才失败，
         * 界面显示「监听中」而浏览器打不开。把问题挪到启动这一刻并给出中文原因。
         */
        const info = inspectCert(cert, key)
        if (!info.ok) {
          const why = info.error ?? '证书不可用'
          this.emitError('HTTPS 启动失败：' + why + '。请在「证书」面板生成或导入证书。')
          this.emitStatus('error', why)
          return
        }
        if (typeof info.daysLeft === 'number' && info.daysLeft <= 14) {
          this.emitSystem(`证书将在 ${info.daysLeft} 天后过期，建议重新生成`, 'warn')
        }
        this.server = https.createServer({ cert, key }, handler)
      } else {
        this.server = http.createServer(handler)
      }
      this.server.on('error', (err: Error) => {
        this.emitError(err.message)
        this.emitStatus('error', err.message)
      })
      this.server.listen(port, () => {
        const scheme = useHttps ? 'https' : 'http'
        this.emitStatus('listening', `监听中 ${scheme}://127.0.0.1:${port}`)
        this.emitSystem(`HTTP Mock 服务已启动 ${scheme}://127.0.0.1:${port}`)
      })
    } catch (e) {
      const msg = (e as Error).message
      this.emitError(msg)
      this.emitStatus('error', msg)
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const started = Date.now()
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        aborted = true
        res.writeHead(413).end('payload too large')
        req.destroy()
        return
      }
      chunks.push(c)
    })

    req.on('end', () => {
      if (aborted) return
      const bodyBuf = Buffer.concat(chunks)
      const parsed = this.parse(req, bodyBuf)

      // CORS 预检
      const cors = this.httpMock.corsEnabled()
      const corsHeaders: Record<string, string> = cors
        ? {
            'Access-Control-Allow-Origin': req.headers.origin ?? '*',
            'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD',
            'Access-Control-Allow-Headers': String(req.headers['access-control-request-headers'] ?? '*'),
            'Access-Control-Allow-Credentials': 'true'
          }
        : {}
      if (cors && req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders).end()
        this.log(parsed, 204, Date.now() - started, {}, corsHeaders, '', 'CORS 预检')
        return
      }

      const mockRes = this.httpMock.isEnabled() ? this.httpMock.handle(parsed) : null

      if (mockRes) {
        const send = (): void => {
          const headers = { ...corsHeaders, ...mockRes.headers }
          res.writeHead(mockRes.status, headers)
          res.end(mockRes.body)
          this.log(
            parsed,
            mockRes.status,
            Date.now() - started,
            headers,
            headers,
            mockRes.body.toString('utf8').slice(0, MAX_LOG_BODY),
            mockRes.matchedRoute,
            mockRes.scenario
          )
        }
        if (mockRes.delayMs > 0) setTimeout(send, mockRes.delayMs)
        else send()
        return
      }

      // 未命中
      if (this.httpMock.fallthroughMode() === 'proxy' && this.httpMock.proxyTarget()) {
        this.proxyPass(parsed, bodyBuf, res, corsHeaders, started)
        return
      }

      const body = Buffer.from(
        JSON.stringify({ error: 'no-route-matched', method: parsed.method, path: parsed.path }),
        'utf8'
      )
      const headers = { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
      res.writeHead(404, headers)
      res.end(body)
      this.log(parsed, 404, Date.now() - started, headers, headers, body.toString('utf8'), undefined)
    })

    req.on('error', (err: Error) => this.emitError(err.message))
  }

  private proxyPass(
    parsed: ParsedRequest,
    bodyBuf: Buffer,
    res: http.ServerResponse,
    corsHeaders: Record<string, string>,
    started: number
  ): void {
    try {
      const target = this.httpMock.proxyTarget() as string
      const url = new URL(parsed.path + (parsed.rawQuery ? `?${parsed.rawQuery}` : ''), target)
      /**
       * Host 必须改成上游的 host。
       *
       * 原来直接把客户端的请求头整套转发，Host 还是 `127.0.0.1:3000`（Mock 自己的地址）。
       * 上游若按域名分流（Nginx server_name、网关多租户），会路由到错误的站点或直接 404，
       * 而现象只是「代理透传录不到东西」，很难往请求头上想。
       */
      const upstreamHeaders = { ...parsed.headers, host: url.host }
      const mod = url.protocol === 'https:' ? https : http
      const preq = mod.request(
        url,
        { method: parsed.method, headers: upstreamHeaders },
        (pres) => {
          const pchunks: Buffer[] = []
          pres.on('data', (c: Buffer) => pchunks.push(c))
          pres.on('end', () => {
            const pbody = Buffer.concat(pchunks)
            const headers = { ...corsHeaders, ...(pres.headers as Record<string, string>) }
            res.writeHead(pres.statusCode ?? 502, headers)
            // 原样转发给调用方（含 content-encoding），保证浏览器行为与直连真实后端一致
            res.end(pbody)
            this.log(
              parsed,
              pres.statusCode ?? 502,
              Date.now() - started,
              parsed.headers,
              headers,
              // 但日志里必须存解压后的文本：上游普遍开 gzip，存压缩字节的话
              // 请求详情看到的是乱码，录制转路由生成的响应体更是废的
              decodeBody(pbody, String(pres.headers['content-encoding'] ?? '')).slice(0, MAX_LOG_BODY),
              '代理透传'
            )
          })
        }
      )
      preq.on('error', (err) => {
        res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'proxy-error', message: err.message }))
        this.log(parsed, 502, Date.now() - started, parsed.headers, {}, err.message, '代理透传')
      })
      if (bodyBuf.length) preq.write(bodyBuf)
      preq.end()
    } catch (e) {
      res.writeHead(502).end('proxy error')
      this.emitError((e as Error).message)
    }
  }

  private parse(req: http.IncomingMessage, bodyBuf: Buffer): ParsedRequest {
    const host = req.headers.host ?? '127.0.0.1'
    const u = new URL(req.url ?? '/', `http://${host}`)
    const query: Record<string, string> = {}
    u.searchParams.forEach((v, k) => { query[k] = v })
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
    }
    return {
      method: req.method ?? 'GET',
      path: decodeURIComponent(u.pathname),
      query,
      rawQuery: u.search.replace(/^\?/, ''),
      headers,
      body: bodyBuf.toString('utf8')
    }
  }

  private log(
    parsed: ParsedRequest,
    status: number,
    durationMs: number,
    reqHeaders: Record<string, string>,
    respHeaders: Record<string, string>,
    respBody: string,
    matchedRoute?: string,
    scenario?: string
  ): void {
    // 指标：以请求为一帧 rx，响应为一帧 tx（字节量近似）
    this.emitData('rx', Buffer.from(parsed.body, 'utf8'), 'utf8')
    const entry: HttpLogEntry = {
      id: randomUUID(),
      sessionId: this.id,
      ts: Date.now(),
      method: parsed.method,
      path: parsed.path,
      query: parsed.rawQuery,
      status,
      durationMs,
      reqHeaders: parsed.headers,
      reqBody: parsed.body.slice(0, MAX_LOG_BODY),
      respHeaders,
      respBody,
      matchedRoute,
      scenario
    }
    this.emit('event', { type: 'httpLog', log: entry })
    const scTag = scenario ? `[${scenario}] ` : ''
    const tag = matchedRoute ? `${scTag}→ ${matchedRoute}` : '未命中'
    this.emitSystem(`${parsed.method} ${parsed.path} ${status} (${durationMs}ms) ${tag}`)
  }

  async send(_out: OutgoingFrame): Promise<void> {
    this.emitError('HTTP Mock 会话由客户端请求驱动，无需手动发送')
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
    this.server = null
    this.emitStatus('closed', 'HTTP Mock 已停止')
    this.emitSystem('HTTP Mock 服务已停止')
  }
}