import { useEffect, useRef, useState } from 'react'

/**
 * 水平拖拽条：拖动改变下方区域的高度。
 *
 * 为什么单独做一个组件而不用 textarea 原生 resize：发送区不只有输入框，还有编码开关、
 * 结束符、片段行。用户想要的是「把整个发送区拉大」，原生手柄只能拉输入框本身，
 * 而且在 flex 列布局里会被重新压回去。把拉伸做成一条明确的分隔条，拖到哪就是哪。
 *
 * 约定：向上拖 = 下方区域变高，所以增量取 (起点 - 当前)。
 */
export function ResizeBar({
  height,
  onChange,
  onReset
}: {
  height: number
  onChange: (h: number) => void
  onReset?: () => void
}): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ y: 0, h: 0 })

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      onChange(startRef.current.h + (startRef.current.y - e.clientY))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = prev
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging])

  return (
    <div
      style={{ ...st.bar, ...(dragging ? st.on : {}) }}
      title="拖动调整发送区高度，双击复位"
      onMouseDown={(e) => {
        startRef.current = { y: e.clientY, h: height }
        setDragging(true)
      }}
      onDoubleClick={onReset}
    >
      <span style={st.grip} />
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  bar: {
    height: 9,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    cursor: 'ns-resize',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-1)'
  },
  // 深色下不加描边只提亮底色，避免出现白框
  on: { background: 'var(--selected-strong-bg)' },
  grip: { width: 34, height: 2, borderRadius: 2, background: 'var(--text-3)' }
}
