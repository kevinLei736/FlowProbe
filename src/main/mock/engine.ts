import * as vm from 'node:vm'
import type { Encoding, MockConfig, MockRule } from '@shared/protocol'
import { encodeContent } from '../codec/framing'

export interface MockResult {
  bytes: Buffer
  encoding: Encoding
  delayMs: number
  ruleName: string
}

/**
 * Mock 自动应答引擎：根据收到的字节，按规则顺序匹配并生成应答。
 * 支持 静态 / 模板 / 脚本 三种应答，及故障注入（丢包/额外延迟）。
 */
export class MockEngine {
  private seq = 0

  constructor(private config: MockConfig) {}

  update(config: MockConfig): void {
    this.config = config
  }

  isEnabled(): boolean {
    return this.config?.enabled === true
  }

  /** 返回应答（可能为空表示不应答/丢弃） */
  handle(incoming: Buffer): MockResult | null {
    if (!this.config?.enabled) return null

    const fault = this.config.fault
    if (fault?.enabled && fault.dropRate > 0 && Math.random() < fault.dropRate) {
      return null // 模拟丢包
    }

    const asText = incoming.toString('utf8')
    const asHex = incoming.toString('hex')

    for (const rule of this.config.rules) {
      if (!rule.enabled) continue
      if (this.matches(rule, asText, asHex)) {
        const body = this.buildResponse(rule, incoming)
        const extra = fault?.enabled ? Math.max(0, fault.extraDelayMs || 0) : 0
        return {
          bytes: body,
          encoding: rule.responseEncoding,
          delayMs: Math.max(0, (rule.delayMs || 0) + extra),
          ruleName: rule.name || '(未命名规则)'
        }
      }
    }
    return null
  }

  fallthrough(): boolean {
    return this.config?.fallthrough === true
  }

  private matches(rule: MockRule, asText: string, asHex: string): boolean {
    const subject = rule.matchEncoding === 'hex' ? asHex.toLowerCase() : asText
    const pattern = rule.matchEncoding === 'hex' ? rule.pattern.replace(/[^0-9a-fA-F]/g, '').toLowerCase() : rule.pattern
    switch (rule.matchType) {
      case 'any':
        return true
      case 'equals':
        return subject === pattern
      case 'contains':
        return subject.includes(pattern)
      case 'startsWith':
        return subject.startsWith(pattern)
      case 'hex':
        return asHex.toLowerCase().includes(pattern)
      case 'regex':
        try {
          return new RegExp(rule.pattern).test(asText)
        } catch {
          return false
        }
      default:
        return false
    }
  }

  private buildResponse(rule: MockRule, incoming: Buffer): Buffer {
    if (rule.responseType === 'static') {
      return encodeContent(rule.responseBody, rule.responseEncoding, rule.appendTerminator)
    }
    if (rule.responseType === 'template') {
      const text = this.applyTemplate(rule.responseBody, incoming)
      return encodeContent(text, rule.responseEncoding, rule.appendTerminator)
    }
    // script
    return this.runScript(rule, incoming)
  }

  private applyTemplate(tpl: string, incoming: Buffer): string {
    this.seq += 1
    return tpl
      .replace(/\{\{seq\}\}/g, String(this.seq))
      .replace(/\{\{now\}\}/g, new Date().toISOString())
      .replace(/\{\{ts\}\}/g, String(Date.now()))
      .replace(/\{\{rand\}\}/g, String(Math.floor(Math.random() * 1e6)))
      .replace(/\{\{echo\}\}/g, incoming.toString('utf8'))
      .replace(/\{\{echoHex\}\}/g, incoming.toString('hex'))
      .replace(/\{\{len\}\}/g, String(incoming.length))
  }

  private runScript(rule: MockRule, incoming: Buffer): Buffer {
    try {
      const sandbox: Record<string, unknown> = {
        data: incoming,
        text: incoming.toString('utf8'),
        hex: incoming.toString('hex'),
        Buffer,
        result: null as unknown
      }
      const context = vm.createContext(sandbox)
      // 用户脚本可对 data/text/hex 处理，把应答赋值给 result（string 或 Buffer）
      const wrapped = `result = (function(data, text, hex){\n${rule.responseBody}\n})(data, text, hex)`
      const script = new vm.Script(wrapped)
      script.runInContext(context, { timeout: 200 })
      const r = sandbox.result
      if (Buffer.isBuffer(r)) return r
      if (typeof r === 'string') return encodeContent(r, rule.responseEncoding, rule.appendTerminator)
      if (r == null) return Buffer.alloc(0)
      return Buffer.from(String(r), 'utf8')
    } catch (e) {
      return Buffer.from(`[mock script error] ${(e as Error).message}`, 'utf8')
    }
  }
}

export function defaultMockConfig(): MockConfig {
  return {
    enabled: false,
    rules: [],
    fault: { enabled: false, dropRate: 0, extraDelayMs: 0 },
    fallthrough: false
  }
}
