import * as net from 'node:net'
import { randomUUID } from 'node:crypto'
import type { ConnectionKind, OutgoingFrame, Peer, SessionConfig } from '@shared/protocol'
import { BaseAdapter } from './base'
import { FrameSplitter, encodeContent } from '../codec/framing'

interface Client {
  peer: Peer
  socket: net.Socket
  splitter: FrameSplitter
}

export class TcpServerAdapter extends BaseAdapter {
  readonly kind: ConnectionKind = 'tcp-server'
  private server: net.Server | null = null
  private clients = new Map<string, Client>()

  constructor(id: string, config: SessionConfig) {
    super(id, config)
  }

  async start(): Promise<void> {
    const port = Number(this.config.port ?? 0)
    const host = String(this.config.host ?? '0.0.0.0')
    this.emitStatus('connecting', `正在监听 ${host}:${port}`)

    const server = net.createServer()
    this.server = server

    server.on('connection', (socket) => this.handleClient(socket))
    server.on('error', (err) => {
      this.emitError(err.message)
      this.emitStatus('error', err.message)
    })

    server.listen(port, host, () => {
      this.emitStatus('listening', `监听中 ${host}:${port}`)
      this.emitConn(`服务端已启动，监听 ${host}:${port}`, 'success')
    })
  }

  private handleClient(socket: net.Socket): void {
    const max = Number(this.config.maxConnections ?? 0)
    if (max > 0 && this.clients.size >= max) {
      socket.destroy()
      this.emitConn(`达到最大连接数 ${max}，拒绝新连接`, 'error')
      return
    }
    const label = `${socket.remoteAddress}:${socket.remotePort}`
    const peer: Peer = { id: randomUUID(), label, connectedAt: Date.now() }
    const splitter = new FrameSplitter(
      this.config.framing ?? { mode: 'none' },
      (frame) => {
        this.emitData('rx', frame, 'hex', peer)
        void this.runMock(frame, (bytes) => socket.write(bytes), peer)
      }
    )
    this.clients.set(peer.id, { peer, socket, splitter })
    this.emitPeer(peer, true)
    this.emitConn(`客户端接入 ${label}`, 'success')
    socket.setNoDelay(this.config.noDelay !== false)

    socket.on('data', (chunk: Buffer) => {
      const frames = splitter.push(chunk)
      for (const f of frames) {
        this.emitData('rx', f, 'hex', peer)
        void this.runMock(f, (bytes) => socket.write(bytes), peer)
      }
    })
    socket.on('error', (err) => this.emitError(`${label}: ${err.message}`))
    socket.on('close', () => {
      splitter.dispose()
      this.clients.delete(peer.id)
      this.emitPeer(peer, false)
      this.emitConn(`客户端断开 ${label}`, 'warn')
    })
  }

  listPeers(): Peer[] {
    return [...this.clients.values()].map((c) => c.peer)
  }

  kickPeer(peerId: string): void {
    const c = this.clients.get(peerId)
    if (c) {
      c.socket.destroy()
      this.emitSystem(`已踢出客户端 ${c.peer.label}`)
    }
  }

  async send(out: OutgoingFrame): Promise<void> {
    const bytes = encodeContent(out.content, out.encoding, out.appendTerminator)
    if (out.target) {
      const c = this.clients.get(out.target)
      if (!c) {
        this.emitError('目标客户端不存在')
        return
      }
      c.socket.write(bytes)
      this.emitData('tx', bytes, out.encoding, c.peer)
    } else {
      // 广播
      if (this.clients.size === 0) {
        this.emitError('无已连接客户端')
        return
      }
      for (const c of this.clients.values()) {
        c.socket.write(bytes)
      }
      this.emitData('tx', bytes, out.encoding)
    }
  }

  async stop(): Promise<void> {
    for (const c of this.clients.values()) {
      c.splitter.dispose()
      c.socket.destroy()
    }
    this.clients.clear()
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
    this.server = null
    this.emitStatus('closed', '服务端已停止')
    this.emitConn('服务端已停止', 'info')
  }
}
