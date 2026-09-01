import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WindowState } from '@shared/protocol'
import { IS_MAC, keyHint } from '../../app/meta'
import { Logo } from '../Logo'
import type { MenuGroup, MenuItem } from './menuModel'

/**
 * 顶部菜单栏 + 自绘标题栏。
 *
 * 为什么要自绘：为了让窗口能最大化，必须放弃 `transparent: true`
 * （Windows 下透明窗口走分层窗口路径，Electron 会连带关掉最大化能力），
 * 改用 `titleBarStyle: 'hidden'` + 亚克力背景。系统标题栏因此消失，
 * 拖拽区、最小化/最大化/关闭按钮都要自己画。
 *
 * 交互细节（都是踩过的坑）：
 * - 整条栏是 `-webkit-app-region: drag`，但菜单按钮与窗口按钮必须显式 no-drag，
 *   否则点不动。
 * - 菜单打开后鼠标滑过相邻菜单直接切换（跟随式），符合桌面应用习惯。
 * - 下拉用 fixed 定位 + 实测按钮位置，避免被父容器 overflow 裁掉。
 *
 * macOS 差异：系统红绿灯按钮由 titleBarStyle: 'hiddenInset' 保留，因此
 * 这里不能再画自己的三个窗口按钮（会重复），并且要给左侧让出红绿灯占用的宽度，
 * 否则 Logo 会被压住。平台判断用 preload 同步传下来的 platform，
 * 避免异步 IPC 造成首帧按钮闪现。
 */
/** 红绿灯按钮 + trafficLightPosition.x 的实测占位宽度 */
const MAC_TRAFFIC_LIGHT_WIDTH = 74

export function MenuBar({
  groups,
  title,
  subtitle
}: {
  groups: MenuGroup[]
  title: string
  subtitle?: string
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const [win, setWin] = useState<WindowState>({ maximized: false, fullScreen: false, focused: true })
  const barRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [anchor, setAnchor] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  useEffect(() => {
    window.toolbox.windowState().then(setWin)
    return window.toolbox.onWindowState(setWin)
  }, [])

  // 点击别处或按 Esc 收起菜单
  useEffect(() => {
    if (!openId) return
    const onDown = (e: MouseEvent): void => {
      if (!barRef.current?.contains(e.target as Node)) setOpenId(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openId])

  // 菜单按钮位置在布局后才准确，用 layout effect 读，避免首帧偏移
  useLayoutEffect(() => {
    if (!openId) return
    const el = btnRefs.current[openId]
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ left: r.left, top: r.bottom + 4 })
  }, [openId])

  const activeGroup = groups.find((g) => g.id === openId) ?? null

  return (
    <div
      ref={barRef}
      className="drag-region"
      style={{ ...styles.bar, paddingLeft: IS_MAC ? MAC_TRAFFIC_LIGHT_WIDTH : styles.bar.paddingLeft }}
    >
      <div className="no-drag" style={styles.brand}>
        <Logo size={16} />
      </div>

      <nav className="no-drag" style={styles.menus}>
        {groups.map((g) => (
          <button
            key={g.id}
            ref={(el) => {
              btnRefs.current[g.id] = el
            }}
            className="menu-btn"
            style={{ ...styles.menuBtn, ...(openId === g.id ? styles.menuBtnOn : {}) }}
            onClick={() => setOpenId((v) => (v === g.id ? null : g.id))}
            onMouseEnter={() => {
              if (openId) setOpenId(g.id)
            }}
          >
            {g.label}
          </button>
        ))}
      </nav>

      <div style={styles.titleZone}>
        <span style={styles.title}>{title}</span>
        {subtitle && <span style={styles.subtitle}>{subtitle}</span>}
      </div>

      {!IS_MAC && (
      <div className="no-drag" style={styles.winBtns}>
        <button
          className="win-btn"
          style={styles.winBtn}
          title="最小化"
          aria-label="最小化"
          onClick={() => window.toolbox.windowMinimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="4.6" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="win-btn"
          style={styles.winBtn}
          title={win.maximized ? '向下还原' : '最大化'}
          aria-label={win.maximized ? '向下还原' : '最大化'}
          onClick={() => window.toolbox.windowToggleMaximize()}
        >
          {win.maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M3 3V1.5h5.5V7H7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="win-btn win-btn-close"
          style={styles.winBtn}
          title="关闭"
          aria-label="关闭"
          onClick={() => window.toolbox.windowClose()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
      )}

      {activeGroup && (
        <div
          className="no-drag"
          style={{ ...styles.dropdown, left: anchor.left, top: anchor.top }}
          role="menu"
        >
          {activeGroup.items.map((it, i) => (
            <Row key={i} item={it} onRun={() => setOpenId(null)} />
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ item, onRun }: { item: MenuItem; onRun: () => void }): JSX.Element {
  const [hover, setHover] = useState(false)
  if (item.sep) return <div style={styles.sep} />
  const disabled = item.disabled === true
  return (
    <button
      role="menuitem"
      disabled={disabled}
      style={{
        ...styles.item,
        ...(hover && !disabled ? styles.itemHover : {}),
        ...(item.danger ? styles.itemDanger : {})
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        if (disabled) return
        item.run?.()
        onRun()
      }}
    >
      <span style={styles.tick}>{item.checked ? '✓' : item.radio ? '•' : ''}</span>
      <span style={styles.itemLabel}>{item.label}</span>
      {item.hint && <span style={styles.itemHint}>{keyHint(item.hint)}</span>}
    </button>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    height: 36,
    flexShrink: 0,
    paddingLeft: 10,
    background: 'var(--titlebar-bg)',
    borderBottom: '1px solid var(--border-subtle)',
    zIndex: 80
  },
  brand: { display: 'grid', placeItems: 'center', width: 22, height: 22, marginRight: 6 },
  menus: { display: 'flex', alignItems: 'center', gap: 1 },
  menuBtn: {
    height: 24,
    padding: '0 9px',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)'
  },
  menuBtnOn: { background: 'var(--selected-bg)', color: 'var(--text-0)' },
  titleZone: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '0 12px',
    overflow: 'hidden'
  },
  title: {
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  subtitle: {
    fontSize: 'var(--fs-xs)',
    color: 'var(--text-3)',
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  },
  winBtns: { display: 'flex', alignItems: 'stretch', height: 36, marginLeft: 'auto' },
  winBtn: {
    width: 44,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    borderRadius: 0
  },
  dropdown: {
    position: 'fixed',
    minWidth: 218,
    padding: 5,
    background: 'var(--menu-bg)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-lg)',
    boxShadow: 'var(--shadow-md)',
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    zIndex: 90
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    height: 28,
    padding: '0 8px',
    background: 'transparent',
    color: 'var(--text-0)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    fontSize: 'var(--fs-sm)',
    textAlign: 'left'
  },
  itemHover: { background: 'var(--selected-bg)' },
  itemDanger: { color: 'var(--error)' },
  tick: {
    width: 12,
    flexShrink: 0,
    fontSize: 10,
    color: 'var(--text-1)',
    textAlign: 'center'
  },
  itemLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemHint: {
    flexShrink: 0,
    fontSize: 'var(--fs-micro)',
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-3)'
  },
  sep: { height: 1, margin: '5px 6px', background: 'var(--border-subtle)' }
}
