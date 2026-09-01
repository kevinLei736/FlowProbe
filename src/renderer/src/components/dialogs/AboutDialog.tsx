import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/protocol'
import { Logo } from '../Logo'
import { btnPrimary, btnSecondary, overlay, surface } from '../ui/tokens'

/**
 * 关于面板。除了版本号，更重要的是把数据落盘位置摊开：
 * 用户报「会话丢了」「历史查不到」时，第一件事就是确认这两个路径下有没有文件。
 *
 * 刻意不显示 Electron / Chromium / Node 版本：这三项对使用者没有任何可操作性，
 * 知道了也做不了什么，只会把真正有用的两个路径挤下去。
 */
export function AboutDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    window.toolbox.appInfo().then(setInfo)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={{ ...surface, ...styles.card }} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <Logo size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={styles.name}>FlowProbe</div>
            <div style={styles.tagline}>多协议网络与串口调试台</div>
          </div>
        </div>

        <div style={styles.rows}>
          <Row k="版本" v={info ? 'v' + info.version : '…'} />
          <Row k="平台" v={info ? `${info.platform} ${info.arch}` : '…'} />
          <Row k="工作区" v={info?.workspacePath ?? '…'} mono />
          <Row k="历史库" v={info?.historyPath ?? '…'} mono />
        </div>

        <div style={styles.foot}>
          <button style={btnSecondary} onClick={() => window.toolbox.revealPath('workspace')}>
            打开数据目录
          </button>
          <span style={{ flex: 1 }} />
          <button style={btnPrimary} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }): JSX.Element {
  return (
    <div style={styles.row}>
      <span style={styles.k}>{k}</span>
      <span style={{ ...styles.v, ...(mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' } : {}) }}>
        {v}
      </span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: { width: 560, maxWidth: '92vw', padding: 22, display: 'flex', flexDirection: 'column', gap: 18 },
  head: { display: 'flex', alignItems: 'center', gap: 14 },
  name: { fontSize: 'var(--fs-xl)', fontWeight: 600 },
  tagline: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', marginTop: 2 },
  rows: { display: 'flex', flexDirection: 'column', gap: 9 },
  row: { display: 'flex', gap: 14, alignItems: 'baseline' },
  k: { width: 66, flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  v: { flex: 1, minWidth: 0, fontSize: 'var(--fs-sm)', color: 'var(--text-1)', wordBreak: 'break-all' },
  foot: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }
}
