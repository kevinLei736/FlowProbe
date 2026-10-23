import { readFileSync, writeFileSync } from 'node:fs'
import type {
  HttpEnvironment,
  HttpHeaderKV,
  HttpTestResponse,
  SavedHttpRequest
} from '@shared/protocol'
import { importCollection } from '@shared/collection'
import { resolveRequest, runAssertions, runExtracts } from '@shared/httpRun'
import { sendHttpTest } from '../http-test/client'

/**
 * 无界面集合执行（CI 模式）。
 *
 * 用法：
 *   FlowProbe --run-collection <集合文件> [--env <环境文件>] [--env-name <名称>]
 *             [--report <报告.json>] [--delay 200] [--stop-on-fail]
 *
 * 集合支持三种：FlowProbe 导出的 JSON（{collections:[...]}）、裸数组，
 * 以及 Postman v2.1 / OpenAPI 3.x。环境文件支持 {environments:[...]} 或
 * 直接一个 {key: value} 对象 —— 后者方便 CI 里用脚本生成。
 *
 * 退出码：0 全部通过；1 有失败；2 参数或文件错误。流水线只认这个，
 * 所以即使某一步网络异常也必须落成一条失败记录，不能吞掉。
 */

export interface CliOptions {
  collectionPath: string
  envPath?: string
  envName?: string
  reportPath?: string
  delayMs: number
  stopOnFail: boolean
}

export function parseCliArgs(argv: string[]): CliOptions | null {
  const idx = argv.indexOf('--run-collection')
  if (idx < 0) return null

  const readValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i < 0 || i + 1 >= argv.length) return undefined
    return argv[i + 1]
  }

  const collectionPath = argv[idx + 1]
  if (!collectionPath || collectionPath.startsWith('--')) {
    throw new Error('缺少集合文件路径，例如 --run-collection ./collection.json')
  }

  const delay = Number(readValue('--delay') ?? 0)
  return {
    collectionPath,
    envPath: readValue('--env'),
    envName: readValue('--env-name'),
    reportPath: readValue('--report'),
    delayMs: Number.isFinite(delay) && delay > 0 ? delay : 0,
    stopOnFail: argv.includes('--stop-on-fail')
  }
}

function loadCollection(path: string): SavedHttpRequest[] {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const doc = JSON.parse(text) as unknown
  if (Array.isArray(doc)) return doc as SavedHttpRequest[]
  if (doc && typeof doc === 'object') {
    const collections = (doc as { collections?: unknown }).collections
    if (Array.isArray(collections)) return collections as SavedHttpRequest[]
  }
  // 交给共享解析器处理 Postman / OpenAPI
  return importCollection(text).requests
}

function loadEnv(opts: CliOptions): { name: string; vars: HttpHeaderKV[] } {
  if (!opts.envPath) return { name: '无', vars: [] }
  const text = readFileSync(opts.envPath, 'utf8').replace(/^\uFEFF/, '')
  const doc = JSON.parse(text) as unknown

  if (Array.isArray(doc)) return { name: opts.envName ?? opts.envPath, vars: doc as HttpHeaderKV[] }

  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>
    if (Array.isArray(obj.environments)) {
      const list = obj.environments as HttpEnvironment[]
      const picked =
        (opts.envName ? list.find((e) => e.name === opts.envName) : undefined) ??
        list.find((e) => e.id === obj.activeEnvId) ??
        list[0]
      if (picked) return { name: picked.name, vars: picked.variables ?? [] }
    }
    if (Array.isArray(obj.variables)) {
      return { name: String(obj.name ?? opts.envName ?? '环境'), vars: obj.variables as HttpHeaderKV[] }
    }
    // 最简单的 {baseUrl: "https://..."} 形式
    const vars = Object.entries(obj)
      .filter(([k, v]) => !k.startsWith('$') && typeof v !== 'object')
      .map(([key, value]) => ({ key, value: String(value), enabled: true }))
    return { name: opts.envName ?? '环境对象', vars }
  }
  return { name: '无', vars: [] }
}

interface StepResult {
  index: number
  name: string
  method: string
  url: string
  status: number
  durationMs: number
  error?: string
  asserts: { passed: boolean; detail: string }[]
  extracted: Record<string, string>
  skipped?: boolean
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

export async function runCli(opts: CliOptions): Promise<number> {
  const items = loadCollection(opts.collectionPath)
  const { name: envName, vars: envVars } = loadEnv(opts)
  if (items.length === 0) {
    console.error('集合为空，没有可执行的请求')
    return 2
  }

  console.log(`FlowProbe CI · 集合 ${opts.collectionPath}`)
  console.log(`环境：${envName} · 用例：${items.length}${opts.stopOnFail ? ' · 失败即停' : ''}`)
  console.log('')

  const vars: Record<string, string> = {}
  for (const v of envVars) if (v.enabled !== false) vars[v.key.trim()] = v.value

  const startedAt = Date.now()
  const steps: StepResult[] = []
  let aborted = false

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (aborted) {
      steps.push({
        index: i + 1,
        name: item.name,
        method: item.request.method,
        url: item.request.url,
        status: 0,
        durationMs: 0,
        asserts: [],
        extracted: {},
        skipped: true
      })
      continue
    }

    const varList: HttpHeaderKV[] = Object.entries(vars).map(([key, value]) => ({
      key,
      value,
      enabled: true
    }))
    const resolved = resolveRequest(item.request, varList)

    let res: HttpTestResponse
    try {
      res = await sendHttpTest(resolved)
    } catch (e) {
      res = {
        ok: false,
        status: 0,
        statusText: '',
        headers: {},
        bodyBase64: '',
        bodyText: '',
        sizeBytes: 0,
        durationMs: 0,
        redirects: 0,
        error: (e as Error).message
      }
    }

    const asserts = runAssertions(res, item.assertions ?? [])
    const extracted = runExtracts(res, item.extracts)
    Object.assign(vars, extracted)

    const failed = Boolean(res.error) || asserts.some((a) => !a.passed)
    steps.push({
      index: i + 1,
      name: item.name,
      method: resolved.method,
      url: resolved.url,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error,
      asserts,
      extracted
    })

    const mark = failed ? 'FAIL' : 'PASS'
    console.log(
      `${mark}  ${pad(String(res.status || '-'), 4)} ${pad(res.durationMs + 'ms', 8)} ${pad(resolved.method, 7)} ${item.name}`
    )
    console.log(`      ${resolved.url}`)
    if (res.error) console.log(`      错误：${res.error}`)
    for (const a of asserts) {
      if (!a.passed) console.log(`      断言失败：${a.detail}`)
    }

    if (failed && opts.stopOnFail) aborted = true
    if (opts.delayMs > 0 && i < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
    }
  }

  const finishedAt = Date.now()
  const ran = steps.filter((s) => !s.skipped)
  const failedSteps = steps.filter(
    (s) => !s.skipped && (s.error || s.asserts.some((a) => !a.passed))
  )
  const assertTotal = steps.reduce((n, s) => n + s.asserts.length, 0)
  const assertPass = steps.reduce((n, s) => n + s.asserts.filter((a) => a.passed).length, 0)

  console.log('')
  console.log(
    `结果：${ran.length - failedSteps.length} 通过 / ${failedSteps.length} 失败 / ${steps.length - ran.length} 跳过 · 断言 ${assertPass}/${assertTotal} · 用时 ${finishedAt - startedAt}ms`
  )

  if (opts.reportPath) {
    const report = {
      tool: 'FlowProbe',
      collection: opts.collectionPath,
      env: envName,
      startedAt,
      finishedAt,
      totalMs: finishedAt - startedAt,
      summary: {
        total: steps.length,
        ran: ran.length,
        passed: ran.length - failedSteps.length,
        failed: failedSteps.length,
        assertTotal,
        assertPass
      },
      steps
    }
    writeFileSync(opts.reportPath, JSON.stringify(report, null, 2), 'utf8')
    console.log(`报告已写入 ${opts.reportPath}`)
  }

  return failedSteps.length === 0 ? 0 : 1
}
