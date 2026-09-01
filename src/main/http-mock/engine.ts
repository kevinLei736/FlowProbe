import * as vm from 'node:vm'
import type {
  HttpMockConfig,
  HttpMockRoute,
  HttpMockScenario,
  HttpHeaderKV,
  HttpMethod
} from '@shared/protocol'

export interface ParsedRequest {
  method: string
  path: string
  query: Record<string, string>
  rawQuery: string
  headers: Record<string, string>
  body: string
}

export interface MockResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
  delayMs: number
  matchedRoute?: string
  /** 命中时生效的场景名，默认场景为 undefined */
  scenario?: string
}

interface MatchOutcome {
  route: HttpMockRoute
  params: Record<string, string>
}

const CT: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  base64: 'application/octet-stream'
}

/**
 * HTTP Mock 引擎：按路由规则匹配请求，生成响应。
 * 支持路径占位/通配/正则、模板占位符、脚本 handler、故障注入、有状态内存数据集。
 */
export class HttpMockEngine {
  private seq = 0
  // 有状态 Mock 的内存数据集，脚本可通过 state 读写
  private state: Record<string, unknown> = {}

  constructor(private config: HttpMockConfig) {}

  update(config: HttpMockConfig): void {
    this.config = config
  }

  isEnabled(): boolean {
    return this.config?.enabled === true
  }

  corsEnabled(): boolean {
    return this.config?.corsEnabled === true
  }

  fallthroughMode(): 'notFound' | 'proxy' {
    return this.config?.fallthrough ?? 'notFound'
  }

  proxyTarget(): string | undefined {
    return this.config?.proxyTarget
  }

  resetState(): void {
    this.state = {}
  }

  /** 当前生效场景；未选或找不到时返回 null（即默认场景） */
  private activeScenario(): HttpMockScenario | null {
    const id = this.config?.activeScenarioId
    if (!id) return null
    return (this.config.scenarios ?? []).find((s) => s.id === id) ?? null
  }

  activeScenarioName(): string | undefined {
    return this.activeScenario()?.name
  }

  /**
   * 把场景覆盖叠加到路由上。只覆盖场景里显式写了的字段，
   * 其余保持路由原样，这样「只改状态码」的场景不必复制整个响应体。
   */
  private applyScenario(route: HttpMockRoute): HttpMockRoute {
    const sc = this.activeScenario()
    if (!sc) return route
    const ov = sc.overrides?.[route.id]
    if (!ov) return route
    const merged: HttpMockRoute = { ...route }
    if (ov.enabled !== undefined) merged.enabled = ov.enabled
    if (ov.respStatus !== undefined) merged.respStatus = ov.respStatus
    if (ov.bodyType !== undefined) merged.bodyType = ov.bodyType
    if (ov.respBody !== undefined) merged.respBody = ov.respBody
    if (ov.respHeaders !== undefined) merged.respHeaders = ov.respHeaders
    if (ov.delayMs !== undefined) merged.delayMs = ov.delayMs
    if (ov.mode !== undefined) merged.mode = ov.mode
    if (ov.script !== undefined) merged.script = ov.script
    return merged
  }

  /** 返回响应；返回 null 表示未命中任何路由（交给 fallthrough 处理） */
  handle(req: ParsedRequest): MockResponse | null {
    const match = this.findRoute(req)
    if (!match) return null

    const { route, params } = match
    const scenarioName = this.activeScenarioName()
    // 场景可以带自己的故障注入设置，未设置则沿用全局
    const fault = this.activeScenario()?.fault ?? this.config.fault
    let delay = Math.max(0, route.delayMs || 0)

    // 故障注入：概率性返回失败状态码
    if (fault?.enabled) {
      delay += Math.max(0, fault.extraDelayMs || 0)
      if (fault.failRate > 0 && Math.random() < fault.failRate) {
        return {
          status: fault.failStatus || 500,
          headers: { 'Content-Type': CT.json },
          body: Buffer.from(JSON.stringify({ error: 'fault-injection', route: route.name }), 'utf8'),
          delayMs: delay,
          matchedRoute: route.name,
          scenario: scenarioName
        }
      }
    }

    if (route.mode === 'script') {
      return {
        ...this.runScript(route, req, params),
        delayMs: delay,
        matchedRoute: route.name,
        scenario: scenarioName
      }
    }

    // template 模式
    const headers = this.buildHeaders(route)
    const bodyText = this.applyTemplate(route.respBody, req, params)
    const body = route.bodyType === 'base64'
      ? Buffer.from(bodyText, 'base64')
      : Buffer.from(bodyText, 'utf8')
    return {
      status: route.respStatus || 200,
      headers,
      body,
      delayMs: delay,
      matchedRoute: route.name,
      scenario: scenarioName
    }
  }

  private buildHeaders(route: HttpMockRoute): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const h of route.respHeaders ?? []) {
      if (h.enabled === false) continue
      if (h.key.trim()) headers[h.key.trim()] = h.value
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = CT[route.bodyType] ?? CT.text
    }
    return headers
  }

  private findRoute(req: ParsedRequest): MatchOutcome | null {
    // 先叠加场景覆盖再筛 enabled：场景可以临时关掉某条路由（模拟接口未上线）
    const routes = [...(this.config.routes ?? [])]
      .map((r) => this.applyScenario(r))
      .filter((r) => r.enabled)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    for (const route of routes) {
      if (!this.methodMatches(route.method, req.method)) continue
      const params = this.pathMatches(route.pathPattern, req.path)
      if (!params) continue
      if (!this.filterMatches(route, req)) continue
      return { route, params }
    }
    return null
  }

  private methodMatches(want: HttpMethod, got: string): boolean {
    if (want === 'ANY') return true
    return want.toUpperCase() === got.toUpperCase()
  }

  /** 返回 null 表示不匹配，否则返回路径参数（可能为空对象） */
  private pathMatches(pattern: string, path: string): Record<string, string> | null {
    const pat = (pattern || '').trim()
    if (!pat) return null
    // 正则模式
    if (pat.startsWith('re:')) {
      try {
        const re = new RegExp(pat.slice(3))
        return re.test(path) ? {} : null
      } catch {
        return null
      }
    }
    // 精确
    if (pat === path) return {}
    // 通配 + 占位
    const pSeg = pat.split('/').filter(Boolean)
    const uSeg = path.split('/').filter(Boolean)
    const params: Record<string, string> = {}
    let i = 0
    for (; i < pSeg.length; i++) {
      const seg = pSeg[i]
      if (seg === '*') return params // 尾部通配匹配剩余
      if (seg === '**') return params
      if (uSeg[i] == null) return null
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(uSeg[i])
        continue
      }
      if (seg !== uSeg[i]) return null
    }
    if (uSeg.length !== pSeg.length) return null
    return params
  }

  private filterMatches(route: HttpMockRoute, req: ParsedRequest): boolean {
    if (route.matchQuery && route.matchQuery.trim()) {
      const idx = route.matchQuery.indexOf('=')
      if (idx > 0) {
        const k = route.matchQuery.slice(0, idx).trim()
        const v = route.matchQuery.slice(idx + 1).trim()
        if ((req.query[k] ?? '') !== v) return false
      }
    }
    if (route.matchHeader && route.matchHeader.trim()) {
      const idx = route.matchHeader.indexOf(':')
      if (idx > 0) {
        const k = route.matchHeader.slice(0, idx).trim().toLowerCase()
        const v = route.matchHeader.slice(idx + 1).trim()
        if ((req.headers[k] ?? '') !== v) return false
      }
    }
    return true
  }

  private applyTemplate(tpl: string, req: ParsedRequest, params: Record<string, string>): string {
    this.seq += 1
    let body = tpl ?? ''
    let jsonBody: Record<string, unknown> | null = null
    try {
      jsonBody = req.body ? JSON.parse(req.body) : null
    } catch {
      jsonBody = null
    }
    body = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
      if (key === 'now') return new Date().toISOString()
      if (key === 'ts') return String(Date.now())
      if (key === 'uuid') return cryptoUUID()
      if (key === 'sequence' || key === 'seq') return String(this.seq)
      if (key === 'randomInt') return String(Math.floor(Math.random() * 1e6))
      if (key.startsWith('path.')) return params[key.slice(5)] ?? ''
      if (key.startsWith('query.')) return req.query[key.slice(6)] ?? ''
      if (key.startsWith('header.')) return req.headers[key.slice(7).toLowerCase()] ?? ''
      if (key.startsWith('body.')) {
        const path = key.slice(5).split('.')
        let cur: unknown = jsonBody
        for (const p of path) {
          if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p]
          else { cur = undefined; break }
        }
        return cur == null ? '' : String(cur)
      }
      return ''
    })
    return body
  }

  private runScript(route: HttpMockRoute, req: ParsedRequest, params: Record<string, string>): MockResponse {
    const res = {
      status: 200,
      headers: {} as Record<string, string>,
      body: '' as unknown
    }
    try {
      const reqObj = {
        method: req.method,
        path: req.path,
        params,
        query: req.query,
        headers: req.headers,
        body: req.body,
        json: (() => { try { return req.body ? JSON.parse(req.body) : null } catch { return null } })()
      }
      const sandbox: Record<string, unknown> = {
        req: reqObj,
        res,
        state: this.state,
        console: { log: () => undefined },
        Buffer,
        Date,
        Math,
        JSON
      }
      const context = vm.createContext(sandbox)
      const wrapped = `(function(req, res, state){\n${route.script ?? ''}\n})(req, res, state)`
      new vm.Script(wrapped).runInContext(context, { timeout: 500 })
    } catch (e) {
      return {
        status: 500,
        headers: { 'Content-Type': CT.json },
        body: Buffer.from(JSON.stringify({ error: 'script-error', message: (e as Error).message }), 'utf8'),
        delayMs: 0,
        matchedRoute: route.name
      }
    }
    const headers = res.headers ?? {}
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = CT.json
    }
    let body: Buffer
    const rb = res.body
    if (Buffer.isBuffer(rb)) body = rb
    else if (typeof rb === 'string') body = Buffer.from(rb, 'utf8')
    else if (rb == null) body = Buffer.alloc(0)
    else body = Buffer.from(JSON.stringify(rb), 'utf8')
    return { status: res.status || 200, headers, body, delayMs: 0, matchedRoute: route.name }
  }
}

function cryptoUUID(): string {
  // 轻量 uuid v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function defaultHttpMockConfig(): HttpMockConfig {
  return {
    enabled: true,
    routes: [
      {
        id: 'demo1',
        name: '示例：健康检查',
        enabled: true,
        method: 'GET',
        pathPattern: '/api/health',
        priority: 10,
        mode: 'template',
        respStatus: 200,
        respHeaders: [],
        bodyType: 'json',
        respBody: '{\n  "status": "ok",\n  "time": "{{now}}"\n}',
        delayMs: 0
      },
      {
        id: 'demo2',
        name: '示例：按 id 查询',
        enabled: true,
        method: 'GET',
        pathPattern: '/api/users/:id',
        priority: 5,
        mode: 'template',
        respStatus: 200,
        respHeaders: [],
        bodyType: 'json',
        respBody: '{\n  "id": "{{path.id}}",\n  "name": "user-{{path.id}}",\n  "reqId": "{{uuid}}"\n}',
        delayMs: 0
      }
    ],
    scenarios: [
      {
        id: 'sc-401',
        name: '登录过期 401',
        note: '所有示例路由统一返回未授权，用于验证前端的重新登录逻辑',
        overrides: {
          demo1: {
            respStatus: 401,
            bodyType: 'json',
            respBody: '{\n  "error": "token_expired",\n  "message": "登录已过期，请重新登录"\n}'
          },
          demo2: {
            respStatus: 401,
            bodyType: 'json',
            respBody: '{\n  "error": "token_expired",\n  "message": "登录已过期，请重新登录"\n}'
          }
        }
      },
      {
        id: 'sc-500',
        name: '服务不可用 500',
        note: '整站故障注入，验证前端兜底与重试',
        overrides: {},
        fault: { enabled: true, failRate: 1, failStatus: 500, extraDelayMs: 0 }
      },
      {
        id: 'sc-slow',
        name: '慢接口 3s',
        note: '统一延迟 3 秒，验证加载态与超时处理',
        overrides: {
          demo1: { delayMs: 3000 },
          demo2: { delayMs: 3000 }
        }
      },
      {
        id: 'sc-offline',
        name: '接口未上线 404',
        note: '临时禁用示例路由，未命中走 404',
        overrides: {
          demo1: { enabled: false },
          demo2: { enabled: false }
        }
      }
    ],
    fault: { enabled: false, failRate: 0, failStatus: 500, extraDelayMs: 0 },
    fallthrough: 'notFound',
    corsEnabled: true
  }
}