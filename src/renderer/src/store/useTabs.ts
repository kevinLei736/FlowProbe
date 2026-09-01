import { create } from 'zustand'

const LS_KEY = 'toolbox.tabs'

/**
 * 中栏标签页状态。
 *
 * 为什么要引入这一层，而不是继续只用 useStore 里的 activeId：
 * activeId 表达的是「现在看哪个会话」，一次只能有一个；标签表达的是
 * 「我手头正在跟进哪几个会话」，是一个有序集合。排查跨设备问题时通常在
 * 三五个会话之间来回跳，只有 activeId 的话每次都得回左栏的长列表里找。
 *
 * 「预览标签」这个概念借用编辑器的做法，解决的是「点一下就多一个标签」
 * 造成的标签爆炸：左栏单击进来的会话落在同一个预览槽位里反复替换，
 * 只有明确表达了「我要留着它」（Ctrl+单击左栏 / 双击标签 / 在该会话里
 * 发过报文）才提升为常驻标签。
 */
interface State {
  /** 标签顺序即数组顺序，元素是会话 id */
  ids: string[]
  /** 当前处于预览态的标签；null = 没有预览标签 */
  previewId: string | null
  init: () => void
  /** 确保某会话有标签并成为焦点。permanent=true 时直接落成常驻标签 */
  ensure: (id: string, permanent?: boolean) => void
  /** 把预览标签提升为常驻 */
  pin: (id: string) => void
  /** 关闭一个标签，返回关闭后应该激活的会话 id（null = 已无标签） */
  close: (id: string) => string | null
  closeOthers: (id: string) => void
  closeRight: (id: string) => void
  closeAll: () => void
  /** 拖拽排序：把 from 位置的标签插到 to 位置 */
  reorder: (from: number, to: number) => void
  /** 会话被删除后清理残留标签 */
  prune: (aliveIds: string[]) => void
}

function persist(s: { ids: string[]; previewId: string | null }): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

export const useTabs = create<State>((set, get) => ({
  ids: [],
  previewId: null,

  init: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const d = JSON.parse(raw) as { ids?: unknown; previewId?: unknown }
      const ids = Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === 'string') : []
      const previewId = typeof d.previewId === 'string' ? d.previewId : null
      set({ ids, previewId: ids.includes(previewId ?? '') ? previewId : null })
    } catch {
      // ignore
    }
  },

  ensure: (id, permanent = false) => {
    const { ids, previewId } = get()
    if (ids.includes(id)) {
      // 已经开着：只在明确要求常驻时升级，避免 Ctrl+Tab 循环时把预览标签
      // 无意间钉住（那样循环一圈标签就全变常驻了）
      if (permanent && previewId === id) {
        const next = { ids, previewId: null }
        set(next)
        persist(next)
      }
      return
    }
    let nextIds: string[]
    let nextPreview: string | null
    if (!permanent && previewId && ids.includes(previewId)) {
      // 复用预览槽位：保持它在标签条里的位置不动，只换内容
      nextIds = ids.map((x) => (x === previewId ? id : x))
      nextPreview = id
    } else {
      nextIds = [...ids, id]
      nextPreview = permanent ? previewId : id
    }
    const next = { ids: nextIds, previewId: nextPreview }
    set(next)
    persist(next)
  },

  pin: (id) => {
    if (get().previewId !== id) return
    const next = { ids: get().ids, previewId: null }
    set(next)
    persist(next)
  },

  close: (id) => {
    const { ids, previewId } = get()
    const i = ids.indexOf(id)
    if (i < 0) return null
    const nextIds = ids.filter((x) => x !== id)
    const next = { ids: nextIds, previewId: previewId === id ? null : previewId }
    set(next)
    persist(next)
    // 关掉后焦点给右邻居，没有右邻居再给左邻居——和浏览器一致
    return nextIds[i] ?? nextIds[i - 1] ?? null
  },

  closeOthers: (id) => {
    const next = { ids: get().ids.filter((x) => x === id), previewId: null }
    set(next)
    persist(next)
  },

  closeRight: (id) => {
    const { ids, previewId } = get()
    const i = ids.indexOf(id)
    if (i < 0) return
    const nextIds = ids.slice(0, i + 1)
    const next = { ids: nextIds, previewId: nextIds.includes(previewId ?? '') ? previewId : null }
    set(next)
    persist(next)
  },

  closeAll: () => {
    const next = { ids: [] as string[], previewId: null }
    set(next)
    persist(next)
  },

  reorder: (from, to) => {
    const ids = [...get().ids]
    if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    const next = { ids, previewId: get().previewId }
    set(next)
    persist(next)
  },

  prune: (aliveIds) => {
    const { ids, previewId } = get()
    const nextIds = ids.filter((x) => aliveIds.includes(x))
    if (nextIds.length === ids.length) return
    const next = { ids: nextIds, previewId: nextIds.includes(previewId ?? '') ? previewId : null }
    set(next)
    persist(next)
  }
}))
