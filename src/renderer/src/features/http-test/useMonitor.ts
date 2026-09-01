import { create } from 'zustand'
import type { MonitorRun, MonitorTask } from '@shared/protocol'

const LS_KEY = 'toolbox.monitor.v1'
/** 巡检历史条数上限。留多了 localStorage 会撑爆，留少了看不出趋势 */
const MAX_RUNS = 200

export const MIN_INTERVAL_SEC = 10

interface Persisted {
  tasks: MonitorTask[]
  runs: MonitorRun[]
}

interface State extends Persisted {
  /** 当前正在执行的任务 id。调度器串行执行，同一时刻只会有一个 */
  runningId: string | null
  /** 未读失败数：巡检在后台跑，用左栏/菜单红点提示 */
  unread: number

  load: () => void
  addTask: (t: MonitorTask) => void
  updateTask: (id: string, patch: Partial<MonitorTask>) => void
  removeTask: (id: string) => void
  setRunning: (id: string | null) => void
  pushRun: (run: MonitorRun) => void
  clearRuns: () => void
  clearUnread: () => void
}

function persist(get: () => State): void {
  const { tasks, runs } = get()
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ tasks, runs: runs.slice(0, MAX_RUNS) } as Persisted))
  } catch {
    // localStorage 写失败（隐私模式 / 配额）不该让巡检本身中断
  }
}

export const useMonitor = create<State>((set, get) => ({
  tasks: [],
  runs: [],
  runningId: null,
  unread: 0,

  load: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const data = JSON.parse(raw) as Persisted
      /*
        恢复时把 enabled 保留但清掉 runningId 与 failStreak 之外的瞬态字段。
        lastRunAt 要保留：调度器据此判断「上次跑完到现在够不够一个周期」，
        否则每次重启应用所有任务都会立刻齐刷刷跑一轮。
      */
      set({
        tasks: (data.tasks ?? []).map((t) => ({ ...t, intervalSec: Math.max(MIN_INTERVAL_SEC, t.intervalSec) })),
        runs: data.runs ?? []
      })
    } catch {
      // 解析失败按空处理，不阻塞启动
    }
  },

  addTask: (t) => {
    set((s) => ({ tasks: [...s.tasks, t] }))
    persist(get)
  },
  updateTask: (id, patch) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    persist(get)
  },
  removeTask: (id) => {
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), runs: s.runs.filter((r) => r.taskId !== id) }))
    persist(get)
  },
  setRunning: (id) => set({ runningId: id }),
  pushRun: (run) => {
    set((s) => ({
      runs: [run, ...s.runs].slice(0, MAX_RUNS),
      unread: run.stepFail > 0 ? s.unread + 1 : s.unread
    }))
    persist(get)
  },
  clearRuns: () => {
    set({ runs: [], unread: 0 })
    persist(get)
  },
  clearUnread: () => set({ unread: 0 })
}))

export function blankTask(name: string): MonitorTask {
  return {
    id: Math.random().toString(36).slice(2),
    name,
    requestIds: [],
    envId: null,
    intervalSec: 300,
    enabled: true,
    delayMs: 0,
    stopOnFail: false,
    notify: 'fail',
    failThreshold: 1,
    failStreak: 0
  }
}

/** 距离下次执行还有多少秒。返回 0 表示已到期 */
export function secondsUntilDue(t: MonitorTask, now = Date.now()): number {
  if (!t.enabled) return Infinity
  if (!t.lastRunAt) return 0
  const due = t.lastRunAt + t.intervalSec * 1000
  return Math.max(0, Math.round((due - now) / 1000))
}

export function formatInterval(sec: number): string {
  if (sec % 3600 === 0 && sec >= 3600) return sec / 3600 + ' 小时'
  if (sec % 60 === 0 && sec >= 60) return sec / 60 + ' 分钟'
  return sec + ' 秒'
}
