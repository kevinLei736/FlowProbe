import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 左右分屏容器。
 *
 * 为什么自己写而不是用 CSS resize 或第三方库：
 * 两侧都是「flex:1 + minHeight:0」的复杂视图，用 grid 的百分比列宽最省事，
 * 拖动时只改一个比例数字，两侧内部布局完全不用感知分屏这件事。
 *
 * 拖动过程中把比例放在本地 state、松手才写回全局：
 * 全局比例每次变更都会落盘 localStorage，按住鼠标拖一次会写上百次。
 */
export function SplitPane({
  ratio,
  onRatio,
  left,
  right,
  onFocusLeft,
  onFocusRight,
  focus
}: {
  ratio: number
  onRatio: (r: number) => void
  left: React.ReactNode
  right: React.ReactNode
  onFocusLeft: () => void
  onFocusRight: () => void
  focus: 'left' | 'right'
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? ratio

  const onDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      const el = box.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return
      setLive(Math.min(0.8, Math.max(0.2, (e.clientX - r.left) / r.width)))
    }
    const up = (): void => {
      setDragging(false)
      setLive((v) => {
        if (v !== null) onRatio(v)
        return null
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // 拖动时禁掉文本选中，否则鼠标扫过报文区会拉出一大片高亮
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = prev
    }
  }, [dragging, onRatio])

  return (
    <div ref={box} style={{ ...st.box, gridTemplateColumns: `minmax(0, ${shown}fr) 6px minmax(0, ${1 - shown}fr)` }}>
      {/* mousedown 而不是 click 设焦点：点在里面的按钮上时 click 会被内部控件吞掉，
          而焦点必须在按钮真正生效之前就切过去，否则菜单会作用到另一侧 */}
      <div
        style={{ ...st.pane, ...(focus === 'left' ? st.paneOn : {}) }}
        onMouseDownCapture={onFocusLeft}
      >
        {left}
      </div>
      <div
        style={{ ...st.grip, ...(dragging ? st.gripOn : {}) }}
        role="separator"
        aria-orientation="vertical"
        title="拖动调整左右宽度"
        onMouseDown={onDown}
        onDoubleClick={() => onRatio(0.5)}
      />
      <div
        style={{ ...st.pane, ...(focus === 'right' ? st.paneOn : {}) }}
        onMouseDownCapture={onFocusRight}
      >
        {right}
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  box: {
    display: 'grid',
    flex: '1 1 0',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden'
  },
  pane: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden'
  },
  // 焦点侧只用一条顶部细线标示，不加边框：深色主题下任何完整描边都会显出白框
  paneOn: { boxShadow: 'inset 0 1px 0 0 var(--accent)' },
  grip: {
    cursor: 'col-resize',
    background: 'var(--border-subtle)'
  },
  gripOn: { background: 'var(--accent)' }
}
