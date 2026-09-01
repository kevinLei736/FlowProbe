import { create } from 'zustand'
import type { AlertEvent, AlertRule, ConnectionKind } from '@shared/protocol'
import { clearCooldown } from './cooldown'

const RULE_KEY = 'toolbox.alertRules.v1'
const EVENT_KEY = 'toolbox.alertEvents.v1'

/**
 * 告警事件留存上限。
 *
 * 只留 300 条：告警的用途是「出问题时把第一现场抓住」，不是长期审计——
 * 长期数据在报文历史库里。留太多会让 localStorage 写入变慢，
 * 而写入发生在收帧路径上，直接影响高吞吐时的界面流畅度。
 */
const MAX_EVENTS = 300

interface State {
  rules: AlertRule[]
  events: AlertEvent[]
  /** 未读告警数，用于左栏与菜单红点 */
  unread: number
  loaded: boolean

  load: () => void
  addRule: (kind?: ConnectionKind, sessionId?: string | null) => AlertRule
  updateRule: (id: string, patch: Partial<AlertRule>) => void
  removeRule: (id: string) => void
  duplicateRule: (id: string) => void
  pushEvents: (list: AlertEvent[]) => void
  clearEvents: () => void
  clearUnread: () => void
}

function rid(): string {
  return Math.random().toString(36).slice(2)
}

function persistRules(list: AlertRule[]): void {
  try {
    localStorage.setItem(RULE_KEY, JSON.stringify(list))
  } catch {
    // 写失败不该影响判定本身
  }
}

function persistEvents(list: AlertEvent[]): void {
  try {
    localStorage.setItem(EVENT_KEY, JSON.stringify(list.slice(0, MAX_EVENTS)))
  } catch {
    // 同上
  }
}

export function blankRule(kind?: ConnectionKind, sessionId?: string | null): AlertRule {
  return {
    id: rid(),
    name: '新告警规则',
    enabled: true,
    sessionId: sessionId ?? null,
    kinds: kind ? [kind] : [],
    direction: 'rx',
    source: 'field',
    templateId: 'auto',
    field: '',
    op: 'gt',
    value: '',
    value2: '',
    severity: 'warn',
    highlight: true,
    notify: true,
    stopSession: false,
    // 默认 30 秒冷却：高频链路上一条异常往往连着来几百条，
    // 不冷却会把通知和告警中心瞬间刷爆，第一条反而找不到
    cooldownSec: 30,
    hits: 0
  }
}

export const useAlerts = create<State>((set, get) => ({
  rules: [],
  events: [],
  unread: 0,
  loaded: false,

  load: () => {
    if (get().loaded) return
    let rules: AlertRule[] = []
    let events: AlertEvent[] = []
    try {
      const r = localStorage.getItem(RULE_KEY)
      if (r) rules = JSON.parse(r) as AlertRule[]
    } catch {
      // 解析失败按空处理
    }
    try {
      const e = localStorage.getItem(EVENT_KEY)
      if (e) events = JSON.parse(e) as AlertEvent[]
    } catch {
      // 同上
    }
    /*
      恢复时清掉 lastFiredAt：冷却是「这一次运行期间别刷屏」的机制。
      跨重启还保留会出现「刚启动就被上次的冷却挡住」，用户以为规则失效了。
    */
    set({ rules: rules.map((r) => ({ ...r, lastFiredAt: undefined })), events, loaded: true })
  },

  addRule: (kind, sessionId) => {
    const r = blankRule(kind, sessionId)
    const list = [...get().rules, r]
    persistRules(list)
    set({ rules: list })
    return r
  },

  updateRule: (id, patch) => {
    const list = get().rules.map((r) => (r.id === id ? { ...r, ...patch } : r))
    persistRules(list)
    set({ rules: list })
    /*
      改完规则清掉冷却。否则用户把阈值从 80 调到 20，报文明显超标却不报警——
      实际是上一次命中的冷却还没过，这是最容易被误判成 bug 的现象。
      只有纯统计字段的写入（markFired）走 setState，不经过这里，所以不会互相打断。
    */
    if (patch.hits === undefined && patch.lastFiredAt === undefined) clearCooldown(id)
  },

  removeRule: (id) => {
    const list = get().rules.filter((r) => r.id !== id)
    persistRules(list)
    set({ rules: list })
    clearCooldown(id)
  },

  duplicateRule: (id) => {
    const src = get().rules.find((r) => r.id === id)
    if (!src) return
    const copy: AlertRule = { ...src, id: rid(), name: src.name + ' 副本', hits: 0, lastFiredAt: undefined }
    const list = [...get().rules, copy]
    persistRules(list)
    set({ rules: list })
  },

  pushEvents: (list) => {
    if (list.length === 0) return
    const events = [...list.slice().reverse(), ...get().events].slice(0, MAX_EVENTS)
    persistEvents(events)
    set((s) => ({ events, unread: s.unread + list.length }))
  },

  clearEvents: () => {
    persistEvents([])
    set({ events: [], unread: 0 })
  },

  clearUnread: () => set({ unread: 0 })
}))

/**
 * 命中后更新规则统计并写入冷却时间。
 *
 * 单独抽出来而不是塞进 pushEvents：统计要按规则逐条累加，
 * 而事件是批量落档的，两件事的粒度不同，混在一起容易漏计。
 */
export function markFired(ruleIds: string[], at: number): void {
  if (ruleIds.length === 0) return
  const { rules } = useAlerts.getState()
  const counts = new Map<string, number>()
  for (const id of ruleIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const list = rules.map((r) =>
    counts.has(r.id) ? { ...r, hits: (r.hits ?? 0) + (counts.get(r.id) ?? 0), lastFiredAt: at } : r
  )
  persistRules(list)
  useAlerts.setState({ rules: list })
}
