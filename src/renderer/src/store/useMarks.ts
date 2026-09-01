import { create } from 'zustand'
import type { ConnectionKind, Direction, FrameMark } from '@shared/protocol'

const LS_KEY = 'toolbox.frameMarks.v1'

/**
 * 书签留存上限。
 *
 * 500 条是「人还能翻得完」的量级。书签的价值在于稀疏 —— 一旦攒到几千条，
 * 它和报文历史库就没区别了，而历史库本来就在那儿且检索能力更强。
 */
const MAX_MARKS = 500

/** 快照截断长度（字节）。书签是索引不是归档，报文全文在历史库里 */
const SNAP_BYTES = 128

export interface MarkInput {
  sessionId: string
  sessionName: string
  sessionKind: ConnectionKind
  frameId: string
  ts: number
  direction: Direction
  size: number
  snapshotHex: string
  snapshotText?: string
  note?: string
}

/**
 * 「跳回这条报文」的请求。
 *
 * 为什么放在 store 里而不是回调层层往下传：书签面板可能从顶部菜单打开（此时它
 * 与任何 SessionView 都没有父子关系），也可能从会话工具栏打开。做成一个请求信号，
 * 由目标会话自己认领，两条入口就是同一套逻辑。
 *
 * token 自增：连续点同一条书签也要能重新滚动过去。
 */
export interface LocateRequest {
  sessionId: string
  frameId: string
  token: number
}

interface State {
  marks: FrameMark[]
  loaded: boolean
  locateReq: LocateRequest | null
  load: () => void
  /** 加/取消书签。返回操作后是否处于「已标记」状态，便于界面立刻给反馈 */
  toggle: (input: MarkInput) => boolean
  /** 确保已标记并返回该书签（用于「标注」入口：点了就该能直接写字） */
  ensure: (input: MarkInput) => FrameMark
  setNote: (id: string, note: string) => void
  remove: (id: string) => void
  clearSession: (sessionId: string) => void
  clearAll: () => void
  requestLocate: (sessionId: string, frameId: string) => void
}

function rid(): string {
  return Math.random().toString(36).slice(2)
}

function persist(list: FrameMark[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_MARKS)))
  } catch {
    // 写失败不该影响标记动作本身（标记是同步反馈，报错弹窗更烦人）
  }
}

/** HEX 快照按字节截断，避免一条超长报文把 localStorage 顶满 */
function trimHex(hex: string): string {
  const parts = hex.trim().split(/\s+/)
  if (parts.length <= SNAP_BYTES) return hex
  return parts.slice(0, SNAP_BYTES).join(' ') + ' …'
}

export const useMarks = create<State>((set, get) => ({
  marks: [],
  loaded: false,
  locateReq: null,

  load: () => {
    if (get().loaded) return
    let marks: FrameMark[] = []
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) marks = JSON.parse(raw) as FrameMark[]
    } catch {
      // 解析失败按空处理：坏掉的书签不该阻塞应用启动
    }
    set({ marks, loaded: true })
  },

  toggle: (input) => {
    const list = get().marks
    const hit = list.find((m) => m.sessionId === input.sessionId && m.frameId === input.frameId)
    if (hit) {
      const next = list.filter((m) => m.id !== hit.id)
      persist(next)
      set({ marks: next })
      return false
    }
    get().ensure(input)
    return true
  },

  ensure: (input) => {
    const list = get().marks
    const hit = list.find((m) => m.sessionId === input.sessionId && m.frameId === input.frameId)
    if (hit) return hit
    const mark: FrameMark = {
      id: rid(),
      sessionId: input.sessionId,
      sessionName: input.sessionName,
      sessionKind: input.sessionKind,
      frameId: input.frameId,
      ts: input.ts,
      direction: input.direction,
      size: input.size,
      note: input.note ?? '',
      snapshotHex: trimHex(input.snapshotHex),
      snapshotText: input.snapshotText,
      createdAt: Date.now()
    }
    /*
      新书签插在最前面：书签面板按「最近标记」排，刚标的那条必须在眼前，
      否则连续标几条之后要滚到底部才能写标注。
    */
    const next = [mark, ...list].slice(0, MAX_MARKS)
    persist(next)
    set({ marks: next })
    return mark
  },

  setNote: (id, note) => {
    const next = get().marks.map((m) => (m.id === id ? { ...m, note } : m))
    persist(next)
    set({ marks: next })
  },

  remove: (id) => {
    const next = get().marks.filter((m) => m.id !== id)
    persist(next)
    set({ marks: next })
  },

  clearSession: (sessionId) => {
    const next = get().marks.filter((m) => m.sessionId !== sessionId)
    persist(next)
    set({ marks: next })
  },

  clearAll: () => {
    persist([])
    set({ marks: [] })
  },

  requestLocate: (sessionId, frameId) => {
    const prev = get().locateReq
    set({ locateReq: { sessionId, frameId, token: (prev?.token ?? 0) + 1 } })
  }
}))
