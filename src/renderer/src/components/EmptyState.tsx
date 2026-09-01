import { Logo } from './Logo'
import { btnQuiet } from './ui/tokens'

export function EmptyState({ onNew }: { onNew: () => void }): JSX.Element {
  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <Logo size={56} />
        <div style={styles.title}>欢迎使用 FlowProbe</div>
        <div style={styles.sub}>
          多协议网络与串口调试台 · TCP / WebSocket / 串口 / HTTP Mock
        </div>
        <button style={styles.btn} onClick={onNew}>
          + 新建一个连接
        </button>
        <div style={styles.note}>
          支持 TCP、WebSocket、串口的收发调试，HTTP Mock 服务与接口测试。也可从左下角打开「接口测试」与「工具箱」。
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: 'grid', placeItems: 'center' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: 32,
    maxWidth: 420,
    textAlign: 'center'
  },
  title: { fontSize: 'var(--fs-xl)', fontWeight: 600 },
  sub: { color: 'var(--text-1)' },
  // 空态里这颗按钮同属「常驻入口」，用柔和主操作与左栏保持一致
  btn: {
    ...btnQuiet,
    marginTop: 8,
    height: 'var(--control-h-lg)',
    padding: '0 18px',
    borderRadius: 'var(--r-md)',
    fontSize: 'var(--fs-md)'
  },
  note: { marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.6 }
}
