import type { Encoding, Frame, ProtoTemplate } from '@shared/protocol'
import { base64ToBytes } from './frameExport'
import { parseByTemplate, pickTemplate, type ParsedFrame } from './protoParse'

/**
 * 把一条报文按模板解析成字段表。
 * selection: '' 关闭、'auto' 按前缀自动匹配、其他为指定模板 id。
 */
export function resolveParsed(
  frame: Pick<Frame, 'rawBase64' | 'direction'>,
  templates: ProtoTemplate[],
  selection: string
): ParsedFrame | null {
  if (!selection || !frame.rawBase64) return null
  const bytes = base64ToBytes(frame.rawBase64)
  if (bytes.length === 0) return null
  const dir = frame.direction === 'tx' ? 'tx' : frame.direction === 'rx' ? 'rx' : 'system'
  const tpl =
    selection === 'auto'
      ? pickTemplate(templates, bytes, dir)
      : templates.find((t) => t.id === selection) ?? null
  if (!tpl || tpl.fields.length === 0) return null
  return parseByTemplate(bytes, tpl)
}

export function ProtoFieldTable({ parsed }: { parsed: ParsedFrame }): JSX.Element {
  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <span style={s.tplName}>{parsed.templateName}</span>
        {parsed.checksum && (
          <span
            style={{
              ...s.ck,
              color: parsed.checksum.ok ? 'var(--conn-ok)' : 'var(--conn-error)',
              borderColor: parsed.checksum.ok ? 'var(--conn-ok)' : 'var(--conn-error)'
            }}
            title={'期望 ' + parsed.checksum.expected + ' / 实际 ' + parsed.checksum.actual}
          >
            {ckLabel(parsed.checksum.kind)} {parsed.checksum.ok ? '校验通过' : '校验不符'}
          </span>
        )}
      </div>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={{ ...s.th, width: 54 }}>偏移</th>
            <th style={s.th}>字段</th>
            <th style={{ ...s.th, width: 118 }}>字节</th>
            <th style={s.th}>值</th>
          </tr>
        </thead>
        <tbody>
          {parsed.fields.map((f, i) => (
            <tr key={f.name + i}>
              <td style={{ ...s.td, color: 'var(--text-2)' }}>
                {f.offset}
                {f.size > 1 ? '~' + (f.offset + f.size - 1) : ''}
              </td>
              <td style={s.td} title={f.note}>
                {f.name}
                {f.note ? <span style={s.note}> {f.note}</span> : null}
              </td>
              <td style={{ ...s.td, color: 'var(--text-2)', wordBreak: 'break-all' }}>{f.raw || '—'}</td>
              <td style={{ ...s.td, color: f.truncated ? 'var(--conn-error)' : 'var(--text-0)', wordBreak: 'break-all' }}>
                {f.value}
                {f.unit ? <span style={s.unit}> {f.unit}</span> : null}
                {f.truncated ? <span style={s.warn}> (字节不足)</span> : null}
              </td>
            </tr>
          ))}
          {parsed.restHex && (
            <tr>
              <td style={{ ...s.td, color: 'var(--text-2)' }}>—</td>
              <td style={{ ...s.td, color: 'var(--text-2)' }}>未解析尾部</td>
              <td style={{ ...s.td, color: 'var(--text-2)', wordBreak: 'break-all' }} colSpan={2}>
                {parsed.restHex}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ckLabel(kind: string): string {
  if (kind === 'sum8') return '和校验'
  if (kind === 'xor8') return '异或校验'
  if (kind === 'crc16-modbus') return 'CRC16'
  return ''
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '4px 0 8px 44px',
    padding: '6px 8px',
    background: 'var(--bg-2)',
    border: '1px dashed var(--border)',
    borderRadius: 'var(--r-sm)'
  },
  head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  tplName: { fontSize: 'var(--fs-xs)', color: 'var(--text-1)', fontWeight: 600 },
  ck: { fontSize: 'var(--fs-micro)', lineHeight: '15px', padding: '0 5px', border: '1px solid', borderRadius: 'var(--r-xs)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' },
  th: {
    textAlign: 'left',
    padding: '2px 6px',
    color: 'var(--text-2)',
    fontWeight: 500,
    borderBottom: '1px solid var(--border)'
  },
  td: { padding: '2px 6px', verticalAlign: 'top' },
  note: { color: 'var(--text-2)', fontSize: 'var(--fs-micro)' },
  unit: { color: 'var(--text-2)' },
  warn: { color: 'var(--conn-error)' }
}
