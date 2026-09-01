import { useEffect, useRef } from 'react'
import type { MonitorRun, MonitorTask } from '@shared/protocol'
import { useApiClient } from './useApiClient'
import { useMonitor } from './useMonitor'
import { runCollection, stepFailed, summarize } from './runCollection'

/**
 * 巡检调度器。
 *
 * 挂在应用外壳上而不是接口测试面板里 —— 巡检的全部价值就是「面板关着也在跑」。
 * 面板只是配置入口，把定时器绑在它身上，一关面板监控就停了。
 *
 * 为什么用「每 5 秒醒一次、自己判断谁到期」而不是给每个任务 setInterval：
 * 1. setInterval 在窗口被系统节流时会漂移，长间隔任务能漂出好几分钟；
 *    按 lastRunAt 比对当前时间，无论节流多久，醒来后立刻能算出该不该跑。
 * 2. 任务的间隔可以随时改，一个统一的心跳不需要重建定时器。
 * 3. 串行执行天然避免多个任务同时发请求，把本机端口和上游打满。
 */
const TICK_MS = 5000

export function useMonitorScheduler(): void {
  const loadApi = useApiClient((s) => s.load)
  const loadMonitor = useMonitor((s) => s.load)
  // 用 ref 记「本轮是否有任务在跑」：调度是异步的，靠 store 里的 runningId
  // 会因为闭包拿到旧值而重复启动同一个任务
  const busy = useRef(false)

  useEffect(() => {
    /*
      主动加载两份持久化数据：巡检要在接口测试面板从未打开过的情况下也能工作，
      而集合数据原本只在面板挂载时才 load。
    */
    loadApi()
    loadMonitor()
  }, [loadApi, loadMonitor])

  useEffect(() => {
    let disposed = false

    const tick = async (): Promise<void> => {
      if (disposed || busy.current) return
      const { tasks } = useMonitor.getState()
      const now = Date.now()
      const due = tasks.find(
        (t) => t.enabled && (!t.lastRunAt || t.lastRunAt + t.intervalSec * 1000 <= now)
      )
      if (!due) return

      busy.current = true
      try {
        await executeTask(due)
      } finally {
        busy.current = false
      }
    }

    const timer = window.setInterval(() => void tick(), TICK_MS)
    // 首次不等一个心跳：应用刚起来时把过期任务尽快补跑一次
    const kick = window.setTimeout(() => void tick(), 1500)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.clearTimeout(kick)
    }
  }, [])
}

/** 执行一个任务并落档。导出给面板的「立即运行」复用，保证两条路径行为一致 */
export async function executeTask(task: MonitorTask): Promise<MonitorRun> {
  const api = useApiClient.getState()
  const mon = useMonitor.getState()

  const envId = task.envId ?? api.activeEnvId
  const env = api.environments.find((e) => e.id === envId) ?? null
  // requestIds 为空表示「集合全部」：这样往集合里新加接口，巡检自动覆盖
  const items =
    task.requestIds.length === 0
      ? api.collections
      : (task.requestIds.map((id) => api.collections.find((c) => c.id === id)).filter(Boolean) as typeof api.collections)

  mon.setRunning(task.id)
  const result = await runCollection({
    items,
    envVars: env?.variables,
    delayMs: task.delayMs,
    stopOnFail: task.stopOnFail
  })
  mon.setRunning(null)

  const stats = summarize(result)
  const run: MonitorRun = {
    id: Math.random().toString(36).slice(2),
    taskId: task.id,
    taskName: task.name,
    startedAt: result.startedAt,
    totalMs: result.totalMs,
    ran: stats.ran,
    stepPass: stats.stepPass,
    stepFail: stats.stepFail,
    assertTotal: stats.assertTotal,
    assertPass: stats.assertPass,
    failures: result.steps.filter(stepFailed).map((s) => ({
      name: s.name,
      status: s.status,
      // 优先给出第一条未通过的断言细节，比只报状态码更有诊断价值
      detail: s.error ?? (s.asserts.find((a) => !a.passed)?.detail ?? '未知失败')
    }))
  }

  const passed = stats.stepFail === 0
  const streak = passed ? 0 : (task.failStreak ?? 0) + 1
  useMonitor.getState().updateTask(task.id, {
    lastRunAt: Date.now(),
    lastPassed: passed,
    failStreak: streak
  })
  useMonitor.getState().pushRun(run)

  /*
    通知策略里加「连续失败阈值」而不是一失败就弹：
    真实网络里偶发一次超时太常见，每次都弹通知会让人很快把通知关掉，
    那这个功能就等于没有。默认 1 次即通知，需要压噪时自己调高。
  */
  const shouldNotify =
    task.notify === 'always' ? true : task.notify === 'fail' ? !passed && streak >= Math.max(1, task.failThreshold) : false

  if (shouldNotify) {
    const title = passed ? '巡检通过：' + task.name : '巡检失败：' + task.name
    const body = passed
      ? stats.ran + ' 个接口全部通过，用时 ' + result.totalMs + 'ms'
      : run.failures.slice(0, 3).map((f) => f.name + ' → ' + f.detail).join('\n') +
        (run.failures.length > 3 ? '\n等 ' + run.failures.length + ' 个接口失败' : '')
    void window.toolbox.notify(title, body)
  }

  return run
}
