import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionKind, SessionConfig } from '@shared/protocol'

/**
 * 会话工作区持久化。
 *
 * 存放位置：Electron userData 目录下的 workspace.json
 *   Windows: %APPDATA%/flowprobe/workspace.json
 *
 * 只保存"重建会话所需的最小信息"（类型、名称、连接参数、Mock 配置、是否自启），
 * 不保存运行时数据（报文、指标、对端列表），避免文件无限膨胀。
 */

const FILE_NAME = 'workspace.json'
const VERSION = 1

export interface PersistedSession {
  id: string
  kind: ConnectionKind
  name: string
  config: SessionConfig
  /** 应用启动后是否自动连接/监听 */
  autoStart?: boolean
  /** 所属分组名，空表示未分组 */
  group?: string
  /** 自定义标签 */
  tags?: string[]
  createdAt: number
}

interface Workspace {
  version: number
  savedAt: number
  sessions: PersistedSession[]
}

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/** 读取工作区。文件缺失或损坏时返回空列表，不抛异常。 */
export function loadWorkspace(): PersistedSession[] {
  try {
    const path = filePath()
    if (!existsSync(path)) return []
    const raw = readFileSync(path, 'utf8')
    const data = JSON.parse(raw) as Workspace
    if (!data || typeof data !== 'object' || !Array.isArray(data.sessions)) return []
    return data.sessions.filter(
      (s): s is PersistedSession =>
        !!s && typeof s.id === 'string' && typeof s.kind === 'string' && typeof s.name === 'string'
    )
  } catch {
    // 损坏的文件不应阻塞启动
    return []
  }
}

/**
 * 原子写入：先写临时文件再重命名，避免进程在写一半时退出导致文件损坏。
 */
export function saveWorkspace(sessions: PersistedSession[]): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = filePath()
    const tmp = path + '.tmp'
    const data: Workspace = { version: VERSION, savedAt: Date.now(), sessions }
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    // 落盘失败不影响应用继续运行
  }
}

/** 清空工作区文件 */
export function clearWorkspace(): void {
  try {
    const path = filePath()
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // ignore
  }
}

export function workspacePath(): string {
  try {
    return filePath()
  } catch {
    return ''
  }
}
