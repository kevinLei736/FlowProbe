import { create } from 'zustand'
import type { Pane } from './useLayout'

/**
 * 分屏时的时间轴联动。
 *
 * 为什么单独开一个 store 而不是塞进 useLayout：联动是「每次滚动都在变」的高频状态，
 * 而 useLayout 每次变更都会写 localStorage。混在一起会让滚动变成磁盘写操作。
 * 这里的状态刻意不持久化——它描述的是此刻两侧滚到哪儿，重启没有意义。
 */
interface State {
  /** 是否开启联动。默认关：多数时候两侧看的是不同时间段 */
  enabled: boolean
  /** 谁在主导滚动。只有非主导侧才跟随，否则两侧会互相推着无限滚 */
  source: Pane | null
  /** 主导侧当前顶部报文的时间戳 */
  ts: number
  /**
   * 自增令牌。
   *
   * 跟随侧靠它判断「这是一次新的滚动」，而不是比较 ts：
   * 两侧时间戳可能恰好相同，此时只看 ts 会漏掉一次跟随。
   */
  token: number
  setEnabled: (v: boolean) => void
  /** 某一侧滚动后广播自己顶部的时间 */
  emit: (pane: Pane, ts: number) => void
}

export const useTimeSync = create<State>((set, get) => ({
  enabled: false,
  source: null,
  ts: 0,
  token: 0,

  setEnabled: (v) => set({ enabled: v, source: null }),

  emit: (pane, ts) => {
    if (!get().enabled) return
    if (get().source === pane && get().ts === ts) return
    set({ source: pane, ts, token: get().token + 1 })
  }
}))
