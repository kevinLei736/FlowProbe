import { create } from 'zustand'

const LS_KEY = 'toolbox.layout'

/** 界面密度：只影响控件高度与内距，由 CSS 变量统一驱动，布局代码零改动 */
export type Density = 'compact' | 'default' | 'comfortable'

/** 分屏时哪一侧是操作焦点。菜单、快捷键、发送都作用于焦点侧的会话 */
export type Pane = 'left' | 'right'

interface State {
  sidebarVisible: boolean
  inspectorVisible: boolean
  density: Density
  /**
   * 右半区显示的会话 id；null = 未分屏。
   *
   * 为什么右半区用单独字段而不是「标签数组 + 一个分界下标」：
   * 分屏是临时的对比动作，不是常态布局。用一个字段表达，退出分屏就是置 null，
   * 不需要维护两组标签顺序，也不会在关标签时产生「分界线该往哪挪」的歧义。
   */
  splitId: string | null
  /** 左半区宽度占比 0.2–0.8，拖分隔条改变 */
  splitRatio: number
  /** 当前操作焦点在哪一侧 */
  focusPane: Pane
  /**
   * 发送编辑区高度（像素）。
   *
   * 为什么要提到全局状态：原来 textarea 靠原生 resize 手柄拉伸，但它是 flex 列容器里的
   * 可收缩项，一旦容器空间不足，flex 会把用户拉出来的高度重新压回去 —— 看起来有手柄，
   * 拉了却没反应。改成显式高度 + 拖拽分隔条后，高度由状态说话，不再被布局算法覆盖，
   * 而且能跨会话、跨重启记住「我习惯多高」。
   */
  editorH: number
  init: () => void
  toggleSidebar: () => void
  toggleInspector: () => void
  setSidebarVisible: (v: boolean) => void
  setInspectorVisible: (v: boolean) => void
  setDensity: (d: Density) => void
  /** 把某会话放到右半区进入分屏 */
  setSplit: (id: string | null) => void
  setSplitRatio: (r: number) => void
  setFocusPane: (p: Pane) => void
  setEditorH: (h: number) => void
  /** 左右互换。对比时经常需要把「正常的那个」挪到左边 */
  swapSplit: (leftId: string | null) => string | null
}

/** 发送区默认/最小/最大高度。最小值保证工具行 + 一行文本可见，最大值给报文区留出空间 */
export const EDITOR_H_DEFAULT = 168
export const EDITOR_H_MIN = 96
export const EDITOR_H_MAX = 560

function clampEditorH(h: number): number {
  if (!Number.isFinite(h)) return EDITOR_H_DEFAULT
  return Math.min(EDITOR_H_MAX, Math.max(EDITOR_H_MIN, Math.round(h)))
}

function applyDensity(d: Density): void {
  const root = document.documentElement
  if (d === 'default') root.removeAttribute('data-density')
  else root.setAttribute('data-density', d)
}

type Snap = {
  sidebarVisible: boolean
  inspectorVisible: boolean
  density: Density
  splitId: string | null
  splitRatio: number
  focusPane: Pane
  editorH: number
}

function persist(s: Snap): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

export const useLayout = create<State>((set, get) => ({
  sidebarVisible: true,
  inspectorVisible: true,
  density: 'default',
  splitId: null,
  splitRatio: 0.5,
  focusPane: 'left',
  editorH: EDITOR_H_DEFAULT,

  init: () => {
    let next: Snap = {
      sidebarVisible: true,
      inspectorVisible: true,
      density: 'default' as Density,
      splitId: null,
      splitRatio: 0.5,
      focusPane: 'left',
      editorH: EDITOR_H_DEFAULT
    }
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const d = JSON.parse(raw)
        next = {
          sidebarVisible: d.sidebarVisible !== false,
          inspectorVisible: d.inspectorVisible !== false,
          density:
            d.density === 'compact' || d.density === 'comfortable' ? d.density : ('default' as Density),
          splitId: typeof d.splitId === 'string' ? d.splitId : null,
          // 比例夹在 0.2–0.8：再窄的一侧连工具栏都排不开，等于白占地方
          splitRatio:
            typeof d.splitRatio === 'number' && d.splitRatio >= 0.2 && d.splitRatio <= 0.8
              ? d.splitRatio
              : 0.5,
          // 焦点不恢复到 right：右半区的会话可能已被删除，恢复后焦点会指向空
          focusPane: 'left',
          editorH: clampEditorH(typeof d.editorH === 'number' ? d.editorH : EDITOR_H_DEFAULT)
        }
      }
    } catch {
      // ignore
    }
    applyDensity(next.density)
    set(next)
  },

  toggleSidebar: () => {
    const next = { ...snapshot(get()), sidebarVisible: !get().sidebarVisible }
    set(next)
    persist(next)
  },
  toggleInspector: () => {
    const next = { ...snapshot(get()), inspectorVisible: !get().inspectorVisible }
    set(next)
    persist(next)
  },
  setSidebarVisible: (v) => {
    const next = { ...snapshot(get()), sidebarVisible: v }
    set(next)
    persist(next)
  },
  setInspectorVisible: (v) => {
    const next = { ...snapshot(get()), inspectorVisible: v }
    set(next)
    persist(next)
  },
  setDensity: (d) => {
    applyDensity(d)
    const next = { ...snapshot(get()), density: d }
    set(next)
    persist(next)
  },
  setSplit: (id) => {
    // 退出分屏时焦点必须回左边，否则菜单会继续对着一个已经不显示的会话操作
    const next = { ...snapshot(get()), splitId: id, focusPane: id ? get().focusPane : ('left' as Pane) }
    set(next)
    persist(next)
  },
  setSplitRatio: (r) => {
    const clamped = Math.min(0.8, Math.max(0.2, r))
    const next = { ...snapshot(get()), splitRatio: clamped }
    set(next)
    persist(next)
  },
  setEditorH: (h) => {
    const next = { ...snapshot(get()), editorH: clampEditorH(h) }
    set(next)
    persist(next)
  },
  setFocusPane: (p) => {
    if (get().focusPane === p) return
    const next = { ...snapshot(get()), focusPane: p }
    set(next)
    persist(next)
  },
  /**
   * 左右互换。左半区的会话由 useStore.activeId 决定，本 store 管不到，
   * 所以这里返回「应该成为新 activeId 的值」，由调用方接力设置。
   */
  swapSplit: (leftId) => {
    const right = get().splitId
    if (!right) return leftId
    const next = { ...snapshot(get()), splitId: leftId }
    set(next)
    persist(next)
    return right
  }
}))

function snapshot(s: State): Snap {
  return {
    sidebarVisible: s.sidebarVisible,
    inspectorVisible: s.inspectorVisible,
    density: s.density,
    splitId: s.splitId,
    splitRatio: s.splitRatio,
    focusPane: s.focusPane,
    editorH: s.editorH
  }
}
