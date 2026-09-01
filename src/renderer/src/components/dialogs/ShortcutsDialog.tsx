import { useEffect } from 'react'
import { IS_MAC, keyHint } from '../../app/meta'
import { btnPrimary, kbd, overlay, sectionTitle, surface } from '../ui/tokens'

/** 快捷键一览。分组顺序与顶部菜单一致，便于对照记忆。 */
const GROUPS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: '全局',
    rows: [
      ['Ctrl K', '命令面板（搜索会话与命令）'],
      ['Ctrl N', '新建连接'],
      ['Ctrl F', '全局搜索历史报文'],
      ['Ctrl H', '报文历史浏览器'],
      ['Ctrl D', '数据看板'],
      ['Ctrl M', '报文标注与书签'],
      ['F1', '使用文档'],
      ['Ctrl /', '本快捷键面板']
    ]
  },
  {
    title: '视图',
    rows: [
      ['Ctrl B', '显示 / 隐藏左侧会话栏'],
      ['Ctrl J', '显示 / 隐藏右侧检查器'],
      ['Ctrl =', '放大界面'],
      ['Ctrl -', '缩小界面'],
      ['Ctrl 0', '恢复默认缩放'],
      ['Ctrl \\', '并排分屏 / 退出分屏'],
      ['Ctrl Shift D', '报文对比（挑两条比字节）'],
      [IS_MAC ? 'Ctrl ⌘ F' : 'F11', '全屏切换']
    ]
  },
  {
    title: '会话',
    rows: [
      ['Ctrl Enter', '发送当前报文'],
      ['Ctrl R', '重新连接当前会话'],
      ['Ctrl L', '清空报文时间轴'],
      ['Ctrl Tab', '切到下一个标签'],
      ['Ctrl Shift Tab', '切到上一个标签'],
      ['Ctrl W', '关闭当前标签']
    ]
  },
  {
    title: '弹层内',
    rows: [
      ['↑ ↓', '上下选择'],
      ['Enter', '执行 / 跳转'],
      ['Shift Enter', '搜索结果：查看命中行前后文'],
      ['Esc', '关闭当前弹层']
    ]
  }
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }): JSX.Element {
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
        <div style={styles.head}>快捷键</div>
        <div style={styles.grid}>
          {GROUPS.map((g) => (
            <div key={g.title} style={styles.col}>
              <div style={sectionTitle}>{g.title}</div>
              {g.rows.map(([k, d]) => (
                <div key={k} style={styles.row}>
                  <span style={{ ...kbd, ...styles.key }}>{keyHint(k)}</span>
                  <span style={styles.desc}>{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={styles.foot}>
          <span style={{ flex: 1 }} />
          <button style={btnPrimary} onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: { width: 720, maxWidth: '94vw', padding: 22, display: 'flex', flexDirection: 'column', gap: 16 },
  head: { fontSize: 'var(--fs-lg)', fontWeight: 600 },
  grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '18px 28px' },
  col: { display: 'flex', flexDirection: 'column', gap: 7 },
  row: { display: 'flex', alignItems: 'center', gap: 10 },
  key: { minWidth: 96, textAlign: 'center', padding: '3px 6px' },
  desc: { fontSize: 'var(--fs-sm)', color: 'var(--text-1)' },
  foot: { display: 'flex', alignItems: 'center', paddingTop: 2 }
}
