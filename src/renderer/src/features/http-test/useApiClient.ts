import { create } from 'zustand'
import type {
  HttpAssertion,
  HttpEnvironment,
  HttpHeaderKV,
  HttpTestRequest,
  HttpExtractRule,
  HttpTestResponse,
  SavedHttpRequest
} from '@shared/protocol'

const LS_KEY = 'toolbox.apiclient.v1'

export interface HistoryItem {
  id: string
  ts: number
  method: string
  url: string
  status: number
  durationMs: number
  request: HttpTestRequest
  /**
   * 响应摘要。只为 HAR 导出而存 —— 没有响应头和响应体的 HAR 在 DevTools 里
   * 只是一行光秃秃的请求，起不到「发给同事复现」的作用。
   *
   * 响应体截断到 HISTORY_BODY_LIMIT：历史留 100 条，全量响应体会迅速把
   * localStorage 撑爆（超限后整个 store 都写不进去，连集合都会丢）。
   */
  statusText?: string
  respHeaders?: Record<string, string>
  respBody?: string
  respSize?: number
  /** 响应体是否被截断，导出时会在 HAR 的 comment 里注明 */
  respTruncated?: boolean
}

/** 单条历史保留的响应体上限（字符）。8 KB 足够看清业务返回，又不至于撑爆 localStorage */
export const HISTORY_BODY_LIMIT = 8192

interface Persisted {
  collections: SavedHttpRequest[]
  environments: HttpEnvironment[]
  activeEnvId: string | null
  history: HistoryItem[]
}

interface State extends Persisted {
  load: () => void
  save: () => void
  saveRequest: (item: SavedHttpRequest) => void
  removeRequest: (id: string) => void
  addEnvironment: (env: HttpEnvironment) => void
  updateEnvironment: (id: string, patch: Partial<HttpEnvironment>) => void
  removeEnvironment: (id: string) => void
  setActiveEnv: (id: string | null) => void
  pushHistory: (item: HistoryItem) => void
  clearHistory: () => void
}

function persist(get: () => State): void {
  const { collections, environments, activeEnvId, history } = get()
  const data: Persisted = { collections, environments, activeEnvId, history: history.slice(0, 100) }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export const useApiClient = create<State>((set, get) => ({
  collections: [],
  environments: [],
  activeEnvId: null,
  history: [],

  load: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const data = JSON.parse(raw) as Persisted
        set({
          collections: data.collections ?? [],
          environments: data.environments ?? [],
          activeEnvId: data.activeEnvId ?? null,
          history: data.history ?? []
        })
      }
    } catch {
      // ignore
    }
  },
  save: () => persist(get),

  saveRequest: (item) => {
    set((s) => {
      const exists = s.collections.some((c) => c.id === item.id)
      return {
        collections: exists
          ? s.collections.map((c) => (c.id === item.id ? item : c))
          : [...s.collections, item]
      }
    })
    persist(get)
  },
  removeRequest: (id) => {
    set((s) => ({ collections: s.collections.filter((c) => c.id !== id) }))
    persist(get)
  },
  addEnvironment: (env) => {
    set((s) => ({ environments: [...s.environments, env], activeEnvId: env.id }))
    persist(get)
  },
  updateEnvironment: (id, patch) => {
    set((s) => ({ environments: s.environments.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
    persist(get)
  },
  removeEnvironment: (id) => {
    set((s) => ({
      environments: s.environments.filter((e) => e.id !== id),
      activeEnvId: s.activeEnvId === id ? null : s.activeEnvId
    }))
    persist(get)
  },
  setActiveEnv: (id) => {
    set({ activeEnvId: id })
    persist(get)
  },
  pushHistory: (item) => {
    /*
      截断放在 store 而不是调用点：将来集合运行、巡检也会往这里写历史，
      放在调用点必然有人忘记，而 localStorage 一旦超限是整体写入失败，
      表现为「集合莫名清空」，极难归因。
    */
    const body = item.respBody ?? ''
    const trimmed: HistoryItem =
      body.length > HISTORY_BODY_LIMIT
        ? { ...item, respBody: body.slice(0, HISTORY_BODY_LIMIT), respTruncated: true }
        : item
    set((s) => ({ history: [trimmed, ...s.history].slice(0, 100) }))
    persist(get)
  },
  clearHistory: () => {
    set({ history: [] })
    persist(get)
  }
}))

// 变量替换 {{name}}
export function applyVars(input: string, vars: HttpHeaderKV[]): string {
  if (!input) return input
  return input.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key: string) => {
    const hit = vars.find((v) => v.enabled !== false && v.key.trim() === key)
    return hit ? hit.value : `{{${key}}}`
  })
}

export function resolveRequest(req: HttpTestRequest, vars: HttpHeaderKV[]): HttpTestRequest {
  return {
    ...req,
    url: applyVars(req.url, vars),
    query: req.query.map((q) => ({ ...q, value: applyVars(q.value, vars) })),
    headers: req.headers.map((h) => ({ ...h, value: applyVars(h.value, vars) })),
    body: applyVars(req.body, vars),
    auth: {
      ...req.auth,
      token: req.auth.token ? applyVars(req.auth.token, vars) : req.auth.token,
      apiKeyValue: req.auth.apiKeyValue ? applyVars(req.auth.apiKeyValue, vars) : req.auth.apiKeyValue,
      password: req.auth.password ? applyVars(req.auth.password, vars) : req.auth.password
    }
  }
}

// 断言执行
export interface AssertResult {
  id: string
  passed: boolean
  detail: string
}

function getJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split('.').filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    const arrMatch = p.match(/^(\w+)\[(\d+)\]$/)
    if (arrMatch) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[arrMatch[1]] : undefined
      cur = Array.isArray(cur) ? cur[Number(arrMatch[2])] : undefined
    } else {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined
    }
    if (cur === undefined) break
  }
  return cur
}

export function runAssertions(res: HttpTestResponse, assertions: HttpAssertion[]): AssertResult[] {
  let json: unknown = null
  try {
    json = JSON.parse(res.bodyText)
  } catch {
    json = null
  }
  return assertions
    .filter((a) => a.enabled)
    .map((a) => {
      try {
        if (a.target === 'status') {
          const actual = res.status
          const passed = compareNum(actual, a.op, a.expected)
          return { id: a.id, passed, detail: `状态码 ${actual} ${a.op} ${a.expected}` }
        }
        if (a.target === 'time') {
          const passed = compareNum(res.durationMs, a.op, a.expected)
          return { id: a.id, passed, detail: `耗时 ${res.durationMs}ms ${a.op} ${a.expected}` }
        }
        if (a.target === 'text') {
          const passed = res.bodyText.includes(a.expected)
          return { id: a.id, passed, detail: `响应体${passed ? '' : '不'}包含「${a.expected}」` }
        }
        if (a.target === 'regex') {
          const passed = new RegExp(a.expected).test(res.bodyText)
          return { id: a.id, passed, detail: `正则 /${a.expected}/ ${passed ? '匹配' : '未匹配'}` }
        }
        if (a.target === 'jsonPath') {
          const actual = getJsonPath(json, a.path ?? '')
          const passed = compareVal(actual, a.op, a.expected)
          return { id: a.id, passed, detail: `${a.path} = ${JSON.stringify(actual)} ${a.op} ${a.expected}` }
        }
        return { id: a.id, passed: false, detail: '未知断言' }
      } catch (e) {
        return { id: a.id, passed: false, detail: (e as Error).message }
      }
    })
}

function compareNum(actual: number, op: string, expected: string): boolean {
  const exp = Number(expected)
  switch (op) {
    case 'eq': return actual === exp
    case 'neq': return actual !== exp
    case 'lt': return actual < exp
    case 'gt': return actual > exp
    default: return false
  }
}

function compareVal(actual: unknown, op: string, expected: string): boolean {
  switch (op) {
    case 'exists': return actual !== undefined && actual !== null
    case 'eq': return String(actual) === expected
    case 'neq': return String(actual) !== expected
    case 'contains': return String(actual).includes(expected)
    case 'match': try { return new RegExp(expected).test(String(actual)) } catch { return false }
    case 'lt': return Number(actual) < Number(expected)
    case 'gt': return Number(actual) > Number(expected)
    default: return false
  }
}
// 供 Runner 复用的 JSON 路径读取
export function readJsonPath(obj: unknown, path: string): unknown {
  return getJsonPath(obj, path)
}

// 按提取规则从响应里取值，返回 变量名 -> 值
export function runExtracts(
  res: HttpTestResponse,
  rules: HttpExtractRule[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!rules || rules.length === 0) return out
  let json: unknown = null
  try {
    json = JSON.parse(res.bodyText)
  } catch {
    json = null
  }
  for (const rule of rules) {
    if (!rule.enabled || !rule.varName.trim()) continue
    let value: unknown
    if (rule.source === 'status') value = res.status
    else if (rule.source === 'header') {
      const want = (rule.path ?? '').toLowerCase()
      const hit = Object.entries(res.headers).find(([k]) => k.toLowerCase() === want)
      value = hit?.[1]
    } else {
      value = rule.path ? getJsonPath(json, rule.path) : res.bodyText
    }
    if (value === undefined || value === null) continue
    out[rule.varName.trim()] = typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  return out
}
