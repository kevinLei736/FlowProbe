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
  /** 批量导入：一次 set + 一次落盘，避免 50 条请求写 50 次 localStorage */
  importRequests: (items: SavedHttpRequest[]) => void
  removeRequest: (id: string) => void
  addEnvironment: (env: HttpEnvironment) => void
  updateEnvironment: (id: string, patch: Partial<HttpEnvironment>) => void
  removeEnvironment: (id: string) => void
  setActiveEnv: (id: string | null) => void
  pushHistory: (item: HistoryItem) => void
  clearHistory: () => void
}

/**
 * 落盘合并。
 *
 * 环境变量是逐字输入的受控表单，而每次 persist 都要把「集合 + 环境 +
 * 100 条历史（含响应摘要）」整体 JSON.stringify 一遍写进 localStorage。
 * 历史里可能带着 8KB 的响应体，敲一个字符就序列化近 1MB，输入会明显发涩。
 * 这里只延迟写入，内存状态照常即时更新；关窗与页面隐藏时强制 flush。
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null
let pendingData: Persisted | null = null

function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!pendingData) return
  const data = pendingData
  pendingData = null
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data))
  } catch {
    // 超限或隐私模式：内存状态仍然可用，不阻塞操作
  }
}

function persist(get: () => State): void {
  const { collections, environments, activeEnvId, history } = get()
  pendingData = { collections, environments, activeEnvId, history: history.slice(0, 100) }
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPersist, 300)
}

window.addEventListener('beforeunload', flushPersist)
window.addEventListener('pagehide', flushPersist)

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
  importRequests: (items) => {
    if (items.length === 0) return
    set((s) => ({ collections: [...s.collections, ...items] }))
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

export {
  applyVars,
  resolveRequest,
  runAssertions,
  runExtracts,
  getJsonPath as readJsonPath
} from '@shared/httpRun'
export type { AssertResult } from '@shared/httpRun'
