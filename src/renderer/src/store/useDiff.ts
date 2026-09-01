import { create } from 'zustand'

/** 被选中参与对比的一条报文。带上会话信息，跨会话对比时才知道各自出处 */
export interface DiffPick {
  sessionId: string
  sessionName: string
  frameId: string
  ts: number
  direction: string
  size: number
  /** 原始字节的 base64。diff 必须按原始字节比，不能用已解码的文本 */
  rawBase64: string
}

interface State {
  /**
   * 是否处于「挑选对比报文」模式。
   *
   * 为什么要一个显式模式而不是直接 Ctrl+单击选中：报文时间轴上的行本身
   * 就有点击行为（展开字段表、按主题过滤），再叠加隐式手势会互相打断。
   * 打开挑选模式后行左侧出现选择位，语义清晰，也便于跨会话连续挑第二条。
   */
  picking: boolean
  /** 最多两条，先进先出：挑第三条时替换掉第一条 */
  picks: DiffPick[]
  /** 对比视图是否展开 */
  open: boolean
  setPicking: (v: boolean) => void
  toggle: (pick: DiffPick) => void
  clear: () => void
  setOpen: (v: boolean) => void
  /** 会话被删掉后清理其残留选择 */
  prune: (aliveIds: string[]) => void
}

export const useDiff = create<State>((set, get) => ({
  picking: false,
  picks: [],
  open: false,

  setPicking: (v) => set({ picking: v, ...(v ? {} : { picks: [], open: false }) }),

  toggle: (pick) => {
    const { picks } = get()
    const i = picks.findIndex((p) => p.frameId === pick.frameId)
    if (i >= 0) {
      // 再点一次取消选择，同时收起对比视图（少了一边没法比）
      const next = picks.filter((p) => p.frameId !== pick.frameId)
      set({ picks: next, open: next.length === 2 })
      return
    }
    // 满两条后继续挑：替换较早的那条，这样「固定一个基准、依次比后面几条」
    // 这个高频用法不需要每次先手动取消
    const next = picks.length < 2 ? [...picks, pick] : [picks[1], pick]
    set({ picks: next, open: next.length === 2 })
  },

  clear: () => set({ picks: [], open: false }),
  setOpen: (v) => set({ open: v }),

  prune: (aliveIds) => {
    const next = get().picks.filter((p) => aliveIds.includes(p.sessionId))
    if (next.length === get().picks.length) return
    set({ picks: next, open: next.length === 2 })
  }
}))
