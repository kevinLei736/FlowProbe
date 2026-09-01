import { useMemo, useState } from 'react'
import type { ConnectionKind, ProtoChecksum, ProtoFieldType } from '@shared/protocol'
import { KIND_CAPS, KIND_META } from '../../app/meta'
import { templateFitsKind, useProtoTemplates } from '../../store/useProtoTemplates'
import { hexToBytes, parseByTemplate } from './protoParse'
import { ProtoFieldTable } from './ProtoFieldTable'
import { Select } from '../../components/ui/Select'

const TYPES: [ProtoFieldType, string][] = [
  ['uint8', 'uint8'],
  ['int8', 'int8'],
  ['uint16', 'uint16'],
  ['int16', 'int16'],
  ['uint32', 'uint32'],
  ['int32', 'int32'],
  ['float32', 'float32'],
  ['float64', 'float64'],
  ['hex', 'HEX 串'],
  ['ascii', 'ASCII'],
  ['bcd', 'BCD'],
  ['bits', '位图']
]

const CHECKSUMS: [ProtoChecksum, string][] = [
  ['none', '无校验'],
  ['sum8', '和校验 (1B)'],
  ['xor8', '异或校验 (1B)'],
  ['crc16-modbus', 'CRC16-Modbus (2B)']
]

/**
 * 可以挂协议模板的连接类型。
 *
 * HTTP Mock 走的是路由与响应体，不存在「按字节拆帧」这回事，所以不出现在归属选项里 ——
 * 归属选项本身就该只列真正能用上的模块，否则又变成一堆无意义的勾选。
 */
const TEMPLATE_KINDS = (Object.keys(KIND_CAPS) as ConnectionKind[]).filter(
  (k) => KIND_CAPS[k].protoTemplate
)

const VARIABLE = new Set<ProtoFieldType>(['hex', 'ascii', 'bcd', 'bits'])
const MULTI = new Set<ProtoFieldType>(['uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'])
const NUMERIC = new Set<ProtoFieldType>([
  'uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'float32', 'float64'
])

/**
 * 协议模板编辑器：定义帧结构，并用样例报文即时预览解析结果。
 *
 * kind 是打开面板的那个会话的连接类型。它决定两件事：新建模板默认归属谁，
 * 以及列表默认只显示本模块的模板 —— 用户在串口会话里翻模板时，不该看到一堆 Modbus 专用帧。
 */
export function ProtoTemplatePanel({ onClose, kind }: { onClose: () => void; kind?: ConnectionKind }): JSX.Element {
  const templates = useProtoTemplates((s) => s.templates)
  const add = useProtoTemplates((s) => s.add)
  const update = useProtoTemplates((s) => s.update)
  const remove = useProtoTemplates((s) => s.remove)
  const duplicate = useProtoTemplates((s) => s.duplicate)
  const addField = useProtoTemplates((s) => s.addField)
  const updateField = useProtoTemplates((s) => s.updateField)
  const removeField = useProtoTemplates((s) => s.removeField)
  const moveField = useProtoTemplates((s) => s.moveField)

  // 默认只看本模块：真正需要跨模块整理时再切「全部」
  const [scope, setScope] = useState<'kind' | 'all'>(kind ? 'kind' : 'all')
  const shown = useMemo(
    () => (scope === 'kind' && kind ? templates.filter((t) => templateFitsKind(t, kind)) : templates),
    [templates, scope, kind]
  )
  const [selId, setSelId] = useState<string | null>(shown[0]?.id ?? templates[0]?.id ?? null)
  const [sample, setSample] = useState('AA 55 01 04 00 FA 03 11 22 33 44')

  const sel = templates.find((t) => t.id === selId) ?? null

  /** 切换某个模块的归属。全部取消 = 通用模板（对所有模块可见） */
  const toggleKind = (k: ConnectionKind): void => {
    if (!sel) return
    const cur = sel.kinds ?? []
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]
    update(sel.id, { kinds: next })
  }

  const preview = useMemo(() => {
    if (!sel || sel.fields.length === 0) return null
    const bytes = hexToBytes(sample)
    if (bytes.length === 0) return null
    return parseByTemplate(bytes, sel)
  }, [sel, sample])

  return (
    <div style={st.overlay} onClick={onClose}>
      <div style={st.panel} onClick={(e) => e.stopPropagation()}>
        <div style={st.header}>
          <span style={st.title}>协议解析模板</span>
          <span style={st.hint}>
            定义帧结构，报文时间轴即可展开成字段表{kind ? ' · 当前模块：' + KIND_META[kind].label : ''}
          </span>
          <button style={st.close} onClick={onClose}>✕</button>
        </div>

        <div style={st.body}>
          <div style={st.listCol}>
            {/* 新建时带上当前模块归属：绝大多数模板都是为手头这个协议写的 */}
            <button style={st.addBtn} onClick={() => setSelId(add(kind ? [kind] : []).id)}>+ 新建模板</button>
            {kind && (
              <div style={st.scopeRow}>
                {([['kind', '本模块'], ['all', '全部模板']] as [typeof scope, string][]).map(([v, l]) => (
                  <button
                    key={v}
                    style={{ ...st.scopeBtn, ...(scope === v ? st.scopeOn : {}) }}
                    onClick={() => setScope(v)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
            <div style={st.list}>
              {shown.length === 0 && <div style={st.empty}>该模块暂无模板</div>}
              {shown.map((t) => (
                <button
                  key={t.id}
                  style={{ ...st.listItem, ...(t.id === selId ? st.listActive : {}) }}
                  onClick={() => setSelId(t.id)}
                >
                  <span style={st.itemName}>{t.name}</span>
                  <span style={st.itemMeta}>
                    {t.matchPrefixHex ? t.matchPrefixHex.toUpperCase() : '不限前缀'} · {t.fields.length} 字段
                  </span>
                  <span style={st.itemScope}>
                    {!t.kinds || t.kinds.length === 0
                      ? '通用'
                      : t.kinds.map((k) => KIND_META[k].label).join(' / ')}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div style={st.detail}>
            {!sel && <div style={st.empty}>选择或新建一个模板</div>}
            {sel && (
              <>
                <div style={st.row}>
                  <input style={st.nameInput} value={sel.name} onChange={(e) => update(sel.id, { name: e.target.value })} />
                  <button style={st.ghost} onClick={() => duplicate(sel.id)}>复制</button>
                  <button style={st.del} onClick={() => { remove(sel.id); setSelId(null) }}>删除</button>
                </div>

                {/* 归属放在最前面：它决定这套字段会出现在哪些模块的解析下拉里，
                    是比前缀、校验更上层的判断，先说清楚才不会又混到别的协议上 */}
                <div style={st.scopeBox}>
                  <div style={st.row}>
                    <span style={st.sectionTitle}>适用模块</span>
                    <span style={st.lbl}>
                      {(sel.kinds ?? []).length === 0 ? '不勾选 = 通用模板，所有模块都能选' : '仅在勾选的模块里可选'}
                    </span>
                  </div>
                  <div style={st.chips}>
                    {TEMPLATE_KINDS.map((k) => {
                      const on = (sel.kinds ?? []).includes(k)
                      return (
                        <button
                          key={k}
                          style={{ ...st.chip, ...(on ? st.chipOn : {}) }}
                          onClick={() => toggleKind(k)}
                        >
                          {KIND_META[k].label}
                        </button>
                      )
                    })}
                    {(sel.kinds ?? []).length > 0 && (
                      <button style={st.chipClear} onClick={() => update(sel.id, { kinds: [] })}>
                        设为通用
                      </button>
                    )}
                  </div>
                </div>

                <div style={st.row}>
                  <label style={st.lbl}>匹配前缀</label>
                  <input
                    style={st.mini}
                    value={sel.matchPrefixHex ?? ''}
                    placeholder="如 AA55，留空不限"
                    onChange={(e) => update(sel.id, { matchPrefixHex: e.target.value })}
                  />
                  <label style={st.lbl}>方向</label>
                  <Select
  value={sel.direction ?? 'any'}
  onChange={(v) => update(sel.id, { direction: v as 'any' | 'tx' | 'rx' })}
  style={st.sel}
  options={[{ value: "any", label: "收发都解析" }, { value: "tx", label: "仅发送" }, { value: "rx", label: "仅接收" }]}
/>
                  <label style={st.lbl}>尾部校验</label>
                  <Select
                    size="sm"
                    value={sel.checksum ?? 'none'}
                    onChange={(v) => update(sel.id, { checksum: v as ProtoChecksum })}
                    options={CHECKSUMS.map(([v, l]) => ({ value: v, label: l }))}
                  />
                </div>

                <div style={st.fieldsHead}>
                  <span style={st.sectionTitle}>字段（按顺序解析）</span>
                  <span style={st.spacer} />
                  <button style={st.ghost} onClick={() => addField(sel.id)}>+ 添加字段</button>
                </div>

                <div style={st.fields}>
                  {sel.fields.map((f, i) => (
                    <div key={f.id} style={st.fieldCard}>
                      <div style={st.row}>
                        <span style={st.idx}>{i + 1}</span>
                        <input style={st.fname} value={f.name} onChange={(e) => updateField(sel.id, f.id, { name: e.target.value })} placeholder="字段名" />
                        <Select
                          size="sm"
                          value={f.type}
                          onChange={(v) => updateField(sel.id, f.id, { type: v as ProtoFieldType })}
                          options={TYPES.map(([v, l]) => ({ value: v, label: l }))}
                        />
                        {VARIABLE.has(f.type) && (
                          <input
                            style={st.num}
                            value={String(f.length ?? 0)}
                            title="字节长度，0 表示吃掉剩余字节"
                            onChange={(e) => updateField(sel.id, f.id, { length: Number(e.target.value) || 0 })}
                          />
                        )}
                        {MULTI.has(f.type) && (
                          <Select
  value={f.bigEndian === false ? 'le' : 'be'}
  onChange={(v) => updateField(sel.id, f.id, { bigEndian: v === 'be' })}
  style={st.sel}
  options={[{ value: "be", label: "大端" }, { value: "le", label: "小端" }]}
/>
                        )}
                        <span style={st.spacer} />
                        <button style={st.iconBtn} title="上移" onClick={() => moveField(sel.id, f.id, -1)}>↑</button>
                        <button style={st.iconBtn} title="下移" onClick={() => moveField(sel.id, f.id, 1)}>↓</button>
                        <button style={st.iconBtn} title="删除字段" onClick={() => removeField(sel.id, f.id)}>✕</button>
                      </div>
                      <div style={st.row}>
                        {NUMERIC.has(f.type) && (
                          <>
                            <label style={st.lbl}>倍率</label>
                            <input style={st.num} value={String(f.scale ?? 1)} title="显示值 = 原始值 × 倍率 + 偏移" onChange={(e) => updateField(sel.id, f.id, { scale: Number(e.target.value) || 0 })} />
                            <label style={st.lbl}>偏移</label>
                            <input style={st.num} value={String(f.offset ?? 0)} onChange={(e) => updateField(sel.id, f.id, { offset: Number(e.target.value) || 0 })} />
                            <input style={st.unit} value={f.unit ?? ''} placeholder="单位" onChange={(e) => updateField(sel.id, f.id, { unit: e.target.value })} />
                            <label style={st.chartLbl} title="把该字段的数值随时间绘制成曲线">
                              <input type="checkbox" checked={f.chart === true} onChange={(e) => updateField(sel.id, f.id, { chart: e.target.checked })} />
                              曲线
                            </label>
                          </>
                        )}
                        <input style={st.note} value={f.note ?? ''} placeholder="备注（可空）" onChange={(e) => updateField(sel.id, f.id, { note: e.target.value })} />
                      </div>
                      {NUMERIC.has(f.type) && (
                        <input
                          style={st.enumInput}
                          value={f.enumMap ?? ''}
                          placeholder="枚举映射，如 0=关机,1=运行,2=故障（可空）"
                          onChange={(e) => updateField(sel.id, f.id, { enumMap: e.target.value })}
                        />
                      )}
                    </div>
                  ))}
                  {sel.fields.length === 0 && <div style={st.empty}>还没有字段，点「添加字段」开始</div>}
                </div>

                <div style={st.sectionTitle}>样例报文预览</div>
                <input
                  style={st.sample}
                  value={sample}
                  placeholder="粘贴 HEX 报文，如 AA 55 01 04 00 FA 03 11 22 33 44"
                  onChange={(e) => setSample(e.target.value)}
                />
                {preview ? <ProtoFieldTable parsed={preview} /> : <div style={st.empty}>输入 HEX 报文即可预览</div>}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const st: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay)', backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)', display: 'grid', placeItems: 'center', zIndex: 50 },
  panel: { width: 900, maxWidth: '95vw', height: 660, maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  header: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--border)' },
  title: { fontWeight: 600 },
  hint: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  close: { marginLeft: 'auto', background: 'transparent', color: 'var(--text-1)', border: 'none', fontSize: 16 },
  body: { flex: 1, display: 'grid', gridTemplateColumns: '230px 1fr', minHeight: 0 },
  listCol: { display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)', minHeight: 0 },
  addBtn: { margin: 10, padding: '7px 10px', background: 'var(--btn-bg)', color: 'var(--btn-fg)', border: '1px solid transparent', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)' },
  list: { flex: 1, overflowY: 'auto', padding: '0 8px 8px' },
  listItem: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', alignItems: 'flex-start', padding: '7px 8px', marginBottom: 4, background: 'transparent', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', textAlign: 'left' },
  listActive: { background: 'var(--bg-3)', border: '1px solid transparent' },
  itemName: { fontSize: 'var(--fs-sm)' },
  itemMeta: { fontSize: 'var(--fs-micro)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  itemScope: { fontSize: 'var(--fs-micro)', color: 'var(--text-3)' },
  scopeRow: { display: 'flex', gap: 4, margin: '0 10px 8px', background: 'var(--bg-inset)', padding: 2, borderRadius: 'var(--r-sm)' },
  scopeBtn: { flex: 1, padding: '4px 6px', background: 'transparent', color: 'var(--text-2)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 'var(--fs-xs)' },
  scopeOn: { background: 'var(--bg-2)', color: 'var(--text-0)', boxShadow: 'var(--shadow-sm)' },
  scopeBox: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: { padding: '3px 10px', background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 12, fontSize: 'var(--fs-xs)' },
  chipOn: { background: 'var(--selected-strong-bg)', color: 'var(--text-0)', fontWeight: 500 },
  chipClear: { padding: '3px 10px', background: 'transparent', color: 'var(--text-2)', border: '1px dashed var(--border)', borderRadius: 12, fontSize: 'var(--fs-xs)' },
  detail: { display: 'flex', flexDirection: 'column', gap: 8, padding: 14, overflowY: 'auto', minHeight: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  nameInput: { flex: 1, minWidth: 160, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '5px 8px', fontSize: 'var(--fs-md)' },
  lbl: { fontSize: 'var(--fs-xs)', color: 'var(--text-2)' },
  mini: { width: 130, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  sel: { background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  fieldsHead: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 },
  sectionTitle: { fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-0)' },
  spacer: { flex: 1 },
  ghost: { background: 'var(--bg-3)', color: 'var(--text-0)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', padding: '4px 10px', fontSize: 'var(--fs-sm)' },
  del: { background: 'transparent', color: 'var(--error)', border: '1px solid var(--error)', borderRadius: 'var(--r-sm)', padding: '4px 10px', fontSize: 'var(--fs-sm)' },
  fields: { display: 'flex', flexDirection: 'column', gap: 6 },
  fieldCard: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, background: 'var(--bg-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' },
  idx: { width: 18, fontSize: 'var(--fs-xs)', color: 'var(--text-2)', fontFamily: 'var(--font-mono)' },
  fname: { width: 130, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)' },
  num: { width: 62, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  unit: { width: 62, background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 6px', fontSize: 'var(--fs-sm)' },
  note: { flex: 1, minWidth: 120, background: 'var(--field-bg)', color: 'var(--text-1)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)' },
  enumInput: { width: '100%', background: 'var(--field-bg)', color: 'var(--text-1)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '4px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  iconBtn: { width: 26, height: 24, background: 'var(--btn2-bg)', color: 'var(--text-2)', border: '1px solid transparent', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)' },
  sample: { width: '100%', background: 'var(--field-bg)', color: 'var(--text-0)', border: '1px solid var(--field-border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' },
  chartLbl: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--text-1)' },
  empty: { color: 'var(--text-2)', fontSize: 'var(--fs-sm)', padding: 16, textAlign: 'center' }
}
