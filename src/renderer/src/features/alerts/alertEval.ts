import type { AlertRule, ConnectionKind, Direction, ProtoTemplate } from '@shared/protocol'
import { bytesToHex, parseByTemplate, pickTemplate } from '../sessions/protoParse'

/**
 * 报文告警的判定内核。
 *
 * 刻意做成纯函数、不碰任何 store：判定要在「收帧」这条最热的路径上跑，
 * 每秒可能上千次。纯函数才能被安全地放进 store 的合批循环里，
 * 也才能单独用固定输入验证「82.4 > 80 会不会命中」这类边界。
 */

export interface EvalContext {
  bytes: Uint8Array
  /**
   * 报文的 UTF-8 可读文本。
   *
   * 必须由调用方按字节解码得到，不能直接用 Frame.text：TCP / 串口这些字节流
   * 适配器入帧时用的是 encoding='hex'，Frame.text 里存的是 "41424c41524d" 这样的
   * 十六进制串，拿它比对关键字永远匹配不上——这正是文本规则最初不生效的原因。
   */
  text: string
  direction: Direction
  kind: ConnectionKind
  sessionId: string
  templates: ProtoTemplate[]
}

/** 规则是否作用于这个会话与方向 */
export function ruleAppliesTo(rule: AlertRule, ctx: EvalContext): boolean {
  if (!rule.enabled) return false
  if (rule.direction !== 'any' && rule.direction !== ctx.direction) return false
  if (rule.sessionId) return rule.sessionId === ctx.sessionId
  if (rule.kinds.length === 0) return true
  return rule.kinds.includes(ctx.kind)
}

function num(v: string | undefined): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** 数值类判定。返回人话描述，null 表示没命中 */
function judgeNumber(rule: AlertRule, actual: number, label: string, unit?: string): string | null {
  const u = unit ? ' ' + unit : ''
  const a = num(rule.value)
  const b = num(rule.value2)
  const shown = Number.isInteger(actual) ? String(actual) : String(Number(actual.toFixed(6)))
  const hit = (op: string, ref: string): string => label + ' ' + shown + u + ' ' + op + ' ' + ref + u

  switch (rule.op) {
    case 'gt':
      return actual > a ? hit('>', String(a)) : null
    case 'gte':
      return actual >= a ? hit('≥', String(a)) : null
    case 'lt':
      return actual < a ? hit('<', String(a)) : null
    case 'lte':
      return actual <= a ? hit('≤', String(a)) : null
    case 'eq':
      return actual === a ? hit('=', String(a)) : null
    case 'ne':
      return actual !== a ? hit('≠', String(a)) : null
    case 'between':
      return actual >= a && actual <= b ? hit('落在', a + '~' + b) : null
    case 'outside':
      return actual < a || actual > b ? hit('超出', a + '~' + b) : null
    default:
      // 文本运算落到数值字段上：把值转成字符串再比，比直接不命中更符合预期
      return judgeText(rule, shown, label)
  }
}

/** 文本类判定 */
function judgeText(rule: AlertRule, actual: string, label: string): string | null {
  const kw = rule.value ?? ''
  const brief = actual.length > 48 ? actual.slice(0, 48) + '…' : actual
  switch (rule.op) {
    case 'contains':
      return kw !== '' && actual.includes(kw) ? label + ' 含「' + kw + '」' : null
    case 'notContains':
      return kw !== '' && !actual.includes(kw) ? label + ' 不含「' + kw + '」' : null
    case 'regex':
      if (kw === '') return null
      try {
        return new RegExp(kw).test(actual) ? label + ' 匹配 /' + kw + '/' : null
      } catch {
        // 正则写错不该让整条链路报错，静默跳过；规则编辑面板会给出提示
        return null
      }
    case 'eq':
      return actual === kw ? label + ' = ' + kw : null
    case 'ne':
      return actual !== kw ? label + ' ≠ ' + kw + '（实际 ' + brief + '）' : null
    default:
      return null
  }
}

/**
 * 判定单条规则，命中则返回可读的触发说明。
 *
 * 为什么返回字符串而不是布尔：告警列表里「命中了」几乎没有诊断价值，
 * 「温度 82.4 ℃ > 80 ℃」才有。把描述在判定当场生成，避免事后拿不到上下文。
 */
export function evalRule(rule: AlertRule, ctx: EvalContext): string | null {
  if (!ruleAppliesTo(rule, ctx)) return null

  if (rule.source === 'text') {
    return judgeText(rule, ctx.text, '报文文本')
  }

  if (rule.source === 'checksum') {
    const tpl = resolveTemplate(rule, ctx)
    if (!tpl) return null
    const parsed = parseByTemplate(ctx.bytes, tpl)
    if (!parsed.checksum) return null
    return parsed.checksum.ok
      ? null
      : '校验不符：期望 ' + parsed.checksum.expected + '，实际 ' + parsed.checksum.actual
  }

  // source = field
  if (!rule.field) return null
  const tpl = resolveTemplate(rule, ctx)
  if (!tpl) return null
  const parsed = parseByTemplate(ctx.bytes, tpl)
  const f = parsed.fields.find((x) => x.name === rule.field)
  if (!f || f.truncated) return null
  if (f.num !== undefined && Number.isFinite(f.num)) return judgeNumber(rule, f.num, f.name, f.unit)
  return judgeText(rule, f.value, f.name)
}

/** 规则指定模板或按前缀自动匹配。模板被删掉时静默跳过，不让规则拖着报错 */
function resolveTemplate(rule: AlertRule, ctx: EvalContext): ProtoTemplate | null {
  const dir = ctx.direction === 'tx' ? 'tx' : ctx.direction === 'rx' ? 'rx' : 'system'
  if (!rule.templateId || rule.templateId === 'auto') {
    return pickTemplate(ctx.templates, ctx.bytes, dir)
  }
  return ctx.templates.find((t) => t.id === rule.templateId) ?? null
}

/** 报文快照：HEX 存全量会让 localStorage 迅速膨胀，截断到 64 字节足够对照 */
export function snapshotHex(bytes: Uint8Array): string {
  const head = bytes.slice(0, 64)
  return bytesToHex(head) + (bytes.length > 64 ? ' …(共 ' + bytes.length + ' 字节)' : '')
}
