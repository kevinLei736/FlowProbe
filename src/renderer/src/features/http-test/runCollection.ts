import type { HttpHeaderKV, HttpTestResponse, SavedHttpRequest } from '@shared/protocol'
import { resolveRequest, runAssertions, runExtracts, type AssertResult } from './useApiClient'

/**
 * 集合执行引擎。
 *
 * 为什么要单独抽出来：手动的「集合批量运行」和定时巡检跑的必须是同一段逻辑。
 * 如果各写一份，早晚会出现「手动跑过了、巡检报失败」这种最难排查的分歧 ——
 * 变量替换顺序、断言判定、失败即停的语义都是细节密集的地方。
 * 这里只负责「按顺序把一批请求跑完并汇总」，不碰任何界面状态。
 */

export interface RunStep {
  requestId: string
  name: string
  method: string
  url: string
  status: number
  statusText: string
  durationMs: number
  sizeBytes: number
  error?: string
  asserts: AssertResult[]
  extracted: Record<string, string>
  skipped?: boolean
}

export interface RunResult {
  startedAt: number
  finishedAt: number
  totalMs: number
  steps: RunStep[]
}

export interface RunOptions {
  /** 已按执行顺序排好的请求。筛选与排序由调用方决定 */
  items: SavedHttpRequest[]
  /** 环境变量作为运行时变量的基线 */
  envVars?: HttpHeaderKV[]
  /** 每步之间的间隔毫秒 */
  delayMs?: number
  /** 某步失败后把剩余步骤标记为跳过 */
  stopOnFail?: boolean
  /** 当前执行到哪一步（界面高亮用），结束时回传 null */
  onStep?: (requestId: string | null) => void
  /** 运行时变量每步更新一次，便于界面实时展示串联结果 */
  onVars?: (vars: Record<string, string>) => void
}

/** 一步是否算失败：请求本身出错，或有断言未通过 */
export function stepFailed(s: RunStep): boolean {
  return Boolean(s.error) || s.asserts.some((a) => !a.passed)
}

export async function runCollection(opts: RunOptions): Promise<RunResult> {
  const { items, delayMs = 0, stopOnFail = false, onStep, onVars } = opts
  const steps: RunStep[] = []

  // 运行时变量：环境变量为基线，提取结果逐步覆盖，实现接口间串联
  const vars: Record<string, string> = {}
  for (const v of opts.envVars ?? []) {
    if (v.enabled !== false) vars[v.key.trim()] = v.value
  }

  const startedAt = Date.now()
  let aborted = false

  for (const item of items) {
    if (aborted) {
      steps.push({
        requestId: item.id,
        name: item.name,
        method: item.request.method,
        url: item.request.url,
        status: 0,
        statusText: '',
        durationMs: 0,
        sizeBytes: 0,
        asserts: [],
        extracted: {},
        skipped: true
      })
      continue
    }

    onStep?.(item.id)
    const varList: HttpHeaderKV[] = Object.entries(vars).map(([key, value]) => ({
      key,
      value,
      enabled: true
    }))
    const resolved = resolveRequest(item.request, varList)

    let res: HttpTestResponse
    try {
      res = await window.toolbox.sendHttpTest(resolved)
    } catch (e) {
      // 网络层抛错也要生成一条结果，否则报告里会凭空少一步
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
    onVars?.({ ...vars })

    const step: RunStep = {
      requestId: item.id,
      name: item.name,
      method: resolved.method,
      url: resolved.url,
      status: res.status,
      statusText: res.statusText,
      durationMs: res.durationMs,
      sizeBytes: res.sizeBytes,
      error: res.error,
      asserts,
      extracted
    }
    steps.push(step)

    if (stepFailed(step) && stopOnFail) aborted = true
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  }

  onStep?.(null)
  const finishedAt = Date.now()
  return { startedAt, finishedAt, totalMs: finishedAt - startedAt, steps }
}

export interface RunStats {
  ran: number
  skipped: number
  stepPass: number
  stepFail: number
  assertTotal: number
  assertPass: number
}

export function summarize(result: RunResult): RunStats {
  const ran = result.steps.filter((s) => !s.skipped)
  const assertTotal = ran.reduce((n, s) => n + s.asserts.length, 0)
  const assertPass = ran.reduce((n, s) => n + s.asserts.filter((a) => a.passed).length, 0)
  const stepFail = ran.filter(stepFailed).length
  return {
    ran: ran.length,
    skipped: result.steps.length - ran.length,
    stepPass: ran.length - stepFail,
    stepFail,
    assertTotal,
    assertPass
  }
}

/** 把一次运行渲染成 Markdown 报告。手动运行与巡检共用，报告格式才不会两套 */
export function toMarkdown(result: RunResult, envName?: string, heading = '接口测试报告'): string {
  const s = summarize(result)
  const lines: string[] = []
  lines.push('# ' + heading, '')
  lines.push(`- 开始时间：${new Date(result.startedAt).toLocaleString()}`)
  lines.push(`- 总耗时：${result.totalMs} ms`)
  lines.push(`- 环境：${envName ?? '无'}`)
  lines.push(`- 用例：${s.stepPass} 通过 / ${s.ran} 执行（跳过 ${s.skipped}）`)
  lines.push(`- 断言：${s.assertPass} 通过 / ${s.assertTotal}`)
  lines.push('', '## 明细', '')
  lines.push('| # | 结果 | 方法 | 名称 | 状态码 | 耗时 | 大小 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  result.steps.forEach((step, i) => {
    const mark = step.skipped ? '跳过' : stepFailed(step) ? '失败' : '通过'
    lines.push(
      `| ${i + 1} | ${mark} | ${step.method} | ${step.name} | ${step.status || '-'} | ${step.durationMs}ms | ${step.sizeBytes}B |`
    )
  })
  lines.push('', '## 断言与提取', '')
  result.steps.forEach((step, i) => {
    lines.push(`### ${i + 1}. ${step.name}`)
    lines.push('`' + step.method + ' ' + step.url + '`', '')
    if (step.skipped) lines.push('- 已跳过（前序失败且开启了失败即停止）')
    if (step.error) lines.push(`- 错误：${step.error}`)
    if (step.asserts.length === 0 && !step.skipped) lines.push('- 未配置断言')
    step.asserts.forEach((a) => lines.push(`- ${a.passed ? '✓' : '✕'} ${a.detail}`))
    Object.entries(step.extracted).forEach(([k, v]) => lines.push(`- 提取 ${k} = ${v}`))
    lines.push('')
  })
  return lines.join('\n')
}
