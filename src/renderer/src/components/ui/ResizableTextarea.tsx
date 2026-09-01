import { useEffect, useRef, useState } from 'react'

/**
 * 可靠拉伸的多行输入。
 *
 * 为什么不用原生 resize：textarea 若是 flex 列容器的直接子项（弹窗表单、发送区都是），
 * 原生手柄写的是 inline height，而 flex 会在下一次布局按 flex-shrink 把它压回去 ——
 * 用户看到手柄、拉了却没反应。这里改成自己画一条拖拽条并把高度提升为受控状态，
 * 同时给容器 flexShrink: 0，布局算法就没有机会覆盖用户的意图。
 *
 * 另一个好处：高度可以被外部记住（如发送区高度写进布局状态），下次进来还是习惯的大小。
 */
export function ResizableTextarea({
  value,
  onChange,
  onKeyDown,
  onBlur,
  placeholder,
  height,
  onHeightChange,
  min = 64,
  max = 520,
  mono = true,
  style,
  textareaStyle,
  title
}: {
  value: string
  onChange: (v: string) => void
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** 失焦提交：长文本逐字符写持久化会卡，交给调用方在失焦时落盘 */
  onBlur?: () => void
  placeholder?: string
  /** 受控高度；不传则组件内部自管（非受控） */
  height?: number
  onHeightChange?: (h: number) => void
  min?: number
  max?: number
  mono?: boolean
  style?: React.CSSProperties
  textareaStyle?: React.CSSProperties
  title?: string
}): JSX.Element {
  const [innerH, setInnerH] = useState(height ?? 96)
  const h = height ?? innerH
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ y: 0, h: 0 })

  const setH = (next: number): void => {
    const clamped = Math.min(max, Math.max(min, Math.round(next)))
    if (height === undefined) setInnerH(clamped)
    onHeightChange?.(clamped)
  }

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => {
      // 手柄在下沿，往下拖 = 变高，所以是 (当前 - 起点) 正向叠加
      setH(startRef.current.h + (e.clientY - startRef.current.y))
    }
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    // 拖拽期间禁掉整页文本选中，否则拖过文字会选中一大片蓝色
    const prev = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.userSelect = prev
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, min, max, height])

  return (
    <div style={{ ...st.wrap, ...style }}>
      <textarea
        // 关掉原生手柄：同一个方向上有两套拉伸机制会互相打架
        data-no-resize-hint
        style={{ ...st.area, height: h, fontFamily: mono ? 'var(--font-mono)' : 'inherit', ...textareaStyle }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder={placeholder}
        title={title}
      />
      <div
        style={{ ...st.handle, ...(dragging ? st.handleOn : {}) }}
        title="拖动调整高度，双击复位"
        onMouseDown={(e) => {
          startRef.current = { y: e.clientY, h }
          setDragging(true)
        }}
        onDoubleClick={() => setH(96)}
      >
        <span style={st.grip} />
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  // flexShrink: 0 是关键：父级是 flex 列时，不加这行用户拉出来的高度会被压回去
  wrap: { display: 'flex', flexDirection: 'column', flexShrink: 0, minWidth: 0 },
  area: {
    width: '100%',
    boxSizing: 'border-box',
    resize: 'none',
    padding: '9px var(--control-px)',
    background: 'var(--field-bg)',
    color: 'var(--field-fg)',
    border: '1px solid var(--field-border)',
    borderRadius: 'var(--r-sm) var(--r-sm) 0 0',
    fontSize: 'var(--fs-sm)',
    lineHeight: 'var(--lh-normal)',
    outline: 'none'
  },
  handle: {
    height: 11,
    flexShrink: 0,
    display: 'grid',
    placeItems: 'center',
    cursor: 'ns-resize',
    background: 'var(--bg-2)',
    borderRadius: '0 0 var(--r-sm) var(--r-sm)',
    border: '1px solid var(--field-border)',
    borderTop: 'none'
  },
  handleOn: { background: 'var(--selected-strong-bg)' },
  // 三条短横当抓手：比对角线更符合「上下拉」的方向语义
  grip: { width: 26, height: 2, borderRadius: 2, background: 'var(--text-3)' }
}
