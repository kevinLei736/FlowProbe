import { useEffect, useRef, useState } from 'react'
import type { Session } from '@shared/protocol'
import { KIND_META, STATUS_META, keyHint } from '../../app/meta'
import { surface } from '../../components/ui/tokens'

/** 标签拖拽的自定义 MIME。报文区靠它区分「标签」与「外部文件」两种拖入 */
export const TAB_MIME = 'application/x-toolbox-tab'

/**
 * 中栏标签条。
 *
 * 解决的问题：以前中栏一次只能显示一个会话，切换必须回左栏长列表里找。
 * 排查「A 设备正常 B 设备异常」这类问题时在两三个会话之间来回跳，
 * 每次都要重新定位，而左栏还可能正被筛选条件收窄着。
 *
 * 交互沿用浏览器与编辑器的既有肌肉记忆，不自创手势：
 * 单击切换、中键关闭、双击把预览标签钉成常驻、拖拽排序、右键出菜单。
 * 预览标签（斜体）是为了避免「点一下就多一个标签」的爆炸：左栏随手点开的
 * 会话共用同一个槽位反复替换，明确表达要留下时才提升为常驻。
 */
export function SessionTabs({
  sessions,
  activeId,
  previewId,
  sidebarVisible,
  onShowSidebar,
  onSelect,
  onPin,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onReorder,
  onNew,
  splitId,
  onSplit,
  onSwapSplit
}: {
  sessions: Session[]
  activeId: string | null
  previewId: string | null
  sidebarVisible: boolean
  onShowSidebar: () => void
  onSelect: (id: string) => void
  onPin: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseRight: (id: string) => void
  onCloseAll: () => void
  onReorder: (from: number, to: number) => void
  onNew: () => void
  /** 当前被放到右半区的会话 id，用于给标签打分屏标记 */
  splitId: string | null
  /** 传 null 表示退出分屏 */
  onSplit: (id: string | null) => void
  onSwapSplit: () => void
}): JSX.Element {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const dragFrom = useRef<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  // 激活的标签滚进可视区。标签条会横向溢出，靠 Ctrl+Tab 切到屏幕外的标签时
  // 如果不主动滚动，看起来就像「什么都没发生」
  useEffect(() => {
    if (!activeId) return
    const el = stripRef.current?.querySelector('[data-tab="' + activeId + '"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, sessions.length])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    // 捕获阶段监听：右键菜单要在任何点击落到下层控件之前先收起
    window.addEventListener('mousedown', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  return (
    <div style={st.bar}>
      {!sidebarVisible && (
        <button
          className="menu-btn"
          style={st.lead}
          title={`显示侧栏 (${keyHint('Ctrl+B')})`}
          aria-label="显示侧栏"
          onClick={onShowSidebar}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <path d="M2 3.5h9M2 6.5h9M2 9.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      )}

      <div
        style={st.strip}
        ref={stripRef}
        role="tablist"
        onWheel={(e) => {
          // 标签条是横向溢出容器，而鼠标滚轮给的是 deltaY。
          // 不转译的话滚轮在标签上完全没反应，加上我们又刻意隐藏了滚动条，
          // 用户会以为溢出的标签根本到不了。
          const el = stripRef.current
          if (!el || el.scrollWidth <= el.clientWidth) return
          e.preventDefault()
          el.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX
        }}
      >
        {sessions.map((s, i) => {
          const on = s.id === activeId
          const preview = s.id === previewId
          const split = s.id === splitId
          const status = STATUS_META[s.status]
          return (
            <div
              key={s.id}
              data-tab={s.id}
              role="tab"
              aria-selected={on}
              title={s.name + ' · ' + KIND_META[s.kind].label + ' · ' + status.label}
              draggable
              style={{
                ...st.tab,
                ...(on ? st.tabOn : {}),
                ...(split ? st.tabSplit : {}),
                ...(dropAt === i ? st.tabDrop : {})
              }}
              onMouseDown={(e) => {
                if (e.button === 0) onSelect(s.id)
                // 中键关闭要在 mousedown 拦掉：middle-click 默认会触发自动滚动模式
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(s.id)
                }
              }}
              onDoubleClick={() => onPin(s.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id: s.id, x: e.clientX, y: e.clientY })
              }}
              onDragStart={(e) => {
                dragFrom.current = i
                e.dataTransfer.effectAllowed = 'move'
                // Firefox 之外的浏览器不设置数据也能拖，但设一个空值更稳
                e.dataTransfer.setData('text/plain', s.id)
                // 自定义类型：拖到报文区右半边要能识别「这是一个标签」而不是外部文件。
                // dragover 阶段读不到 data，只能读 types，所以标识必须放在类型名里。
                e.dataTransfer.setData(TAB_MIME, s.id)
              }}
              onDragOver={(e) => {
                if (dragFrom.current === null) return
                e.preventDefault()
                setDropAt(i)
              }}
              onDragEnd={() => {
                dragFrom.current = null
                setDropAt(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragFrom.current
                dragFrom.current = null
                setDropAt(null)
                if (from !== null) onReorder(from, i)
              }}
            >
              <span style={{ ...st.dot, background: status.color }} />
              <span style={{ ...st.name, ...(preview ? st.namePreview : {}) }}>{s.name}</span>
              {split && (
                <span style={st.splitTag} title="正在右半区显示">
                  ⇥
                </span>
              )}
              <span
                className="menu-btn"
                style={st.close}
                role="button"
                aria-label={'关闭 ' + s.name}
                title="关闭标签"
                onMouseDown={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  onClose(s.id)
                }}
              >
                <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
                  <path d="M1.4 1.4l6.2 6.2M7.6 1.4L1.4 7.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </span>
            </div>
          )
        })}
      </div>

      <button className="menu-btn" style={st.add} title={`新建连接 (${keyHint('Ctrl+N')})`} aria-label="新建连接" onClick={onNew}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 2.2v7.6M2.2 6h7.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>

      {menu && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          canPin={menu.id === previewId}
          isSplit={menu.id === splitId}
          hasSplit={splitId !== null}
          onSplit={() => onSplit(menu.id === splitId ? null : menu.id)}
          onSwapSplit={onSwapSplit}
          onPin={() => onPin(menu.id)}
          onClose={() => onClose(menu.id)}
          onCloseOthers={() => onCloseOthers(menu.id)}
          onCloseRight={() => onCloseRight(menu.id)}
          onCloseAll={onCloseAll}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}

/** 标签右键菜单。定位用 fixed 并做右下边界翻转，靠窗口边缘时不至于被裁掉 */
function TabMenu({
  x,
  y,
  canPin,
  isSplit,
  hasSplit,
  onSplit,
  onSwapSplit,
  onPin,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onDismiss
}: {
  x: number
  y: number
  canPin: boolean
  isSplit: boolean
  hasSplit: boolean
  onSplit: () => void
  onSwapSplit: () => void
  onPin: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onCloseAll: () => void
  onDismiss: () => void
}): JSX.Element {
  const rows: Array<{ label: string; run: () => void } | 'sep'> = [
    ...(canPin ? ([{ label: '固定此标签', run: onPin }, 'sep'] as const) : []),
    { label: isSplit ? '退出分屏' : '在右侧打开', run: onSplit },
    ...(hasSplit ? [{ label: '左右互换', run: onSwapSplit }] : []),
    'sep',
    { label: '关闭', run: onClose },
    { label: '关闭其他标签', run: onCloseOthers },
    { label: '关闭右侧标签', run: onCloseRight },
    'sep',
    { label: '全部关闭', run: onCloseAll }
  ]
  // 菜单高度按实际行数算，否则靠窗口下边缘时翻转位置会算错
  const W = 168
  const H = rows.reduce((acc, r) => acc + (r === 'sep' ? 7 : 28), 8)
  const left = Math.min(x, window.innerWidth - W - 8)
  const top = Math.min(y, window.innerHeight - H - 8)
  return (
    <div style={{ ...surface, ...st.menu, left, top, width: W }} onMouseDown={(e) => e.stopPropagation()}>
      {rows.map((r, i) =>
        r === 'sep' ? (
          <div key={'s' + i} style={st.menuSep} />
        ) : (
          <button
            key={r.label}
            className="menu-btn"
            style={st.menuItem}
            onClick={() => {
              r.run()
              onDismiss()
            }}
          >
            {r.label}
          </button>
        )
      )}
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
    height: 34,
    padding: '0 6px',
    background: 'var(--bg-inset)',
    borderBottom: '1px solid var(--border-subtle)'
  },
  lead: {
    flexShrink: 0,
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-sm)'
  },
  // scrollbarWidth:none —— 标签条只有 34px 高，横向滚动条会吃掉三分之一，
  // 溢出时靠滚轮与激活标签自动滚入解决，不显示条
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flex: 1,
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollbarWidth: 'none'
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    maxWidth: 190,
    height: 26,
    padding: '0 6px 0 9px',
    borderRadius: 'var(--r-sm)',
    color: 'var(--text-2)',
    fontSize: 'var(--fs-sm)',
    userSelect: 'none',
    cursor: 'default'
  },
  // 选中态用「浮起实底 + 描边 + 亮字」三通道，和工具箱页签一套口径
  tabOn: {
    background: 'var(--bg-0)',
    color: 'var(--text-0)',
    border: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-sm)',
    padding: '0 5px 0 8px',
    fontWeight: 500
  },
  tabDrop: { background: 'var(--selected-bg)' },
  // 分屏侧标签只加底色不加边框：深色主题下描边会显成白框
  tabSplit: { background: 'var(--selected-bg)', color: 'var(--text-1)' },
  splitTag: { flexShrink: 0, fontSize: 'var(--fs-micro)', color: 'var(--accent)' },
  dot: { width: 6, height: 6, borderRadius: 6, flexShrink: 0 },
  name: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  },
  namePreview: { fontStyle: 'italic' },
  close: {
    flexShrink: 0,
    width: 16,
    height: 16,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 'var(--r-xs)',
    color: 'var(--text-3)'
  },
  add: {
    flexShrink: 0,
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-sm)'
  },
  menu: {
    position: 'fixed',
    zIndex: 120,
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 1
  },
  menuItem: {
    height: 28,
    padding: '0 9px',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-sm)',
    textAlign: 'left'
  },
  menuSep: { height: 1, margin: '3px 6px', background: 'var(--border-subtle)' }
}
