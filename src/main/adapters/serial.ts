import { SerialPort } from 'serialport'
import type { ConnectionKind, OutgoingFrame, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { FrameSplitter, encodeContent } from '../codec/framing'
import { Backoff, formatWait, normalizeBackoff } from './reconnect'

type Parity = 'none' | 'even' | 'odd' | 'mark' | 'space'

export class SerialAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'serial'
  private port: SerialPort | null = null
  private splitter: FrameSplitter | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private backoff: Backoff
  private manualStop = false
  private everOpened = false

  constructor(id: string, config: SessionConfig) {
    super(id, config)
    this.backoff = new Backoff(normalizeBackoff(config))
  }

  async start(): Promise<void> {
    this.manualStop = false
    this.everOpened = false
    this.backoff.update(normalizeBackoff(this.config))
    this.backoff.reset()
    await this.open()
  }

  private async open(): Promise<void> {
    const path = String(this.config.serialPath ?? 'COM1')
    const baudRate = Number(this.config.baudRate ?? 115200)
    this.emitStatus('connecting', `正在打开 ${path} @ ${baudRate}`)

    this.splitter = new FrameSplitter(
      this.config.framing ?? { mode: 'none' },
      (frame) => {
        this.emitData('rx', frame, 'hex')
        void this.runMock(frame, (bytes) => this.port?.write(bytes))
      }
    )

    try {
      const port = new SerialPort({
        path,
        baudRate,
        dataBits: (Number(this.config.dataBits ?? 8) as 5 | 6 | 7 | 8),
        stopBits: (Number(this.config.stopBits ?? 1) as 1 | 1.5 | 2),
        parity: (this.config.parity as Parity) ?? 'none',
        rtscts: Boolean(this.config.rtscts ?? false),
        xon: Boolean(this.config.xon ?? false),
        xoff: Boolean(this.config.xoff ?? false),
        autoOpen: false
      })
      this.port = port

      port.on('data', (chunk: Buffer) => {
        const frames = this.splitter!.push(chunk)
        for (const f of frames) {
          this.emitData('rx', f, 'hex')
          void this.runMock(f, (bytes) => this.port?.write(bytes))
        }
      })
      port.on('error', (err: Error) => this.emitError(err.message))
      port.on('close', () => {
        this.stopLineStatusPolling()
        this.emitStatus('closed', '串口已关闭')
        if (this.manualStop) {
          this.emitConn('串口已关闭（手动停止）', 'info')
          return
        }
        // 拔线/驱动异常导致的意外关闭：按退避重开
        this.emitConn(this.everOpened ? '串口意外断开' : '串口未打开', 'warn')
        this.scheduleReopen()
      })

      await new Promise<void>((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()))
      })

      // 初始 DTR/RTS 电平
      const dtr = this.config.dtr
      const rts = this.config.rts
      if (typeof dtr === 'boolean' || typeof rts === 'boolean') {
        await new Promise<void>((resolve) =>
          port.set(
            { dtr: dtr as boolean | undefined, rts: rts as boolean | undefined },
            () => resolve()
          )
        )
      }

      const retried = this.backoff.attempts
      this.backoff.reset()
      this.everOpened = true
      this.emitStatus('connected', `已打开 ${path}`)
      this.emitConn(
        `串口已打开 ${path} @ ${baudRate}` + (retried > 0 ? `（重试第 ${retried} 次后成功）` : ''),
        'success'
      )
      this.startLineStatusPolling()
    } catch (e) {
      const msg = (e as Error).message
      this.emitError(msg)
      this.emitStatus('error', msg)
      this.scheduleReopen()
    }
  }

  private scheduleReopen(): void {
    if (!this.config.autoReconnect || this.manualStop) return
    const planned = this.backoff.schedule(() => void this.open())
    if (!planned) {
      const limit = normalizeBackoff(this.config).maxAttempts
      this.emitConn(`已重试 ${limit} 次仍无法打开串口，停止重试`, 'error')
      this.emitStatus('error', '重试次数已用尽')
      return
    }
    this.emitConn(`第 ${planned.attempt} 次重试将在 ${formatWait(planned.delayMs)} 后开始`, 'warn')
  }

  private stopLineStatusPolling(): void {
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null
  }

  private startLineStatusPolling(): void {
    this.statusTimer = setInterval(() => {
      this.port?.get((err, status) => {
        if (err || !status) return
        const flags = [
          status.cts ? 'CTS' : '',
          status.dsr ? 'DSR' : '',
          status.dcd ? 'DCD' : ''
        ].filter(Boolean)
        this.emit('event', {
          type: 'metrics',
          sessionId: this.id,
          metrics: { ...this.getMetrics() }
        })
        void flags
      })
    }, 2000)
  }

  async send(out: OutgoingFrame): Promise<void> {
    if (!this.port || !this.port.isOpen) {
      this.emitError('串口未打开，无法发送')
      return
    }
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    await new Promise<void>((resolve, reject) =>
      this.port!.write(bytes, (err) => (err ? reject(err) : resolve()))
    )
    this.emitData('tx', bytes, out.encoding)
  }

  async stop(): Promise<void> {
    this.manualStop = true
    this.backoff.cancel()
    this.stopLineStatusPolling()
    this.splitter?.dispose()
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => this.port!.close(() => resolve()))
    }
    this.port = null
  }
}

export async function listSerialPorts(): Promise<string[]> {
  const ports = await SerialPort.list()
  return ports.map((p) => p.path)
}
