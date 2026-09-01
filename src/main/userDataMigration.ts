import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 改名（debug-toolbox → flowprobe）后的用户数据迁移。
 *
 * 为什么必须做：Windows 上 userData 目录名取自 package.json 的 name 字段
 * （实测旧目录是 %APPDATA%\debug-toolbox）。name 一改，Electron 就去找一个
 * 全新的空目录 —— 已装用户的会话（workspace.json）、报文历史（history.db）、
 * 更新源配置（update.json）、自签证书（certs/）全都还躺在旧目录里，
 * 表现出来就是「升级后所有东西都没了」。这类丢数据的观感比改名本身严重得多。
 *
 * 为什么用「复制」而不是「移动」：迁移失败或新版本被回滚时，旧目录还在，
 * 用户可以退回旧版继续用。磁盘代价只是一份历史库，换来的是可逆性。
 *
 * 为什么用哨兵文件而不是「目录是否为空」判断：Electron 在 app.whenReady 之前就可能
 * 往 userData 里写 Preferences/GPUCache 等文件，用「空目录」当条件会漏判。
 * 哨兵只写一次，重复启动不会反复覆盖用户后来的改动。
 *
 * 调用时机必须在任何 app.getPath('userData') 读写之前，也就是主进程模块顶层。
 */

const LEGACY_DIR_NAMES = ['debug-toolbox']
const SENTINEL = '.migrated-from-debug-toolbox'

/** 只搬这些条目：其余都是 Chromium 自己的缓存，跨目录复制毫无意义还很慢 */
const MIGRATE_ENTRIES = [
  'workspace.json',
  'update.json',
  'history.db',
  'history.db-shm',
  'history.db-wal',
  'certs'
]

export interface MigrationResult {
  migrated: boolean
  from?: string
  copied: string[]
  error?: string
}

export function migrateLegacyUserData(): MigrationResult {
  const result: MigrationResult = { migrated: false, copied: [] }
  try {
    const current = app.getPath('userData')
    if (existsSync(join(current, SENTINEL))) return result

    // 旧目录与新目录同级（都在 %APPDATA% / ~/Library/Application Support 下）
    const parent = dirname(current)
    const legacy = LEGACY_DIR_NAMES.map((n) => join(parent, n)).find(
      (dir) => dir !== current && existsSync(join(dir, 'workspace.json'))
    )
    if (!legacy) return result

    if (!existsSync(current)) mkdirSync(current, { recursive: true })
    const present = new Set(readdirSync(legacy))
    for (const name of MIGRATE_ENTRIES) {
      if (!present.has(name)) continue
      const target = join(current, name)
      // 新目录已有同名文件说明用户在新版本里已经产生了数据，不覆盖
      if (existsSync(target)) continue
      cpSync(join(legacy, name), target, { recursive: true })
      result.copied.push(name)
    }
    writeFileSync(
      join(current, SENTINEL),
      JSON.stringify({ from: legacy, at: Date.now(), copied: result.copied }, null, 2),
      'utf8'
    )
    result.migrated = result.copied.length > 0
    result.from = legacy
  } catch (e) {
    // 迁移失败不能拦住启动：最坏结果是用户从空工作区重新建会话
    result.error = String((e as Error)?.message ?? e)
  }
  return result
}
