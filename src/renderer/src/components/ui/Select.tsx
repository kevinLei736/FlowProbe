import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactNode } from 'react'

/**
 * 调用方能控制的样式键。
 *
 * 只放行「尺寸与排布」，外观（底色、描边、圆角、内距、高度）一律由令牌决定。
 * 这是有意的收紧：项目里遗留了十几个各写一份 padding/background 的
 * select 样式对象，直接透传会让每个下拉框长得都不一样，
 * 而这正是要修的问题本身。需要破例时用 unsafeStyle。
 */
const LAYOUT_KEYS = [
  'width',
  'minWidth',
  'maxWidth',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'justifySelf',
  'gridColumn',
  'gridRow',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'fontFamily'
] as const

function pickLayout(style?: CSSProperties): CSSProperties {
  if (!style) return {}
  const out: Record<string, unknown> = {}
  for (const k of LAYOUT_KEYS) {
    const v = (style as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return out as CSSProperties
}

export interface SelectOption {
  value: string
  label: ReactNode
  /** 搜索与首字母跳转用的纯文本。label 是 ReactNode 时必须给 */
  text?: string
  disabled?: boolean
  /** 分组标题。相邻同名项归为一组 */
  group?: string
}

/**
 * 自绘下拉框。
 *
 * 为什么不用原生 `<select>`：展开后的候选列表由操作系统绘制，CSS 只能改
 * `option` 的底色和字色，圆角、阴影、行高、内距、选中勾选标记一律管不到。
 * 深色主题下 Windows 还会给列表加一圈系统边框，与应用其余部分完全不是一套。
 * 要让下拉列表和其他浮层（命令面板、菜单、弹窗）风格一致，只能自己画。
 *
 * 两个关键实现决定：
 * 1) 列表用 portal 挂到 body 并按 fixed 定位。下拉框经常出现在带
 *    `overflow: auto` 的面板里，若列表是自身子元素就会被父容器裁掉——
 *    这正是「输入框/下拉被遮挡」这类问题的根源。
 * 2) 选项超过阈值时自动出现搜索框。协议模板、环境变量、串口号这些列表
 *    会长到几十项，靠滚动找太慢。
 */
export function Select({
  value,
  onChange,
  options,
  style,
  disabled,
  title,
  placeholder = '请选择',
  searchable,
  size = 'md',
  align = 'start',
  unsafeStyle
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  style?: CSSProperties
  disabled?: boolean
  title?: string
  placeholder?: string
  /** 不传则按选项数量自动决定（> 8 项出现搜索框） */
  searchable?: boolean
  size?: 'sm' | 'md'
  /** 列表相对触发器的水平对齐方向 */
  align?: 'start' | 'end'
  /** 需要打破统一外观时才用（例如把触发器伪装成纯文字按钮） */
  unsafeStyle?: CSSProperties
}): JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [kw, setKw] = useState('')
  const [cursor, setCursor] = useState(-1)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; drop: 'down' | 'up' } | null>(
    null
  )

  const withSearch = searchable ?? options.length > 8
  const current = options.find((o) => o.value === value)

  const textOf = (o: SelectOption): string => o.text ?? (typeof o.label === 'string' ? o.label : '')

  const filtered = useMemo(() => {
    if (!kw.trim()) return options
    const k = kw.trim().toLowerCase()
    return options.filter((o) => textOf(o).toLowerCase().includes(k) || o.value.toLowerCase().includes(k))
  }, [options, kw])

  /** 测量触发器位置。列表默认向下展开，下方空间不够时翻到上方。 */
  const measure = (): void => {
    const el = btnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const wanted = Math.min(320, Math.max(filtered.length, 1) * 30 + (withSearch ? 44 : 0) + 12)
    const below = window.innerHeight - r.bottom - 8
    const drop = below < wanted && r.top > below ? 'up' : 'down'
    setRect({
      left: align === 'end' ? r.right : r.left,
      top: drop === 'down' ? r.bottom + 4 : r.top - 4,
      width: r.width,
      drop
    })
  }

  useLayoutEffect(() => {
    if (open) measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered.length])

  // 打开时把光标放在当前选中项上，方向键从这里起步而不是从头
  useEffect(() => {
    if (!open) {
      setKw('')
      setCursor(-1)
      return
    }
    const idx = filtered.findIndex((o) => o.value === value)
    setCursor(idx)
  }, [open])

  // 滚动或改窗口大小时重新贴位。fixed 定位不会跟着父容器滚动，
  // 不重算的话列表会「飘」在页面上与触发器脱节。
  useEffect(() => {
    if (!open) return
    const onScrollOrResize = (): void => measure()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown, true)
    return () => document.removeEventListener('mousedown', onDocDown, true)
  }, [open])

  // 键盘移动时把光标行滚进视野
  useEffect(() => {
    if (!open || cursor < 0) return
    const list = listRef.current
    const row = list?.querySelector('[data-idx="' + cursor + '"]') as HTMLElement | null
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const commit = (v: string): void => {
    onChange(v)
    setOpen(false)
    btnRef.current?.focus()
  }

  const move = (delta: number): void => {
    if (filtered.length === 0) return
    let i = cursor
    for (let n = 0; n < filtered.length; n++) {
      i = (i + delta + filtered.length) % filtered.length
      if (!filtered[i].disabled) break
    }
    setCursor(i)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setCursor(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setCursor(filtered.length - 1)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (cursor >= 0 && filtered[cursor] && !filtered[cursor].disabled) {
        e.preventDefault()
        commit(filtered[cursor].value)
      }
    }
  }

  const trigger: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: size === 'sm' ? 'var(--control-h-sm)' : 'var(--control-h)',
    padding: size === 'sm' ? '0 26px 0 8px' : '0 28px 0 var(--control-px)',
    position: 'relative',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm)',
    fontSize: size === 'sm' ? 'var(--fs-sm)' : 'var(--fs-md)',
    textAlign: 'left',
    minWidth: 0,
    ...pickLayout(style),
    ...unsafeStyle
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ui-select-trigger"
        style={trigger}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span style={valueText(Boolean(current))}>
          {current ? current.label : placeholder}
        </span>
        <span style={caret} aria-hidden>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2.2 3.9 5 6.7l2.8-2.8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            className="ui-select-list"
            role="listbox"
            style={{
              position: 'fixed',
              left: align === 'end' ? undefined : rect.left,
              right: align === 'end' ? window.innerWidth - rect.left : undefined,
              ...(rect.drop === 'down' ? { top: rect.top } : { bottom: window.innerHeight - rect.top }),
              minWidth: Math.max(rect.width, 160),
              maxWidth: 420,
              maxHeight: 320,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              background: 'var(--menu-bg)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--shadow-md)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              zIndex: 'var(--z-menu)' as unknown as number,
              padding: 4
            }}
          >
            {withSearch && (
              <div style={searchWrap}>
                <input
                  autoFocus
                  value={kw}
                  placeholder="搜索"
                  style={searchInput}
                  onChange={(e) => {
                    setKw(e.target.value)
                    setCursor(0)
                  }}
                  onKeyDown={onKeyDown}
                />
              </div>
            )}
            <div style={{ overflowY: 'auto', minHeight: 0 }}>
              {filtered.length === 0 && <div style={emptyRow}>无匹配项</div>}
              {filtered.map((o, i) => {
                const on = o.value === value
                const active = i === cursor
                let head: ReactNode = null
                if (o.group && (i === 0 || filtered[i - 1].group !== o.group)) {
                  head = <div style={groupHead}>{o.group}</div>
                }
                return (
                  <div key={o.value + ':' + i}>
                    {head}
                    <div
                      data-idx={i}
                      role="option"
                      aria-selected={on}
                      style={{
                        ...row,
                        ...(active ? rowActive : {}),
                        ...(o.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : {})
                      }}
                      onMouseEnter={() => !o.disabled && setCursor(i)}
                      onClick={() => !o.disabled && commit(o.value)}
                    >
                      <span style={rowLabel}>{o.label}</span>
                      {on && (
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                          <path
                            d="M2.5 6.4 4.8 8.7 9.5 4"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

const valueText = (has: boolean): CSSProperties => ({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  color: has ? 'var(--field-fg)' : 'var(--field-placeholder)'
})

const caret: CSSProperties = {
  position: 'absolute',
  right: 8,
  top: '50%',
  transform: 'translateY(-50%)',
  display: 'grid',
  placeItems: 'center',
  color: 'var(--text-2)',
  pointerEvents: 'none'
}

const searchWrap: CSSProperties = {
  padding: '2px 2px 6px',
  borderBottom: '1px solid var(--border-subtle)',
  marginBottom: 4
}

const searchInput: CSSProperties = {
  width: '100%',
  height: 'var(--control-h-sm)',
  padding: '0 8px',
  background: 'var(--field-bg)',
  color: 'var(--field-fg)',
  border: '1px solid var(--field-border)',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-sm)',
  outline: 'none'
}

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 28,
  padding: '5px 8px',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-md)',
  color: 'var(--text-0)',
  cursor: 'pointer',
  userSelect: 'none'
}

/**
 * 高亮态只作用于「键盘光标 / 鼠标悬停」这一行，选中态靠右侧勾选标记表达。
 * 两者用不同通道区分，是因为同时用底色表示会让人分不清
 * 「我正停在哪一项」和「当前生效的是哪一项」。
 */
const rowActive: CSSProperties = {
  background: 'var(--hover-bg)'
}

const rowLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis'
}

const groupHead: CSSProperties = {
  padding: '8px 8px 4px',
  fontSize: 'var(--fs-xs)',
  fontWeight: 600,
  letterSpacing: 0.4,
  color: 'var(--text-2)'
}

const emptyRow: CSSProperties = {
  padding: '10px 8px',
  fontSize: 'var(--fs-sm)',
  color: 'var(--text-2)',
  textAlign: 'center'
}
