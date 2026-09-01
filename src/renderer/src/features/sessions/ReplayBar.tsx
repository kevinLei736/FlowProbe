import { useEffect, useRef, useState } from 'react'
import type { RecordingFile } from '@shared/protocol'
import { formatDuration, ReplayPlayer, recordedToFrame, summarize } from './recording'
import { useStore } from '../../store/useStore'

const SPEEDS = [0.25, 0.5, 1, 2, 5, 10]

/**
 * 回放控制条。播放时把录制帧按原时序注入当前会话的时间轴，
 * 帧上带 replay 标记，界面用「回放」角标与真实链路区分。
 */
export function ReplayBar({
  recording,
  sessionId,
  onClose
}: {
  recording: RecordingFile
  sessionId: string
  onClose: () => void
}): JSX.Element {
  const injectFrame = useStore((s) => s.injectFrame)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [pos, setPos] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [done, setDone] = useState(false)
  const playerRef = useRef<ReplayPlayer | null>(null)
  const sum = summarize(recording)

  // 卸载时务必停掉定时器，否则关掉控制条后还会继续往时间轴灌数据
  useEffect(
    () => () => {
      playerRef.current?.dispose()
      playerRef.current = null
    },
    []
  )

  const build = (): ReplayPlayer => {
    const baseTs = Date.now()
    return new ReplayPlayer(
      recording.frames,
      speed,
      (rf) => injectFrame(recordedToFrame(rf, sessionId, baseTs)),
      (index, ms) => {
        setPos(index)
        setElapsed(ms)
      },
      () => {
        setPlaying(false)
        setDone(true)
      }
    )
  }

  const play = (): void => {
    if (playerRef.current && !done) {
      playerRef.current.resume()
      setPlaying(true)
      return
    }
    playerRef.current?.dispose()
    setPos(0)
    setElapsed(0)
    setDone(false)
    const p = build()
    playerRef.current = p
    p.start()
    setPlaying(true)
  }

  const pause = (): void => {
    playerRef.current?.pause()
    setPlaying(false)
  }

  const stop = (): void => {
    playerRef.current?.dispose()
    playerRef.current = null
    setPlaying(false)
    setDone(false)
    setPos(0)
    setElapsed(0)
  }

  const changeSpeed = (v: number): void => {
    setSpeed(v)
    playerRef.current?.setSpeed(v)
  }

  const pct = sum.durationMs > 0 ? Math.min(100, (elapsed / sum.durationMs) * 100) : done ? 100 : 0

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.title}>回放 · {recording.sessionName}</span>
        <span style={s.meta}>
          {sum.total} 帧（发 {sum.tx} / 收 {sum.rx}）· {formatDuration(sum.durationMs)} · {sum.bytes} B
        </span>
        <span style={s.spacer} />
        <button style={s.ghost} onClick={onClose}>关闭回放</button>
      </div>

      <div style={s.controls}>
        {playing ? (
          <button style={s.primary} onClick={pause}>暂停</button>
        ) : (
          <button style={s.primary} onClick={play}>{done ? '重播' : pos > 0 ? '继续' : '播放'}</button>
        )}
        <button style={s.ghost} onClick={stop} disabled={pos === 0 && !done}>停止</button>

        <span style={s.label}>倍速</span>
        <div style={s.seg}>
          {SPEEDS.map((v) => (
            <button
              key={v}
              style={{ ...s.segBtn, ...(v === speed ? s.segActive : {}) }}
              onClick={() => changeSpeed(v)}
            >
              {v}×
            </button>
          ))}
        </div>

        <div style={s.progressWrap}>
          <div style={{ ...s.progressFill, width: pct + '%' }} />
        </div>
        <span style={s.pos}>
          {pos}/{sum.total} · {formatDuration(Math.round(elapsed))}
        </span>
      </div>

      {recording.note && <div style={s.note}>{recording.note}</div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--bg-1)', padding: '8px 14px 10px' },
  head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  title: { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  meta: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  spacer: { flex: 1 },
  ghost: { padding: '4px 10px', background: 'var(--btn2-bg)', color: 'var(--text-1)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  primary: { padding: '4px 16px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  controls: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  label: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  seg: { display: 'flex', background: 'var(--bg-inset)', padding: 2, gap: 2, borderRadius: 'var(--r-sm)', overflow: 'hidden' },
  segBtn: { padding: '3px 8px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-micro)', fontFamily: 'var(--font-mono)' },
  segActive: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  progressWrap: { flex: 1, minWidth: 120, height: 4, background: 'var(--bg-3)', borderRadius: 'var(--r-xs)', overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--text-1)', transition: 'width 120ms linear' },
  pos: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', minWidth: 110, textAlign: 'right' },
  note: { marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-2)' }
}
