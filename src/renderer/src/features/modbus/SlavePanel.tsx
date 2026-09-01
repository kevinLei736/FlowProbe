import { useMemo, useState } from 'react'
import type {
  ModbusArea,
  ModbusSlaveConfig,
  ModbusSlaveRegion,
  Session
} from '@shared/protocol'
import { useStore } from '../../store/useStore'
import {
  btnPrimary,
  btnSecondary,
  field,
  fieldSm,
  label as labelStyle,
  overlay,
  surface
} from '../../components/ui/tokens'
import { Select } from '../../components/ui/Select'

const AREA_LABEL: Record<ModbusArea, string> = {
  coil: '线圈 (0x)',
  discrete: '离散输入 (1x)',
  holding: '保持寄存器 (4x)',
  input: '输入寄存器 (3x)'
}

/** 位区只能是 0/1，寄存器区是 0..65535。很多校验要按这个分岔。 */
function isBitArea(area: ModbusArea): boolean {
  return area === 'coil' || area === 'discrete'
}

const ANIMATE_LABEL: Record<string, string> = {
  none: '不变化',
  ramp: '递增（到顶折返）',
  sine: '正弦波',
  random: '随机',
  toggle: '交替 0/1'
}

function newRegion(): ModbusSlaveRegion {
  return {
    id: Math.random().toString(36).slice(2),
    name: '',
    area: 'holding',
    start: 0,
    count: 10,
    initial: 0,
    readOnly: false,
    animate: 'none',
    animateMs: 1000,
    animateMin: 0,
    animateMax: 1000,
    animateStep: 1,
    enabled: true
  }
}

/**
 * Modbus 从站模拟面板。
 *
 * 与主站点表面板是镜像关系，但工作面完全不同：主站问「我要读哪些地址」，
 * 从站答「我这里有哪些地址、初值多少、怎么自己动起来」。所以这里没有轮询周期、
 * 没有工程值换算（换算是主站侧的事），取而代之的是数据区定义、自动变化与故障注入。
 *
 * 值表格单列一页：调主站点表时最常做的动作是「把某个寄存器改成 1234，看主站读到没」，
 * 这个动作必须一眼能找到、一次点击能完成。
 */
export function SlavePanel({
  session,
  onClose
}: {
  session: Session
  onClose: () => void
}): JSX.Element {
  const updateRegions = useStore((s) => s.updateSlaveRegions)
  const writeRegister = useStore((s) => s.writeSlaveRegister)
  const updateConfig = useStore((s) => s.updateSessionConfig)
  const values = useStore((s) => s.slaveValues[session.id] ?? {})
  const cfg = (session.config.modbusSlave ?? {}) as ModbusSlaveConfig

  const [regions, setRegions] = useState<ModbusSlaveRegion[]>(cfg.regions ?? [])
  const [draft, setDraft] = useState<ModbusSlaveConfig>({ ...cfg })
  const [tab, setTab] = useState<'regions' | 'values' | 'link'>('regions')

  const dirtyLink = useMemo(
    () => JSON.stringify({ ...draft, regions: [] }) !== JSON.stringify({ ...cfg, regions: [] }),
    [draft, cfg]
  )

  const commit = (next: ModbusSlaveRegion[]): void => {
    setRegions(next)
    updateRegions(session.id, next)
  }

  const patch = (id: string, part: Partial<ModbusSlaveRegion>): void => {
    commit(
      regions.map((r) => {
        if (r.id !== id) return r
        const merged = { ...r, ...part }
        // 切到位区时把初值与动画范围夹回 0/1，否则会存下一个「初值 500 的线圈」这种非法配置
        if (part.area && isBitArea(part.area)) {
          merged.initial = merged.initial ? 1 : 0
          merged.animateMin = 0
          merged.animateMax = 1
          if (merged.animate === 'ramp' || merged.animate === 'sine') merged.animate = 'toggle'
        }
        return merged
      })
    )
  }

  const applyLink = (): void => {
    updateConfig(session.id, { modbusSlave: { ...draft, regions } })
  }

  const running = session.status === 'listening'

  return (
    <div style={overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Modbus 从站 · {session.name}</span>
          <div style={styles.tabs}>
            <button
              style={{ ...styles.tab, ...(tab === 'regions' ? styles.tabOn : {}) }}
              onClick={() => setTab('regions')}
            >
              数据区（{regions.length}）
            </button>
            <button
              style={{ ...styles.tab, ...(tab === 'values' ? styles.tabOn : {}) }}
              onClick={() => setTab('values')}
            >
              实时值
            </button>
            <button
              style={{ ...styles.tab, ...(tab === 'link' ? styles.tabOn : {}) }}
              onClick={() => setTab('link')}
            >
              链路与故障
            </button>
          </div>
          <button style={styles.close} onClick={onClose}>
            ✕
          </button>
        </div>

        {tab === 'regions' && (
          <div style={styles.body}>
            <div style={styles.hint}>
              地址按 0 基填写，与主站点表同一套口径。<b>只有这里声明过的地址才存在</b>：
              主站读到未声明的地址会收到「非法数据地址」——这正是用它自测点表的意义，
              地址填错不会被静默当成 0。
            </div>

            <div style={styles.tableHead}>
              <span style={{ width: 26 }} />
              <span style={{ flex: 1.2 }}>名称</span>
              <span style={{ width: 132 }}>数据区</span>
              <span style={{ width: 70 }}>起始</span>
              <span style={{ width: 62 }}>数量</span>
              <span style={{ width: 62 }}>初值</span>
              <span style={{ width: 36 }} title="只读区：主站写入时返回非法数据地址">
                只读
              </span>
              <span style={{ width: 138 }}>自动变化</span>
              <span style={{ width: 70 }}>周期ms</span>
              <span style={{ width: 62 }}>下限</span>
              <span style={{ width: 62 }}>上限</span>
              <span style={{ width: 56 }}>步进</span>
              <span style={{ width: 30 }} />
            </div>

            {regions.length === 0 && (
              <div style={styles.empty}>还没有数据区。主站的任何读请求都会收到「非法数据地址」</div>
            )}

            {regions.map((r) => {
              const bit = isBitArea(r.area)
              return (
                <div key={r.id} style={styles.row}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    title="启用该数据区"
                    onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                  />
                  <input
                    style={{ ...fieldSm, flex: 1.2 }}
                    value={r.name}
                    placeholder="进水温度区"
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                  />
                  <Select
                    size="sm"
                    style={{ width: 140 }}
                    value={r.area}
                    searchable={false}
                    onChange={(v) => patch(r.id, { area: v as ModbusArea })}
                    options={(Object.keys(AREA_LABEL) as ModbusArea[]).map((a) => ({
                      value: a,
                      label: AREA_LABEL[a]
                    }))}
                  />
                  <input
                    style={{ ...fieldSm, width: 78 }}
                    value={String(r.start)}
                    onChange={(e) => patch(r.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                  />
                  <input
                    style={{ ...fieldSm, width: 70 }}
                    value={String(r.count)}
                    title="地址个数。位区为位数，寄存器区为字数"
                    onChange={(e) => patch(r.id, { count: Math.max(0, Number(e.target.value) || 0) })}
                  />
                  <input
                    style={{ ...fieldSm, width: 70 }}
                    value={String(r.initial ?? 0)}
                    title={bit ? '0 或 1' : '0 – 65535'}
                    onChange={(e) => patch(r.id, { initial: Number(e.target.value) || 0 })}
                  />
                  <input
                    type="checkbox"
                    style={{ width: 36 }}
                    checked={r.readOnly === true}
                    title="只读：主站写入时返回 0x02，用于模拟输入类或受保护寄存器"
                    onChange={(e) => patch(r.id, { readOnly: e.target.checked })}
                  />
                  <Select
                    size="sm"
                    style={{ width: 146 }}
                    value={r.animate ?? 'none'}
                    searchable={false}
                    onChange={(v) => patch(r.id, { animate: v as ModbusSlaveRegion['animate'] })}
                    options={(bit
                      ? ['none', 'toggle', 'random']
                      : ['none', 'ramp', 'sine', 'random']
                    ).map((k) => ({ value: k, label: ANIMATE_LABEL[k] }))}
                  />
                  <input
                    style={{ ...fieldSm, width: 78 }}
                    value={String(r.animateMs ?? 1000)}
                    disabled={(r.animate ?? 'none') === 'none'}
                    onChange={(e) => patch(r.id, { animateMs: Number(e.target.value) || 1000 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 70 }}
                    value={String(r.animateMin ?? 0)}
                    disabled={bit || (r.animate ?? 'none') === 'none'}
                    onChange={(e) => patch(r.id, { animateMin: Number(e.target.value) || 0 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 70 }}
                    value={String(r.animateMax ?? 1000)}
                    disabled={bit || (r.animate ?? 'none') === 'none'}
                    onChange={(e) => patch(r.id, { animateMax: Number(e.target.value) || 0 })}
                  />
                  <input
                    style={{ ...fieldSm, width: 64 }}
                    value={String(r.animateStep ?? 1)}
                    disabled={(r.animate ?? 'none') !== 'ramp'}
                    title="递增模式每步的增量"
                    onChange={(e) => patch(r.id, { animateStep: Number(e.target.value) || 1 })}
                  />
                  <button
                    style={styles.iconDel}
                    title="删除该数据区"
                    onClick={() => commit(regions.filter((x) => x.id !== r.id))}
                  >
                    ✕
                  </button>
                </div>
              )
            })}

            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button style={btnSecondary} onClick={() => commit([...regions, newRegion()])}>
                + 添加数据区
              </button>
              <button
                style={btnSecondary}
                title="按数据区与起始地址排序，便于核对是否有重叠"
                onClick={() =>
                  commit([...regions].sort((a, b) => a.area.localeCompare(b.area) || a.start - b.start))
                }
              >
                按地址排序
              </button>
            </div>
            <div style={styles.note}>数据区改动即时生效，不会断开已连接的主站</div>
          </div>
        )}

        {tab === 'values' && (
          <div style={styles.body}>
            <div style={styles.hint}>
              点格子直接改值，主站下一次轮询就能读到。
              {!running && <b>（当前未启动，值只在启动后才会推送）</b>}
            </div>
            {regions.filter((r) => r.enabled).length === 0 && (
              <div style={styles.empty}>没有启用的数据区</div>
            )}
            {regions
              .filter((r) => r.enabled)
              .map((r) => (
                <RegionGrid
                  key={r.id}
                  region={r}
                  values={values[r.id]?.values ?? []}
                  onWrite={(addr, v) => writeRegister(session.id, r.area, addr, v)}
                />
              ))}
          </div>
        )}

        {tab === 'link' && (
          <div style={styles.body}>
            <div style={styles.hint}>
              链路参数改动需要重启监听。Modbus 默认端口 502 在部分系统上需要管理员权限，
              本机自测建议改成 5020 之类的高位端口。
            </div>
            <div style={styles.grid2}>
              <Field label="传输方式">
                <Select
                  style={{ width: '100%' }}
                  value={draft.transport ?? 'tcp'}
                  searchable={false}
                  onChange={(v) => setDraft({ ...draft, transport: v as ModbusSlaveConfig['transport'] })}
                  options={[
                    { value: 'tcp', label: 'Modbus TCP（监听）' },
                    { value: 'rtu-over-tcp', label: 'RTU over TCP（监听）' },
                    { value: 'rtu', label: 'Modbus RTU（串口应答）' }
                  ]}
                />
              </Field>
              <Field label="本机从站地址 Unit ID">
                <input
                  style={field}
                  value={String(draft.unitId ?? 1)}
                  onChange={(e) => setDraft({ ...draft, unitId: Number(e.target.value) || 1 })}
                />
              </Field>
            </div>
            {draft.transport !== 'rtu' && (
              <div style={styles.grid3}>
                <Field label="监听地址">
                  <input
                    style={field}
                    value={draft.host ?? '0.0.0.0'}
                    title="0.0.0.0 = 所有网卡；只想本机访问可填 127.0.0.1"
                    onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                  />
                </Field>
                <Field label="监听端口">
                  <input
                    style={field}
                    value={String(draft.port ?? 502)}
                    onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) || 502 })}
                  />
                </Field>
                <Field label="最大主站连接数">
                  <input
                    style={field}
                    value={String(draft.maxClients ?? 8)}
                    onChange={(e) => setDraft({ ...draft, maxClients: Number(e.target.value) || 1 })}
                  />
                </Field>
              </div>
            )}
            <label style={styles.checkLine}>
              <input
                type="checkbox"
                checked={draft.acceptAnyUnit === true}
                onChange={(e) => setDraft({ ...draft, acceptAnyUnit: e.target.checked })}
              />
              接受任意从站地址
              <span style={styles.inlineNote}>
                串口总线上挂多台设备时，用一个从站冒充整条总线比建 N 个会话省事
              </span>
            </label>

            <div style={styles.sectionLine}>故障注入（验证主站的容错分支）</div>
            <div style={styles.grid3}>
              <Field label="应答延迟(ms)">
                <input
                  style={field}
                  value={String(draft.responseDelayMs ?? 0)}
                  title="人为拖慢应答，用来验证主站的超时与重试设置是否合理"
                  onChange={(e) => setDraft({ ...draft, responseDelayMs: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label="丢包率(%)">
                <input
                  style={field}
                  value={String(Math.round((draft.dropRate ?? 0) * 100))}
                  title="按比例丢弃请求，模拟链路不稳导致的偶发超时"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      dropRate: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100
                    })
                  }
                />
              </Field>
              <Field label="强制异常码">
                <Select
                  style={{ width: '100%' }}
                  value={draft.exception?.enabled ? String(draft.exception.code) : ''}
                  searchable={false}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      exception: v
                        ? { enabled: true, code: Number(v), funcs: draft.exception?.funcs ?? [] }
                        : { enabled: false, code: draft.exception?.code ?? 4, funcs: [] }
                    })
                  }
                  options={[
                    { value: '', label: '不注入' },
                    { value: '1', label: '01 非法功能码' },
                    { value: '2', label: '02 非法数据地址' },
                    { value: '3', label: '03 非法数据值' },
                    { value: '4', label: '04 从站设备故障' },
                    { value: '6', label: '06 从站设备忙' },
                    { value: '11', label: '0B 网关目标无响应' }
                  ]}
                />
              </Field>
            </div>
          </div>
        )}

        <div style={styles.footer}>
          {tab === 'link' ? (
            dirtyLink && <span style={styles.dirty}>链路参数已修改，应用后会重启监听</span>
          ) : (
            <span style={styles.note}>
              {tab === 'regions' ? '数据区改动已即时生效' : '也可在发送区输入「holding 5 1234」快速置值'}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button style={btnSecondary} onClick={onClose}>
            关闭
          </button>
          {tab === 'link' && (
            <button style={btnPrimary} disabled={!dirtyLink} onClick={applyLink}>
              应用并重启监听
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 一个数据区的值网格。
 *
 * 为什么用网格而不是一行一个输入框：一个区常有几十上百个地址，纵向排列要滚很久
 * 才能找到目标地址。网格按每行 10 个排，地址标签放行首，找 addr 37 就是「第 4 行第 8 格」。
 *
 * 超过 200 个地址只显示前 200 个：再多的话 DOM 数量会明显拖慢面板，
 * 而手动改值本身也不会一次改上百个。需要批量变化的场景应该用自动变化。
 */
function RegionGrid({
  region,
  values,
  onWrite
}: {
  region: ModbusSlaveRegion
  values: number[]
  onWrite: (addr: number, value: number) => void
}): JSX.Element {
  const [editing, setEditing] = useState<number | null>(null)
  const [text, setText] = useState('')
  const bit = isBitArea(region.area)
  const LIMIT = 200
  const shown = Math.min(region.count, LIMIT)

  const commit = (addr: number): void => {
    const n = Number(text)
    if (Number.isFinite(n)) onWrite(addr, n)
    setEditing(null)
    setText('')
  }

  return (
    <div style={grid.wrap}>
      <div style={grid.head}>
        <b>{region.name || AREA_LABEL[region.area]}</b>
        <span style={grid.meta}>
          {AREA_LABEL[region.area]} · {region.start}–{region.start + region.count - 1}
          {region.readOnly ? ' · 只读' : ''}
          {region.animate && region.animate !== 'none' ? ' · ' + ANIMATE_LABEL[region.animate] : ''}
        </span>
        {region.count > LIMIT && (
          <span style={grid.meta}>仅显示前 {LIMIT} 个地址</span>
        )}
      </div>
      <div style={grid.cells}>
        {Array.from({ length: shown }, (_, i) => {
          const addr = region.start + i
          const v = values[i] ?? 0
          if (editing === addr) {
            return (
              <input
                key={addr}
                autoFocus
                style={grid.input}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => commit(addr)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(addr)
                  if (e.key === 'Escape') {
                    setEditing(null)
                    setText('')
                  }
                }}
              />
            )
          }
          return (
            <button
              key={addr}
              style={{ ...grid.cell, ...(bit && v ? grid.cellOn : {}) }}
              title={'地址 ' + addr + (bit ? '（点击翻转）' : '（点击输入新值）')}
              onClick={() => {
                // 位区只有两个取值，弹输入框纯属多余，点一下直接翻转
                if (bit) {
                  onWrite(addr, v ? 0 : 1)
                  return
                }
                setEditing(addr)
                setText(String(v))
              }}
            >
              <span style={grid.addr}>{addr}</span>
              <span style={grid.val}>{v}</span>
            </button>
          )
        })}
      </div>
    </div>
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
    width: 'min(1320px, 96vw)',
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
  body: { overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 6 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 4 },
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
  empty: { fontSize: 'var(--fs-sm)', color: 'var(--text-2)', padding: '14px 0' },
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
  fieldWrap: { display: 'flex', flexDirection: 'column', gap: 4 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 },
  checkLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 'var(--fs-sm)',
    color: 'var(--text-1)',
    marginTop: 4
  },
  inlineNote: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  sectionLine: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--border-subtle)',
    fontSize: 'var(--fs-sm)',
    fontWeight: 600,
    color: 'var(--text-1)'
  },
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

const grid: Record<string, React.CSSProperties> = {
  wrap: {
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-md)',
    padding: 10,
    marginBottom: 8
  },
  head: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, fontSize: 'var(--fs-sm)' },
  meta: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  cells: { display: 'grid', gridTemplateColumns: 'repeat(10, minmax(0, 1fr))', gap: 4 },
  cell: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 1,
    padding: '3px 4px',
    background: 'var(--bg-inset)',
    color: 'var(--text-0)',
    border: '1px solid transparent',
    borderRadius: 'var(--r-xs)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-xs)',
    textAlign: 'left'
  },
  cellOn: { background: 'var(--selected-strong-bg)' },
  addr: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)' },
  val: { fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' },
  input: {
    ...fieldSm,
    width: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--fs-xs)'
  }
}
