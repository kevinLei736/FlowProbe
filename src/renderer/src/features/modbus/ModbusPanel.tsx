import { useMemo, useState } from 'react'
import type { ModbusConfig, ModbusPoint, ModbusPointType, Session } from '@shared/protocol'
import { useStore } from '../../store/useStore'
import {
  btnPrimary,
  btnSecondary,
  checkRow,
  field,
  fieldSm,
  label as labelStyle,
  overlay,
  surface
} from '../../components/ui/tokens'
import { Select } from '../../components/ui/Select'

const FUNC_LABEL: Record<number, string> = {
  1: '01 线圈',
  2: '02 离散输入',
  3: '03 保持寄存器',
  4: '04 输入寄存器'
}

const TYPES: ModbusPointType[] = [
  'uint16',
  'int16',
  'uint32',
  'int32',
  'float32',
  'float64',
  'bits',
  'string'
]

/** 各类型占用的寄存器个数。bits/string 由用户自己填数量。 */
const WORDS: Partial<Record<ModbusPointType, number>> = {
  uint16: 1,
  int16: 1,
  uint32: 2,
  int32: 2,
  float32: 2,
  float64: 4
}

function newPoint(): ModbusPoint {
  return {
    id: Math.random().toString(36).slice(2),
    name: '',
    func: 3,
    addr: 0,
    quantity: 1,
    type: 'uint16',
    scale: 1,
    offset: 0,
    unit: '',
    writable: false,
    pollMs: 1000,
    enabled: true
  }
}

/**
 * Modbus 点表面板。
 *
 * 现场调试 Modbus 的真实工作面就是这张表：地址、类型、换算、单位填对，
 * 读出来直接是工程值。所以面板不做「先建连接再逐个手动发报文」那套流程，
 * 而是点表即配置、保存即生效——改动通过增量下发重排轮询计划，不断链路。
 *
 * 实时值单独一列并显示原始 HEX：32 位量的字序在设备之间分歧极大，
 * 工程值不对时对照 HEX 才能判断是该翻字序还是地址错了。
 */
export function ModbusPanel({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): JSX.Element {
  const updatePoints = useStore((s) => s.updateModbusPoints)
  const updateConfig = useStore((s) => s.updateSessionConfig)
  const values = useStore((s) => s.modbusValues[session.id] ?? {})
  const cfg = (session.config.modbus ?? {}) as ModbusConfig

  const [points, setPoints] = useState<ModbusPoint[]>(cfg.points ?? [])
  const [draft, setDraft] = useState<ModbusConfig>({ ...cfg })
  const [tab, setTab] = useState<'points' | 'link'>('points')

  const dirtyLink = useMemo(
    () =>
      JSON.stringify({ ...draft, points: [] }) !== JSON.stringify({ ...cfg, points: [] }),
    [draft, cfg]
  )

  const commit = (next: ModbusPoint[]): void => {
    setPoints(next)
    updatePoints(session.id, next)
  }

  const patch = (id: string, p: Partial<ModbusPoint>): void => {
    commit(
      points.map((x) => {
        if (x.id !== id) return x
        const merged = { ...x, ...p }
        // 换类型时把数量对齐到该类型的固定字长，省得用户手动改
        if (p.type && WORDS[p.type]) merged.quantity = WORDS[p.type] as number
        return merged
      })
    )
  }

  const applyLink = (): void => {
    updateConfig(session.id, { modbus: { ...draft, points } })
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Modbus 点表 · {session.name}</span>
          <div style={styles.tabs}>
            <button
              style={{ ...styles.tab, ...(tab === 'points' ? styles.tabOn : {}) }}
              onClick={() => setTab('points')}
            >
              点表（{points.length}）
            </button>
            <button
              style={{ ...styles.tab, ...(tab === 'link' ? styles.tabOn : {}) }}
              onClick={() => setTab('link')}
            >
              链路参数
            </button>
          </div>
          <button style={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>

        {tab === 'points' ? (
          <div style={styles.body}>
            <div style={styles.hint}>
              地址按 0 基填写（协议地址）。若设备手册给的是 40001 这类 1 基地址，
              保持寄存器请填 <code style={styles.code}>手册值 − 40001</code>。
              工程值 = 原始值 × 系数 + 偏移。
            </div>

            <div style={styles.tableHead}>
              <span style={{ width: 26 }} />
              <span style={{ flex: 1.4 }}>名称</span>
              <span style={{ width: 116 }}>功能码</span>
              <span style={{ width: 72 }}>地址</span>
              <span style={{ width: 82 }}>类型</span>
              <span style={{ width: 56 }}>数量</span>
              <span style={{ width: 56 }}>系数</span>
              <span style={{ width: 56 }}>偏移</span>
              <span style={{ width: 52 }}>单位</span>
              <span style={{ width: 68 }}>轮询ms</span>
              <span style={{ width: 34 }} title="允许从界面写入">
                写
              </span>
              <span style={{ width: 34 }} title="加入数值曲线">
                图
              </span>
              <span style={{ flex: 1 }}>实时值</span>
              <span style={{ width: 88 }} />
            </div>

            {points.length === 0 && (
              <div style={styles.empty}>点表为空，添加一行即可开始轮询</div>
            )}

            {points.map((p) => {
              const v = values[p.id]
              const shown =
                v == null
                  ? '—'
                  : v.error
                    ? v.error
                    : Array.isArray(v.value)
                      ? v.value.join('')
                      : v.value === null
                        ? '—'
                        : String(v.value)
              return (
                <div key={p.id} style={styles.row}>
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    title="启用该点位"
                    onChange={(e) => patch(p.id, { enabled: e.target.checked })}
                  />
                  <input
                    style={{ ...fieldSm, flex: 1.4 }}
                    value={p.name}
                    placeholder="进水温度"
                    onChange={(e) => patch(p.id, { name: e.target.value })}
                  />
                  <Select
                    size="sm"
                    style={{ width: 124 }}
                    value={String(p.func)}
                    searchable={false}
                    onChange={(v) => patch(p.id, { func: Number(v) as ModbusPoint['func'] })}
                    options={[1, 2, 3, 4].map((f) => ({
                      value: String(f),
                      label: FUNC_LABEL[f]
                    }))}
                  />
                  <input
                    style={{ ...fieldSm, width: 72, fontFamily: 'var(--font-mono)' }}
                    value={String(p.addr)}
                    onChange={(e) => patch(p.id, { addr: Number(e.target.value) || 0 })}
                  />
                  <Select
                    size="sm"
                    style={{ width: 92 }}
                    value={p.type}
                    searchable={false}
                    onChange={(v) => patch(p.id, { type: v as ModbusPointType })}
                    options={TYPES.map((t) => ({ value: t, label: t }))}
                  />
                  <input
                    style={{ ...fieldSm, width: 56 }}
                    value={String(p.quantity)}
                    disabled={Boolean(WORDS[p.type])}
                    title={WORDS[p.type] ? '该类型字长固定' : '寄存器/位个数'}
                    onChange={(e) => patch(p.id, { quantity: Number(e.target.value) || 1 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 56 }}
                    value={String(p.scale ?? 1)}
                    onChange={(e) => patch(p.id, { scale: Number(e.target.value) || 0 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 56 }}
                    value={String(p.offset ?? 0)}
                    onChange={(e) => patch(p.id, { offset: Number(e.target.value) || 0 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 52 }}
                    value={p.unit ?? ''}
                    placeholder="℃"
                    onChange={(e) => patch(p.id, { unit: e.target.value })}
                  />
                  <input
                    style={{ ...fieldSm, width: 68 }}
                    value={String(p.pollMs)}
                    title="0 = 不轮询，仅手动读"
                    onChange={(e) => patch(p.id, { pollMs: Number(e.target.value) || 0 })}
                  />
                  <input
                    type="checkbox"
                    style={{ width: 34 }}
                    checked={Boolean(p.writable)}
                    title="允许从界面写入"
                    onChange={(e) => patch(p.id, { writable: e.target.checked })}
                  />
                  <input
                    type="checkbox"
                    style={{ width: 34 }}
                    checked={Boolean(p.chart)}
                    title="加入数值曲线"
                    onChange={(e) => patch(p.id, { chart: e.target.checked })}
                  />
                  <span
                    style={{
                      ...styles.value,
                      color: v?.error ? 'var(--conn-error)' : 'var(--text-0)'
                    }}
                    title={v ? '原始 ' + v.rawHex : '尚无数据'}
                  >
                    {shown}
                    {!v?.error && p.unit ? ' ' + p.unit : ''}
                    {v && !v.error && (
                      <span style={styles.raw}>{v.rawHex}</span>
                    )}
                  </span>
                  <div style={styles.rowActions}>
                    <button
                      style={styles.miniBtn}
                      title="立即读一次"
                      onClick={() => void window.toolbox.modbusReadPoint(session.id, p.id)}
                    >
                      读
                    </button>
                    <WriteCell session={session} point={p} />
                    <button
                      style={styles.iconDel}
                      title="删除点位"
                      onClick={() => commit(points.filter((x) => x.id !== p.id))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )
            })}

            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button style={btnSecondary} onClick={() => commit([...points, newPoint()])}>
                + 添加点位
              </button>
              <button
                style={btnSecondary}
                title="按当前点表把地址连续的点位合并读取，减少请求数"
                onClick={() => commit([...points].sort((a, b) => a.func - b.func || a.addr - b.addr))}
              >
                按地址排序
              </button>
            </div>
          </div>
        ) : (
          <div style={styles.body}>
            <div style={styles.hint}>
              链路参数改动需要重建连接。字序两个开关合起来覆盖 ABCD / CDAB / BADC / DCBA
              四种排法，工程值明显不对但 HEX 正常时，优先试着翻字序。
            </div>
            <div style={styles.grid2}>
              <Field label="传输方式">
                <Select
                  style={{ width: '100%' }}
                  value={draft.transport ?? 'tcp'}
                  searchable={false}
                  onChange={(v) =>
                    setDraft({ ...draft, transport: v as ModbusConfig['transport'] })
                  }
                  options={[
                    { value: 'tcp', label: 'Modbus TCP' },
                    { value: 'rtu-over-tcp', label: 'RTU over TCP' },
                    { value: 'rtu', label: 'Modbus RTU（串口）' }
                  ]}
                />
              </Field>
              <Field label="从站地址 Unit ID">
                <input
                  style={field}
                  value={String(draft.unitId ?? 1)}
                  onChange={(e) => setDraft({ ...draft, unitId: Number(e.target.value) || 1 })}
                />
              </Field>
            </div>
            {draft.transport !== 'rtu' && (
              <div style={styles.grid2}>
                <Field label="主机">
                  <input
                    style={field}
                    value={draft.host ?? '127.0.0.1'}
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  />
                </Field>
                <Field label="端口">
                  <input
                    style={field}
                    value={String(draft.port ?? 502)}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 502 })}
                  />
                </Field>
              </div>
            )}
            <div style={styles.grid3}>
              <Field label="响应超时(ms)">
                <input
                  style={field}
                  value={String(draft.timeoutMs ?? 1000)}
                  onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) || 1000 })}
                />
              </Field>
              <Field label="重试次数">
                <input
                  style={field}
                  value={String(draft.retries ?? 1)}
                  onChange={(e) => setDraft({ ...draft, retries: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="请求间隔(ms)">
                <input
                  style={field}
                  value={String(draft.gapMs ?? 20)}
                  title="两次请求之间的最小静默，防止把从站打爆"
                  onChange={(e) => setDraft({ ...draft, gapMs: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
            <div style={styles.grid3}>
              <Field label="字序（32 位量）">
                <Select
                  style={{ width: '100%' }}
                  value={draft.wordOrder ?? 'be'}
                  searchable={false}
                  onChange={(v) => setDraft({ ...draft, wordOrder: v as 'be' | 'le' })}
                  options={[
                    { value: 'be', label: '高字在前 (AB CD)' },
                    { value: 'le', label: '低字在前 (CD AB)' }
                  ]}
                />
              </Field>
              <Field label="字节序">
                <Select
                  style={{ width: '100%' }}
                  value={draft.byteOrder ?? 'be'}
                  searchable={false}
                  onChange={(v) => setDraft({ ...draft, byteOrder: v as 'be' | 'le' })}
                  options={[
                    { value: 'be', label: '大端' },
                    { value: 'le', label: '小端' }
                  ]}
                />
              </Field>
              <Field label="合并读间隔">
                <input
                  style={field}
                  value={String(draft.mergeGap ?? 8)}
                  title="地址相隔不超过该值的点位合并成一次批量读，0 = 不合并"
                  onChange={(e) => setDraft({ ...draft, mergeGap: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
          </div>
        )}

        <div style={styles.footer}>
          {tab === 'points' ? (
            <span style={styles.note}>点表改动已即时生效</span>
          ) : (
            dirtyLink && <span style={styles.dirty}>链路参数已修改，应用后会重建连接</span>
          )}
          <span style={{ flex: 1 }} />
          <button style={btnSecondary} onClick={onClose}>
            关闭
          </button>
          {tab === 'link' && (
            <button style={btnPrimary} disabled={!dirtyLink} onClick={applyLink}>
              应用并重连
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 就地写入。写值的输入框只在点位标了「可写」时出现，
 * 避免误改现场设备寄存器。
 */
function WriteCell({ session, point }: { session: Session; point: ModbusPoint }): JSX.Element {
  const [v, setV] = useState('')
  if (!point.writable) return <span style={{ width: 46 }} />
  const isBit = point.func === 1 || point.func === 2
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <input
        style={{ ...fieldSm, width: 56 }}
        value={v}
        placeholder={isBit ? '0/1' : '值'}
        onChange={(e) => setV(e.target.value)}
      />
      <button
        style={styles.miniBtn}
        title="写入该点位并自动回读"
        disabled={v === ''}
        onClick={() => {
          const num = Number(v)
          if (Number.isNaN(num)) return
          void window.toolbox.modbusWritePoint(
            session.id,
            point.id,
            isBit ? num !== 0 : num
          )
          setV('')
        }}
      >
        写
      </button>
    </span>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={styles.fieldWrap}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    ...surface,
    width: 'min(1240px, 94vw)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderBottom: '1px solid var(--border)'
  },
  title: { fontWeight: 600 },
  tabs: { display: 'inline-flex', padding: 2, gap: 2, background: 'var(--bg-inset)', borderRadius: 'var(--r-md)' },
  tab: {
    height: 24,
    padding: '0 10px',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-sm)'
  },
  tabOn: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  close: {
    marginLeft: 'auto',
    background: 'transparent',
    color: 'var(--text-1)',
    border: 'none',
    fontSize: 'var(--fs-lg)'
  },
  body: {
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 4 },
  code: {
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-inset)',
    borderRadius: 3,
    padding: '1px 4px'
  },
  tableHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 0 4px',
    fontSize: 'var(--fs-micro)',
    color: 'var(--text-2)',
    borderBottom: '1px solid var(--border-subtle)'
  },
  row: { display: 'flex', alignItems: 'center', gap: 6 },
  rowActions: { display: 'inline-flex', alignItems: 'center', gap: 4, width: 88, justifyContent: 'flex-end' },
  value: {
    flex: 1,
    minWidth: 0,
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 6,
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
    fontSize: 'var(--fs-sm)',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis'
  },
  raw: { color: 'var(--text-2)', fontSize: 'var(--fs-micro)' },
  miniBtn: {
    height: 24,
    padding: '0 8px',
    background: 'var(--btn2-bg)',
    color: 'var(--text-1)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-xs)',
    fontSize: 'var(--fs-xs)'
  },
  iconDel: {
    width: 24,
    height: 24,
    display: 'grid',
    placeItems: 'center',
    background: 'transparent',
    color: 'var(--text-2)',
    border: 'none',
    borderRadius: 'var(--r-xs)'
  },
  empty: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', padding: '14px 0' },
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid var(--border)'
  },
  note: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  dirty: { fontSize: 'var(--fs-xs)', color: 'var(--warn)' }
}
