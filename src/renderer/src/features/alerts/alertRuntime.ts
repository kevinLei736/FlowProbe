import type { AlertEvent, ConnectionKind, Frame } from '@shared/protocol'
import { base64ToBytes } from '../sessions/frameExport'
import { useProtoTemplates } from '../../store/useProtoTemplates'
import { evalRule, snapshotHex, type EvalContext } from './alertEval'
import { lastFired, markCooldown } from './cooldown'
import { markFired, useAlerts } from './useAlerts'

/**
 * 告警运行时：把规则判定接到「收帧」这条路径上。
 *
 * 三个刻意的性能取舍，因为这段代码在高吞吐下每秒会被调用上千次：
 *
 * 1. 没有启用的规则时第一行就返回，连字节解码都不做——绝大多数用户绝大多数时间
 *    并没有配告警，这条路径必须等于零成本。
 * 2. 冷却判定走 cooldown.ts 的模块级 Map 而不是读 store：store 里的 lastFiredAt 要经过
 *    localStorage 持久化，放在热路径上会把写盘变成每帧一次。
 * 3. 命中统计与事件落档都攒起来批量提交（FLUSH_MS），
 *    否则一条异常报文连着来几百条时，界面会被 setState 淹掉。
 */

/** 命中统计与事件的提交间隔。200ms 肉眼无感，又足以把连续命中合成一批 */
const FLUSH_MS = 200

/** 复用一个解码器实例：每帧新建 TextDecoder 在高吞吐下是可观的额外开销 */
const decoder = new TextDecoder('utf-8', { fatal: false })

let pendingEvents: AlertEvent[] = []
let pendingRuleIds: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** 本批要停掉的会话。同一批里同一个会话只停一次 */
let pendingStops = new Set<string>()

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const events = pendingEvents
    const ruleIds = pendingRuleIds
    const stops = pendingStops
    pendingEvents = []
    pendingRuleIds = []
    pendingStops = new Set()
    if (events.length > 0) useAlerts.getState().pushEvents(events)
    if (ruleIds.length > 0) markFired(ruleIds, Date.now())
    for (const id of stops) void window.toolbox.stopSession(id)
  }, FLUSH_MS)
}

/**
 * 判定一条报文并就地打上告警标记。
 *
 * 直接改传入的 frame 而不是返回副本：frame 刚从 IPC 反序列化出来，
 * 还没进入任何 React 状态，此时没有别的持有者，改它是安全的；
 * 复制一份则会在高吞吐下多出成千上万个短命对象。
 */
export function annotateFrame(frame: Frame, kind: ConnectionKind, sessionName: string): void {
  const { rules } = useAlerts.getState()
  if (rules.length === 0) return
  // 系统日志没有原始字节，任何基于字段/校验的规则都无从判定
  if (frame.direction === 'system' || !frame.rawBase64) return

  const active = rules.filter((r) => r.enabled)
  if (active.length === 0) return

  const bytes = base64ToBytes(frame.rawBase64)
  if (bytes.length === 0) return

  /*
    文本判定按字节解码，而不是复用 frame.text。
    字节流适配器（TCP / 串口）入帧时 encoding 是 'hex'，frame.text 里躺的是
    十六进制串，用它做关键字匹配永远不会命中。这里统一按 UTF-8 解码，
    与界面 TEXT 视图看到的内容一致，用户配「包含 ALARM」才符合直觉。
    fatal:false 让非法字节退化成替换字符而不是抛错，二进制报文也能安全参与文本判定。
  */
  const decoded = decoder.decode(bytes)

  const ctx: EvalContext = {
    bytes,
    text: decoded,
    direction: frame.direction,
    kind,
    sessionId: frame.sessionId,
    templates: useProtoTemplates.getState().templates
  }

  const now = Date.now()
  for (const rule of active) {
    const detail = evalRule(rule, ctx)
    if (!detail) continue

    /*
      冷却在「命中之后」判断而不是之前：先判定再看冷却，规则的命中次数才真实。
      否则统计会随冷却设置变化，用户没法用它确认「规则到底在不在生效」。
    */
    const last = lastFired(rule.id)
    const cooling = rule.cooldownSec > 0 && now - last < rule.cooldownSec * 1000

    pendingRuleIds.push(rule.id)
    if (!cooling) {
      markCooldown(rule.id, now)
      pendingEvents.push({
        id: Math.random().toString(36).slice(2),
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        sessionId: frame.sessionId,
        sessionName,
        frameId: frame.id,
        ts: frame.ts,
        direction: frame.direction,
        detail,
        snapshotHex: snapshotHex(bytes),
        // 快照里存解码文本而不是 frame.text，理由同上：HEX 串对人没有阅读价值
        snapshotText: decoded.slice(0, 200)
      })
      if (rule.notify) {
        void window.toolbox.notify(
          (rule.severity === 'error' ? '报文告警：' : '报文提醒：') + rule.name,
          sessionName + ' · ' + detail
        )
      }
      if (rule.stopSession) pendingStops.add(frame.sessionId)
    }

    /*
      高亮只留第一条命中的规则。一行报文同时触发多条规则时，
      把它们都堆到行尾会把报文内容挤出可视区；告警中心里能看到全部。
      error 优先于 warn：更严重的那条更值得占用这个位置。
    */
    if (rule.highlight && (!frame.alert || (rule.severity === 'error' && frame.alert.severity !== 'error'))) {
      frame.alert = { ruleId: rule.id, ruleName: rule.name, severity: rule.severity, detail }
    }
    scheduleFlush()
  }
}
