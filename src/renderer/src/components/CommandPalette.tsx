import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { useTheme, type ThemeMode } from '../store/useTheme'
import { useLayout } from '../store/useLayout'
import { templateFitsKind, useProtoTemplates } from '../store/useProtoTemplates'
import { collectGroups, collectTags, useSessionOrg } from '../store/useSessionOrg'
import { KIND_CAPS, KIND_META, STATUS_META, keyHint } from '../app/meta'

export interface PaletteActions {
  onNew: () => void
  onTools: () => void
  onApi: () => void
  onMonitor: () => void
  onAlerts: () => void
  onMarks: () => void
  onDashboard: () => void
  onHistory: () => void
  onSearch: () => void
  onGuide: () => void
  onUpdate: () => void
}

interface Command {
  id: string
  title: string
  hint?: string
  group: string
  keywords: string
  run: () => void
}

/** 简易模糊匹配：按顺序命中字符即算匹配，连续命中得分更高 */
function fuzzy(text: string, query: string): { hit: boolean; score: number } {
  if (!query) return { hit: true, score: 0 }
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return { hit: false, score: 0 }
    streak = found === ti ? streak + 1 : 0
    score += 10 + streak * 6 - Math.min(found - ti, 8)
    ti = found + 1
  }
  if (t.startsWith(q)) score += 30
  if (t.includes(q)) score += 18
  return { hit: true, score }
}

export function CommandPalette({
  actions,
  onClose
}: {
  actions: PaletteActions
  onClose: () => void
}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const setActive = useStore((s) => s.setActive)
  const activeId = useStore((s) => s.activeId)
  const start = useStore((s) => s.start)
  const stop = useStore((s) => s.stop)
  const remove = useStore((s) => s.remove)
  const clearFrames = useStore((s) => s.clearFrames)
  const duplicateSession = useStore((s) => s.duplicateSession)
  const setAutoStart = useStore((s) => s.setAutoStart)
  const updateHttpMock = useStore((s) => s.updateHttpMock)
  const protoTemplates = useProtoTemplates((s) => s.templates)
  const protoSel = useProtoTemplates((s) => s.selBySession)
  const selectProto = useProtoTemplates((s) => s.select)
  const setSessionMeta = useStore((s) => s.setSessionMeta)
  const setThemeMode = useTheme((s) => s.setMode)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)
  const toggleInspector = useLayout((s) => s.toggleInspector)
  const tagFilter = useSessionOrg((s) => s.tagFilter)
  const toggleTagFilter = useSessionOrg((s) => s.toggleTag)
  const clearTagFilter = useSessionOrg((s) => s.clearTags)

  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []

    for (const s of sessions) {
      const meta = KIND_META[s.kind]
      const status = STATUS_META[s.status]
      list.push({
        id: 'go:' + s.id,
        title: s.name,
        hint: meta.label + ' · ' + status.label,
        group: '跳转会话',
        keywords: [s.name, meta.label, meta.group, s.config.host ?? '', s.config.url ?? '', s.config.serialPath ?? '', String(s.config.port ?? '')].join(' '),
        run: () => setActive(s.id)
      })
    }

    list.push(
      { id: 'new', title: '新建连接', hint: 'Ctrl+N', group: '操作', keywords: 'new create 新建 连接 会话 tcp ws serial mock', run: actions.onNew },
      { id: 'api', title: '打开 HTTP 接口测试', group: '操作', keywords: 'api http 接口 测试 request 请求 postman', run: actions.onApi },
    { id: 'monitor', title: '打开接口巡检', group: '操作', keywords: 'monitor 巡检 定时 监控 轮询 schedule cron', run: actions.onMonitor },
    { id: 'alerts', title: '打开告警中心', group: '操作', keywords: 'alert 告警 阈值 断言 assert 通知 warning 报警', run: actions.onAlerts },
      { id: 'dashboard', title: '打开数据看板', hint: 'Ctrl+D', group: '操作', keywords: 'dashboard 看板 可视化 图表 统计 吞吐 chart metrics', run: actions.onDashboard },
      { id: 'history', title: '打开历史记录', hint: 'Ctrl+H', group: '操作', keywords: 'history 历史 归档 数据库 sqlite 检索 查询 报文', run: actions.onHistory },
      { id: 'search', title: '全局搜索历史报文', hint: 'Ctrl+F', group: '操作', keywords: 'search 搜索 查找 全局 关键字 grep find 报文 请求', run: actions.onSearch },
      { id: 'marks', title: '打开报文标注与书签', hint: 'Ctrl+M', group: '操作', keywords: 'mark bookmark 标注 书签 备注 note 星标 收藏 记录', run: actions.onMarks },
    { id: 'tools', title: '打开工具箱', group: '操作', keywords: 'tools 工具箱 编码 转换 crc hex base64', run: actions.onTools },
      // 文档也进命令面板：不知道某个功能在哪个菜单里时，Ctrl+K 搜「文档」「帮助」是最短路径
      { id: 'guide', title: '打开使用文档', hint: 'F1', group: '操作', keywords: 'guide doc docs help 文档 使用 手册 帮助 说明 教程 怎么用 readme', run: actions.onGuide },
      { id: 'update', title: '检查更新', group: '操作', keywords: 'update upgrade 更新 升级 新版本 version 版本 检查', run: actions.onUpdate }
    )

    const active = sessions.find((s) => s.id === activeId)
    if (active) {
      const running = active.status === 'connected' || active.status === 'listening' || active.status === 'connecting'
      list.push(
        {
          id: 'toggle-run',
          title: running ? '停止当前会话' : '启动当前会话',
          hint: active.name,
          group: '当前会话',
          keywords: 'start stop 启动 停止 连接 断开 ' + active.name,
          run: () => (running ? stop(active.id) : start(active.id))
        },
        {
          id: 'clear',
          title: '清空当前会话报文',
          hint: active.name,
          group: '当前会话',
          keywords: 'clear 清空 清屏 日志 报文',
          run: () => clearFrames(active.id)
        },
        {
          id: 'duplicate',
          title: '复制当前会话',
          hint: active.name,
          group: '当前会话',
          keywords: 'duplicate copy 复制 克隆 副本',
          run: () => void duplicateSession(active.id)
        },
        {
          id: 'autostart',
          title: active.autoStart ? '取消自动连接' : '设为下次自动连接',
          hint: active.name,
          group: '当前会话',
          keywords: 'autostart 自动 启动 开机 恢复 保存',
          run: () => setAutoStart(active.id, active.autoStart !== true)
        },
        {
          id: 'remove',
          title: '删除当前会话',
          hint: active.name,
          group: '当前会话',
          keywords: 'delete remove 删除 关闭 移除',
          run: () => remove(active.id)
        }
      )
    }

    // 分组归属与标签筛选：会话一多就靠这两组命令定位
    if (active) {
      const curGroup = (active.group ?? '').trim()
      for (const g of collectGroups(sessions)) {
        if (g === curGroup) continue
        list.push({
          id: 'move-group:' + g,
          title: '移动到分组：' + g,
          hint: active.name,
          group: '分组',
          keywords: 'group move 分组 移动 归类 ' + g,
          run: () => setSessionMeta(active.id, { group: g })
        })
      }
      if (curGroup) {
        list.push({
          id: 'move-group-none',
          title: '移出分组',
          hint: active.name,
          group: '分组',
          keywords: 'group 移出 取消 分组 未分组',
          run: () => setSessionMeta(active.id, { group: '' })
        })
      }
    }

    for (const t of collectTags(sessions)) {
      const on = tagFilter.includes(t.tag)
      list.push({
        id: 'tag:' + t.tag,
        title: (on ? '取消标签筛选：' : '按标签筛选：') + t.tag,
        hint: t.count + ' 个会话',
        group: '标签',
        keywords: 'tag 标签 筛选 过滤 ' + t.tag,
        run: () => toggleTagFilter(t.tag)
      })
    }
    if (tagFilter.length > 0) {
      list.push({
        id: 'tag-clear',
        title: '清除全部标签筛选',
        group: '标签',
        keywords: 'tag 标签 清除 重置 全部',
        run: clearTagFilter
      })
    }

    // 协议解析模板切换：按能力矩阵判断，并且只列适用于该模块的模板
    if (active && KIND_CAPS[active.kind].protoTemplate) {
      const cur = protoSel[active.id] ?? ''
      const entries: Array<[string, string]> = [
        ['', '关闭协议解析'],
        ['auto', '协议解析：自动匹配'],
        ...protoTemplates
          .filter((t) => templateFitsKind(t, active.kind))
          .map((t) => [t.id, '协议解析：' + t.name] as [string, string])
      ]
      for (const [id, title] of entries) {
        if (cur === id) continue
        list.push({
          id: 'proto:' + (id || 'off'),
          title,
          hint: active.name,
          group: '协议解析',
          keywords: 'proto parse 协议 解析 模板 字段 ' + title,
          run: () => selectProto(active.id, id)
        })
      }
    }

    // Mock 场景切换：只在当前会话是 http-mock 且配了场景时出现
    if (active && active.kind === 'http-mock') {
      const cfg = active.config.httpMock
      const scenarios = cfg?.scenarios ?? []
      if (cfg && scenarios.length > 0) {
        const entries: Array<[string | undefined, string]> = [
          [undefined, '默认场景（无覆盖）'],
          ...scenarios.map((s) => [s.id, s.name] as [string, string])
        ]
        for (const [id, name] of entries) {
          if ((cfg.activeScenarioId ?? undefined) === id) continue
          list.push({
            id: 'mock-scenario:' + (id ?? 'default'),
            title: '切到 Mock 场景：' + name,
            hint: active.name,
            group: 'Mock 场景',
            keywords: 'mock scenario 场景 切换 ' + name,
            run: () => updateHttpMock(active.id, { ...cfg, activeScenarioId: id })
          })
        }
      }
    }

    list.push(
      { id: 'sb', title: '切换左侧栏', hint: 'Ctrl+B', group: '界面', keywords: 'sidebar 侧栏 隐藏 显示 折叠', run: toggleSidebar },
      { id: 'insp', title: '切换右侧检查器', hint: 'Ctrl+J', group: '界面', keywords: 'inspector 检查器 右栏 隐藏 显示', run: toggleInspector }
    )

    const themes: Array<[ThemeMode, string]> = [
      ['system', '主题：跟随系统'],
      ['light', '主题：浅色'],
      ['dark', '主题：深色']
    ]
    for (const [mode, title] of themes) {
      list.push({
        id: 'theme:' + mode,
        title,
        group: '界面',
        keywords: 'theme 主题 ' + mode + ' 深色 浅色 跟随系统 dark light',
        run: () => setThemeMode(mode)
      })
    }

    return list
  }, [sessions, activeId, actions, setActive, start, stop, remove, clearFrames, duplicateSession, setAutoStart, setSessionMeta, updateHttpMock, protoTemplates, protoSel, selectProto, tagFilter, toggleTagFilter, clearTagFilter, toggleSidebar, toggleInspector, setThemeMode])

  const results = useMemo(() => {
    const scored = commands
      .map((c) => {
        const byTitle = fuzzy(c.title, query)
        const byKeyword = fuzzy(c.keywords, query)
        const hit = byTitle.hit || byKeyword.hit
        return { cmd: c, hit, score: Math.max(byTitle.score * 1.5, byKeyword.score) }
      })
      .filter((r) => r.hit)
    if (query) scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 40).map((r) => r.cmd)
  }, [commands, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-cursor="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, results])

  const accept = (index: number): void => {
    const cmd = results[index]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (results.length ? (c + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (results.length ? (c - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      accept(cursor)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  let lastGroup = ''

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          style={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索会话、命令、主题…"
        />
        <div style={styles.list} ref={listRef}>
          {results.length === 0 && <div style={styles.empty}>没有匹配项</div>}
          {results.map((c, i) => {
            const showGroup = c.group !== lastGroup
            lastGroup = c.group
            return (
              <div key={c.id}>
                {showGroup && <div style={styles.group}>{c.group}</div>}
                <div
                  data-cursor={i === cursor ? '1' : '0'}
                  style={{ ...styles.row, ...(i === cursor ? styles.rowActive : {}) }}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => accept(i)}
                >
                  <span style={styles.rowTitle}>{c.title}</span>
                  {c.hint && <span style={styles.rowHint}>{keyHint(c.hint)}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div style={styles.footer}>↑↓ 选择 · Enter 执行 · Esc 关闭</div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh', zIndex: 60 },
  panel: { width: 'min(620px, 92vw)', maxHeight: '64vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  input: { padding: '13px 16px', background: 'transparent', color: 'var(--text-0)', border: 'none', borderBottom: '1px solid var(--border-subtle)', fontSize: 'var(--fs-lg)', outline: 'none', fontFamily: 'inherit', boxShadow: 'none' },
  list: { flex: 1, overflowY: 'auto', padding: '6px 0' },
  group: { padding: '8px 16px 4px', fontSize: 'var(--fs-micro)', color: 'var(--text-2)', letterSpacing: 0.5, textTransform: 'uppercase' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px', fontSize: 'var(--fs-md)', cursor: 'pointer' },
  rowActive: { background: 'var(--selected-bg)' },
  rowTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowHint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', flexShrink: 0 },
  empty: { padding: '18px 16px', fontSize: 'var(--fs-sm)', color: 'var(--text-2)' },
  footer: { padding: '7px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }
}
