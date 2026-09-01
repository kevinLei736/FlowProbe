import { create } from 'zustand'
import type { Session } from '@shared/protocol'

const LS_KEY = 'toolbox.sessionOrg'

/** 未分组会话在左栏里的归属名 */
export const UNGROUPED = '未分组'

interface State {
  /** 折叠起来的分组名集合 */
  collapsed: string[]
  /** 生效的标签筛选；空数组表示不筛选 */
  tagFilter: string[]
  /** 左栏搜索关键字（名称 / 分组 / 标签 / 地址） */
  keyword: string
  init: () => void
  toggleGroup: (name: string) => void
  isCollapsed: (name: string) => boolean
  toggleTag: (tag: string) => void
  clearTags: () => void
  setKeyword: (kw: string) => void
}

function persist(s: { collapsed: string[]; tagFilter: string[] }): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

export const useSessionOrg = create<State>((set, get) => ({
  collapsed: [],
  tagFilter: [],
  keyword: '',

  init: () => {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return
      const d = JSON.parse(raw) as { collapsed?: unknown; tagFilter?: unknown }
      set({
        collapsed: Array.isArray(d.collapsed) ? d.collapsed.map(String) : [],
        tagFilter: Array.isArray(d.tagFilter) ? d.tagFilter.map(String) : []
      })
    } catch {
      // ignore
    }
  },

  toggleGroup: (name) => {
    const cur = get().collapsed
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]
    set({ collapsed: next })
    persist({ collapsed: next, tagFilter: get().tagFilter })
  },
  isCollapsed: (name) => get().collapsed.includes(name),

  toggleTag: (tag) => {
    const cur = get().tagFilter
    const next = cur.includes(tag) ? cur.filter((x) => x !== tag) : [...cur, tag]
    set({ tagFilter: next })
    persist({ collapsed: get().collapsed, tagFilter: next })
  },
  clearTags: () => {
    set({ tagFilter: [] })
    persist({ collapsed: get().collapsed, tagFilter: [] })
  },

  setKeyword: (kw) => set({ keyword: kw })
}))

export interface SessionGroup {
  name: string
  sessions: Session[]
}

/** 收集全部标签并按使用次数降序，供左栏标签条展示 */
export function collectTags(sessions: Session[]): { tag: string; count: number }[] {
  const bucket = new Map<string, number>()
  for (const s of sessions) {
    for (const t of s.tags ?? []) bucket.set(t, (bucket.get(t) ?? 0) + 1)
  }
  return [...bucket.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'))
}

/** 收集已有分组名，供「移动到分组」下拉复用，避免用户重复手打 */
export function collectGroups(sessions: Session[]): string[] {
  const set = new Set<string>()
  for (const s of sessions) {
    const g = (s.group ?? '').trim()
    if (g) set.add(g)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * 按关键字与标签筛选后再按分组归类。
 *
 * 标签筛选取「与」语义：勾了两个标签只留同时带这两个标签的会话，
 * 因为标签常用来叠加维度（项目 + 环境），交集才是用户想要的结果。
 */
export function groupSessions(
  sessions: Session[],
  keyword: string,
  tagFilter: string[]
): SessionGroup[] {
  const kw = keyword.trim().toLowerCase()
  const filtered = sessions.filter((s) => {
    if (tagFilter.length > 0) {
      const tags = s.tags ?? []
      if (!tagFilter.every((t) => tags.includes(t))) return false
    }
    if (!kw) return true
    const hay = [
      s.name,
      s.group ?? '',
      (s.tags ?? []).join(' '),
      String(s.config.host ?? ''),
      String(s.config.url ?? ''),
      String(s.config.serialPath ?? ''),
      String(s.config.port ?? '')
    ]
      .join(' ')
      .toLowerCase()
    return hay.includes(kw)
  })

  const bucket = new Map<string, Session[]>()
  for (const s of filtered) {
    const g = (s.group ?? '').trim() || UNGROUPED
    const list = bucket.get(g)
    if (list) list.push(s)
    else bucket.set(g, [s])
  }

  // 具名分组按名称排序，「未分组」始终垫在最后
  const names = [...bucket.keys()].filter((n) => n !== UNGROUPED).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  if (bucket.has(UNGROUPED)) names.push(UNGROUPED)
  return names.map((name) => ({ name, sessions: bucket.get(name) ?? [] }))
}
