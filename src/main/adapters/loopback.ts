import type { ConnectionKind, OutgoingFrame, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'

/** 占位适配器：用于尚未接入真实内核的协议（WS/串口），保持回环演示。 */
export class LoopbackAdapter extends BaseAdapter {
  readonly kind: ConnectionKind

  constructor(id: string, config: SessionConfig, kind: ConnectionKind) {
    super(id, config)
    this.kind = kind
  }

  async start(): Promise<void> {
    this.emitStatus('connecting')
    setTimeout(() => {
      const status = this.kind === 'ws-server' ? 'listening' : 'connected'
      this.emitStatus(status)
      this.emitSystem('连接已建立（占位回环模式，待后续里程碑接入真实内核）')
    }, 200)
  }

  async send(out: OutgoingFrame): Promise<void> {
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    this.emitData('tx', bytes, out.encoding)
    setTimeout(() => this.emitData('rx', bytes, out.encoding, { id: 'loopback', label: '回环' }), 100)
  }

  async stop(): Promise<void> {
    this.emitStatus('closed')
    this.emitSystem('连接已关闭')
  }
}
