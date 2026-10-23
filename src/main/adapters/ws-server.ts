import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'
import type { ConnectionKind, OutgoingFrame, Peer, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { encodeContent } from '../codec/framing'
import { describeListenError } from './net-error'

interface Client {
  peer: Peer
  ws: WebSocket
}

export class WsServerAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'ws-server'
  private wss: WebSocketServer | null = null
  private clients = new Map<string, Client>()

  constructor(id: string, config: SessionConfig) {
    super(id, config)
  }

  async start(): Promise<void> {
    const port = Number(this.config.port ?? 0)
    const host = String(this.config.host ?? '0.0.0.0')
    const path = String(this.config.path ?? '/')
    this.emitStatus('connecting', `正在监听 ${host}:${port}${path}`)

    try {
      const wss = new WebSocketServer({ port, host, path })
      this.wss = wss

      wss.on('connection', (ws, req) => this.handleClient(ws, req))
      wss.on('error', (err: Error) => {
        const msg = describeListenError(err, host, port)
        this.emitError(msg)
        this.emitStatus('error', msg)
        if (!wss.address()) {
          try {
            wss.close()
          } catch {
            // 忽略关闭异常
          }
          if (this.wss === wss) this.wss = null
        }
      })
      wss.on('listening', () => {
        this.emitStatus('listening', `监听中 ${host}:${port}${path}`)
        this.emitConn(`WebSocket 服务端已启动 ${host}:${port}${path}`, 'success')
      })
    } catch (e) {
      const msg = (e as Error).message
      this.emitError(msg)
      this.emitStatus('error', msg)
    }
  }

  private handleClient(ws: WebSocket, req: { socket: { remoteAddress?: string; remotePort?: number } }): void {
    const max = Number(this.config.maxConnections ?? 0)
    if (max > 0 && this.clients.size >= max) {
      ws.close(1013, 'server busy')
      this.emitConn(`达到最大连接数 ${max}，拒绝新连接`, 'error')
      return
    }
    const label = `${req.socket.remoteAddress}:${req.socket.remotePort}`
    const peer: Peer = { id: randomUUID(), label, connectedAt: Date.now() }
    this.clients.set(peer.id, { peer, ws })
    this.emitPeer(peer, true)
    this.emitConn(`客户端接入 ${label}`, 'success')

    ws.on('message', (data: import('ws').RawData, isBinary: boolean) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      this.emitData('rx', buf, isBinary ? 'hex' : 'utf8', peer)
      void this.runMock(buf, (bytes) => {
        const bin = this.config.wsSendMode === 'binary' || isBinary
        ws.send(bin ? bytes : bytes.toString('utf8'), { binary: bin })
      }, peer)
    })
    ws.on('error', (err: Error) => this.emitError(`${label}: ${err.message}`))
    ws.on('close', (code: number) => {
      this.clients.delete(peer.id)
      this.emitPeer(peer, false)
      this.emitConn(`客户端断开 ${label} code=${code}`, 'warn')
    })
  }

  listPeers(): Peer[] {
    return [...this.clients.values()].map((c) => c.peer)
  }

  kickPeer(peerId: string): void {
    const c = this.clients.get(peerId)
    if (c) {
      c.ws.close(1000, 'kicked')
      this.emitSystem(`已踢出客户端 ${c.peer.label}`)
    }
  }

  async send(out: OutgoingFrame): Promise<void> {
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    const binary = this.config.wsSendMode === 'binary' || out.encoding !== 'utf8'
    const payload: string | Buffer = binary ? bytes : bytes.toString('utf8')

    if (out.target) {
      const c = this.clients.get(out.target)
      if (!c) {
        this.emitError('目标客户端不存在')
        return
      }
      c.ws.send(payload, { binary })
      this.emitData('tx', bytes, out.encoding, c.peer)
    } else {
      if (this.clients.size === 0) {
        this.emitError('无已连接客户端')
        return
      }
      for (const c of this.clients.values()) {
        if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload, { binary })
      }
      this.emitData('tx', bytes, out.encoding)
    }
  }

  async stop(): Promise<void> {
    for (const c of this.clients.values()) c.ws.terminate()
    this.clients.clear()
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve())
      else resolve()
    })
    this.wss = null
    this.emitStatus('closed', '服务端已停止')
    this.emitConn('服务端已停止', 'info')
  }
}
