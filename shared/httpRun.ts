import type {
  HttpAssertion,
  HttpExtractRule,
  HttpHeaderKV,
  HttpTestRequest,
  HttpTestResponse
} from './protocol'

/**
 * 接口执行的核心判定。
 *
 * 放在 shared 而不是渲染层：手动运行、定时巡检、命令行 / CI 必须用同一套
 * 变量替换与断言语义。三处各写一份的话，最容易出现「本地跑过、流水线报失败」
 * 这种只能靠猜的分歧。
 */

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

export interface AssertResult {
  id: string
  passed: boolean
  detail: string
}

export function getJsonPath(obj: unknown, path: string): unknown {
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
