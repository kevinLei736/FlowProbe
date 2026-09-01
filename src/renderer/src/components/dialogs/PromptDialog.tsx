import { useEffect, useRef, useState } from 'react'
import { btnPrimary, btnSecondary, field, overlay, surface } from '../ui/tokens'

/**
 * 通用单行输入弹窗。
 * 之前重命名之类的操作只能去右侧检查器里找输入框，从菜单触发需要一个轻量入口。
 * 刻意不做成 window.prompt：那个在 Electron 里被禁用，且样式无法跟随主题。
 */
export function PromptDialog({
  title,
  label,
  initial,
  placeholder,
  confirmText = '确定',
  onConfirm,
  onClose
}: {
  title: string
  label?: string
  initial?: string
  placeholder?: string
  confirmText?: string
  onConfirm: (value: string) => void
  onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial ?? '')
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (!v) return
    onConfirm(v)
    onClose()
  }

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={{ ...surface, ...styles.card }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.title}>{title}</div>
        {label && <div style={styles.label}>{label}</div>}
        <input
          ref={ref}
          style={{ ...field, width: '100%' }}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onClose()
          }}
        />
        <div style={styles.foot}>
          <span style={{ flex: 1 }} />
          <button style={btnSecondary} onClick={onClose}>
            取消
          </button>
          <button style={btnPrimary} onClick={submit} disabled={value.trim().length === 0}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: { width: 420, maxWidth: '92vw', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  title: { fontSize: 'var(--fs-lg)', fontWeight: 600 },
  label: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }
}
