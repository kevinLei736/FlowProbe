/**
 * 告警冷却台账。
 *
 * 单独成模块是为了打断循环引用：运行时要写冷却，而 store 在规则被编辑时要清冷却，
 * 两边互相 import 会让模块初始化顺序变得依赖打包器实现。把这份可变状态放在
 * 最底层、谁都可以依赖的地方，依赖图就是单向的。
 *
 * 用模块级 Map 而不是放进 store：冷却判定在收帧热路径上每帧都要查，
 * 而 store 的每次写入都会连带 localStorage 持久化。
 */
const fired = new Map<string, number>()

export function lastFired(ruleId: string): number {
  return fired.get(ruleId) ?? 0
}

export function markCooldown(ruleId: string, at: number): void {
  fired.set(ruleId, at)
}

/**
 * 清冷却。规则被编辑或删除后必须调用。
 *
 * 不清会出现最容易被当成 bug 的现象：用户把阈值从 80 改成 20，
 * 报文明显超了却没有告警——实际是上一次命中的冷却还没过。
 */
export function clearCooldown(ruleId?: string): void {
  if (ruleId) fired.delete(ruleId)
  else fired.clear()
}
