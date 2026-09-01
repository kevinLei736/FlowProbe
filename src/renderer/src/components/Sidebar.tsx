import { useMemo } from 'react'
import { useStore } from '../store/useStore'
import { KIND_META, MOD, STATUS_META, keyHint } from '../app/meta'
import { useLayout } from '../store/useLayout'
import { collectTags, groupSessions, useSessionOrg } from '../store/useSessionOrg'
import { useTabs } from '../store/useTabs'
import { btnQuiet, chip, chipOn, fieldSm, iconBtnSm } from './ui/tokens'

/**
 * 左侧会话栏。
 *
 * 这一版做了职责收窄：原来这里塞了主题切换、配置导入导出、看板/历史/搜索入口，
 * 那些都是「与当前会话无关的系统功能」，已上提到顶部菜单栏。
 * 左栏现在只做一件事——把会话找出来并切过去：新建、模糊筛选、标签交叉筛选、分组列表。
 *
 * 底部保留一排图标快捷入口，是因为看板/历史/搜索属于高频跳转，
 * 全靠菜单会多两次点击；用图标条而不是一排描边按钮，避免深色下连成白色网格。
 */
export function Sidebar({
  onNew,
  onTools,
  onApi,
  onMonitor,
  onAlerts,
  monitorUnread,
  alertUnread,
  onDashboard,
  onHistory,
  onSearch,
  onPalette
}: {
  onNew: () => void
  onTools: () => void
  onApi: () => void
  onMonitor: () => void
  onAlerts: () => void
  /** 巡检失败未读数。挂在图标上而不是弹窗，是因为巡检在后台跑，不该打断当前操作 */
  monitorUnread: number
  /** 告警未读数（报文告警 + 巡检失败合并计） */
  alertUnread: number
  onDashboard: () => void
  onHistory: () => void
  onSearch: () => void
  onPalette: () => void
}): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeId)
  const setActive = useStore((s) => s.setActive)
  const toggleSidebar = useLayout((s) => s.toggleSidebar)

  const keyword = useSessionOrg((s) => s.keyword)
  const setKeyword = useSessionOrg((s) => s.setKeyword)
  const tagFilter = useSessionOrg((s) => s.tagFilter)
  const toggleTag = useSessionOrg((s) => s.toggleTag)
  const clearTags = useSessionOrg((s) => s.clearTags)
  const collapsed = useSessionOrg((s) => s.collapsed)
  const toggleGroup = useSessionOrg((s) => s.toggleGroup)

  const tags = useMemo(() => collectTags(sessions), [sessions])
  const groups = useMemo(
    () => groupSessions(sessions, keyword, tagFilter),
    [sessions, keyword, tagFilter]
  )
  const shownCount = useMemo(() => groups.reduce((n, g) => n + g.sessions.length, 0), [groups])
  const filtering = keyword.trim().length > 0 || tagFilter.length > 0

  return (
    <aside style={styles.aside}>
      <div style={styles.top}>
        <button style={styles.newBtn} onClick={onNew} title={`新建连接 (${keyHint('Ctrl+N')})`}>
          <span style={styles.plus}>+</span>
          新建连接
        </button>
        <button
          className="menu-btn"
          style={{ ...iconBtnSm, ...styles.collapse }}
          title={`隐藏侧栏 (${keyHint('Ctrl+B')})`}
          aria-label="隐藏侧栏"
          onClick={toggleSidebar}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <button className="menu-btn" style={styles.palette} onClick={onPalette} title={`命令面板 (${keyHint('Ctrl+K')})`}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7.6 7.6L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span style={styles.paletteText}>搜索会话与命令</span>
        <span style={styles.kbd}>{keyHint('Ctrl K')}</span>
      </button>

      <div style={styles.filterRow}>
        <input
          style={{ ...fieldSm, flex: 1 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="筛选名称 / 分组 / 标签"
        />
        {filtering && (
          <button
            className="menu-btn"
            style={iconBtnSm}
            title="清除筛选"
            aria-label="清除筛选"
            onClick={() => {
              setKeyword('')
              clearTags()
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div style={styles.tagBar}>
          {tags.map((t) => {
            const on = tagFilter.includes(t.tag)
            return (
              <button
                key={t.tag}
                style={{ ...chip, ...styles.tagChip, ...(on ? chipOn : {}) }}
                title={on ? '取消筛选此标签' : '按此标签筛选'}
                onClick={() => toggleTag(t.tag)}
              >
                {t.tag}
                <span style={styles.tagCount}>{t.count}</span>
              </button>
            )
          })}
        </div>
      )}

      <div style={styles.list}>
        {sessions.length === 0 && <div style={styles.hint}>暂无会话</div>}
        {sessions.length > 0 && shownCount === 0 && (
          <div style={styles.hint}>没有符合筛选条件的会话</div>
        )}
        {groups.map((g) => {
          const isCollapsed = collapsed.includes(g.name)
          return (
            <div key={g.name} style={styles.groupBlock}>
              <button className="menu-btn" style={styles.groupHead} onClick={() => toggleGroup(g.name)}>
                <span style={styles.groupCaret}>{isCollapsed ? '▸' : '▾'}</span>
                <span style={styles.groupName}>{g.name}</span>
                <span style={styles.groupCount}>{g.sessions.length}</span>
              </button>
              {!isCollapsed &&
                g.sessions.map((s) => {
                  const meta = KIND_META[s.kind]
                  const status = STATUS_META[s.status]
                  return (
                    <button
                      key={s.id}
                      className="session-item"
                      style={{ ...styles.item, ...(s.id === activeId ? styles.itemActive : {}) }}
                      title={
                        s.id === activeId
                          ? s.name
                          : s.name + `（${MOD}+单击 / 双击固定为常驻标签）`
                      }
                      onClick={(e) => {
                        // Ctrl/⌘+单击 与双击都直接开常驻标签，对应编辑器里
                        // 「这个我要留着」的习惯；普通单击只占用预览槽位
                        if (e.ctrlKey || e.metaKey) useTabs.getState().ensure(s.id, true)
                        setActive(s.id)
                      }}
                      onDoubleClick={() => {
                        useTabs.getState().ensure(s.id, true)
                        useTabs.getState().pin(s.id)
                      }}
                    >
                      <span style={styles.itemIcon}>{meta.icon}</span>
                      <span style={styles.itemBody}>
                        <span style={styles.itemName}>{s.name}</span>
                        <span style={styles.itemKind}>
                          {meta.label}
                          {s.autoStart === true && <span style={styles.autoTag}>自动</span>}
                          {(s.tags ?? []).slice(0, 2).map((t) => (
                            <span key={t} style={styles.itemTag}>
                              {t}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span style={{ ...styles.dot, background: status.color }} title={status.label} />
                    </button>
                  )
                })}
            </div>
          )
        })}
      </div>

      <div style={styles.quickBar}>
        <QuickBtn label="数据看板" hint={keyHint('Ctrl+D')} onClick={onDashboard} d="M1.5 10.5V6M5.5 10.5V2.5M9.5 10.5V7.5" />
        <QuickBtn label="报文历史" hint={keyHint('Ctrl+H')} onClick={onHistory} d="M6 2.6a3.6 3.6 0 103.6 3.6M6 4.4V6.4l1.6 1" circle />
        <QuickBtn label="全局搜索" hint={keyHint('Ctrl+F')} onClick={onSearch} d="M7.4 7.4L10.4 10.4" circleAt="4.8,4.8,3.1" />
        <QuickBtn label="接口测试" onClick={onApi} d="M4 3L1.5 6L4 9M8 3l2.5 3L8 9" />
        <QuickBtn label="接口巡检" onClick={onMonitor} d="M6 2.2v2M6 6l2.4 1.5" circle badge={monitorUnread} />
        <QuickBtn label="告警中心" onClick={onAlerts} d="M6 1.9l4.4 7.8H1.6zM6 4.6v2.2M6 8.2v0.5" badge={alertUnread} />
        <QuickBtn label="工具箱" onClick={onTools} d="M1.8 9.2l4.4-4.4M8.6 1.6l1.8 1.8-2.4 2.4-1.8-1.8z" />
      </div>
    </aside>
  )
}

function QuickBtn({
  label,
  hint,
  onClick,
  d,
  circle,
  circleAt,
  badge
}: {
  label: string
  hint?: string
  onClick: () => void
  d: string
  circle?: boolean
  circleAt?: string
  /** > 0 时右上角出现红点。不显示数字：图标只有 12px，数字挤进去反而看不清 */
  badge?: number
}): JSX.Element {
  const c = circleAt?.split(',').map(Number)
  return (
    <button
      className="menu-btn"
      style={{ ...styles.quickBtn, position: 'relative' }}
      title={badge && badge > 0 ? `${label}（${badge} 次失败）` : hint ? `${label} (${hint})` : label}
      aria-label={label}
      onClick={onClick}
    >
      {badge !== undefined && badge > 0 && <span style={styles.badgeDot} />}
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {c && <circle cx={c[0]} cy={c[1]} r={c[2]} fill="none" stroke="currentColor" strokeWidth="1.2" />}
        {circle && <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.5" />}
        <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  aside: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--sidebar-bg)',
    backdropFilter: 'blur(var(--sidebar-blur))',
    WebkitBackdropFilter: 'blur(var(--sidebar-blur))',
    borderRight: '1px solid var(--border-subtle)',
    minWidth: 0,
    overflow: 'hidden'
  },
  top: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 8px' },
  // 常驻入口用柔和主操作而非最高对比的主按钮，见 tokens.ts 里 btnQuiet 的说明
  newBtn: {
    ...btnQuiet,
    flex: 1,
    minWidth: 0
  },
  plus: { fontSize: 14, lineHeight: 1, marginTop: -1 },
  badgeDot: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: 'var(--error)'
  },
  collapse: { flexShrink: 0, color: 'var(--text-2)' },
  palette: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    margin: '0 10px 8px',
    height: 'var(--control-h-sm)',
    padding: '0 8px',
    background: 'var(--bg-inset)',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-xs)',
    textAlign: 'left'
  },
  paletteText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  kbd: {
    flexShrink: 0,
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-3)'
  },
  filterRow: { display: 'flex', alignItems: 'center', gap: 5, margin: '0 10px 8px' },
  tagBar: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 5,
    padding: '0 10px 8px',
    maxHeight: 76,
    overflowY: 'auto'
  },
  tagChip: { height: 20, padding: '0 7px', fontSize: 'var(--fs-micro)' },
  tagCount: { fontFamily: 'var(--font-mono)', fontSize: 9, opacity: 0.65 },
  list: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px 6px' },
  hint: { color: 'var(--text-3)', fontSize: 'var(--fs-sm)', padding: '10px 8px' },
  groupBlock: { marginBottom: 5 },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    height: 24,
    padding: '0 8px',
    background: 'transparent',
    color: 'var(--text-3)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-micro)',
    letterSpacing: 0.5,
    textAlign: 'left'
  },
  groupCaret: { fontSize: 8, width: 8, flexShrink: 0 },
  groupName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textTransform: 'uppercase'
  },
  groupCount: { fontFamily: 'var(--font-mono)', fontSize: 9.5, flexShrink: 0 },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    padding: '7px 9px',
    marginBottom: 2,
    background: 'transparent',
    color: 'var(--text-0)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    textAlign: 'left'
  },
  itemActive: { background: 'var(--selected-bg)' },
  itemIcon: {
    width: 22,
    height: 22,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'var(--bg-inset)',
    borderRadius: 'var(--r-sm)',
    fontSize: 11,
    color: 'var(--text-1)',
    fontFamily: 'var(--font-mono)'
  },
  itemBody: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 1 },
  itemName: {
    fontSize: 'var(--fs-md)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  itemKind: {
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-3)',
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    overflow: 'hidden'
  },
  autoTag: {
    fontSize: 9,
    lineHeight: '13px',
    padding: '0 4px',
    color: 'var(--text-2)',
    background: 'var(--bg-inset)',
    borderRadius: 3,
    flexShrink: 0
  },
  itemTag: {
    fontSize: 9,
    lineHeight: '13px',
    padding: '0 4px',
    color: 'var(--text-2)',
    background: 'var(--bg-inset)',
    borderRadius: 3,
    flexShrink: 0,
    maxWidth: 54,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  dot: { width: 7, height: 7, borderRadius: 7, flexShrink: 0 },
  quickBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '6px 8px',
    borderTop: '1px solid var(--border-subtle)'
  },
  quickBtn: {
    flex: 1,
    height: 26,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-sm)'
  }
}
