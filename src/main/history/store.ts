import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ConnectionKind,
  Frame,
  HistoryConfig,
  HistoryContextQuery,
  HistoryContextResult,
  HistoryFrameRow,
  HistoryHttpQuery,
  HistoryHttpRow,
  HistoryPage,
  HistoryQuery,
  HistoryStats,
  HttpLogEntry,
  GlobalSearchQuery,
  GlobalSearchResult,
  SearchHit,
  Session
} from '@shared/protocol'

/**
 * 报文历史落库。
 *
 * 为什么用 SQLite 而不是继续追加 JSON/CSV：
 * 历史的价值在「回头查」，需要按会话、时间、方向、关键字、字节数组合过滤并分页。
 * 平铺文件每次都要全量扫，SQLite 有索引，几百万行也能秒回。
 *
 * 写入策略是「批量 + 事务」：报文可能几千条每秒，逐条 INSERT 会把主进程 IO 打满。
 * 这里攒到 200 条或 800ms 触发一次事务批写，一次事务比 200 次单写快一个数量级。
 *
 * 依赖 better-sqlite3（同步 API）。同步在这里是优点：批写发生在事务里，
 * 几毫秒就结束，不需要为异步回调维护额外的顺序保证。
 */

const FILE_NAME = 'history.db'

/** 历史库绝对路径。供「打开数据目录」与关于面板显示，避免各处重复拼路径。 */
export function historyDbPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}
const FLUSH_SIZE = 200
const FLUSH_MS = 800

/**
 * 生成关键字的等价 LIKE 模式。
 *
 * 为什么需要多个模式：报文的 text 列存的是「按该会话显示编码渲染后的文本」，
 * HEX 模式的会话存下来是 `414c41524d` 这种连续十六进制。
 * 如果只用原文匹配，同一段内容在 TEXT 会话里搜得到、在 HEX 会话里搜不到——
 * 用户看到的是「搜索漏数据」，很难自己想到是编码差异。
 *
 * 所以额外补两个方向：
 * - 输入可见字符时，附带它的十六进制形式（命中 HEX 会话）
 * - 输入看起来是十六进制时，附带它解码后的文本（命中 TEXT 会话）
 */
/**
 * 转义 LIKE 的通配符。
 *
 * 不转义的话，用户搜 `%` 会匹配到全库、搜 `a_b` 会把 `axb` 也算命中——
 * 看起来像搜索结果不准，其实是通配符被当成语法了。
 * 配合 SQL 里的 `ESCAPE '\'` 使用。
 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

function keywordPatterns(keyword: string): string[] {
  const out = ['%' + escapeLike(keyword) + '%']
  const compact = keyword.replace(/\s+/g, '')
  const looksHex = compact.length >= 4 && compact.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(compact)
  if (looksHex) {
    // 输入像十六进制：补上它解码后的文本，用来命中 TEXT 会话的行
    const decoded = Buffer.from(compact, 'hex').toString('utf8')
    // 只在解码结果是可见文本时才用，否则会引入一堆乱码模式
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7e]+$/.test(decoded)) out.push('%' + escapeLike(decoded) + '%')
  } else if (keyword.length >= 2) {
    // 输入是普通文本（含中文）：补上它的十六进制形式，用来命中 HEX 会话的行
    const asHex = Buffer.from(keyword, 'utf8').toString('hex')
    if (asHex !== keyword.toLowerCase()) out.push('%' + asHex + '%')
  }
  return out
}

/**
 * 截取命中片段。整条报文可能几 KB，搜索结果列表只需要关键字周围的一小段。
 * 前后各留 40 字符上下文，并返回关键字在片段里的下标供界面高亮。
 */
function snippet(text: string, keyword: string): { text: string; at: number; len: number } {
  const PAD = 40
  const MAX = 220
  // 命中可能来自等价模式（如关键字的十六进制形式），逐个试，取第一个定位到的。
  // 高亮长度按实际命中的那个模式算，否则 HEX 命中会只高亮一半。
  let at = -1
  let len = keyword.length
  for (const pat of keywordPatterns(keyword)) {
    // 去掉两端的 % 与转义反斜杠，还原成用于定位的原始子串
    const raw = pat.slice(1, -1).replace(/\\([\\%_])/g, '$1')
    const found = text.toLowerCase().indexOf(raw.toLowerCase())
    if (found >= 0) {
      at = found
      len = raw.length
      break
    }
  }
  if (at < 0) return { text: text.slice(0, MAX), at: -1, len }
  const start = Math.max(0, at - PAD)
  const end = Math.min(text.length, at + len + PAD)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return { text: head + text.slice(start, end) + tail, at: at - start + head.length, len }
}

/** 默认配置：默认开启，保留 14 天 / 200 万条 */
export function defaultHistoryConfig(): HistoryConfig {
  return { enabled: true, retentionDays: 14, maxFrames: 2000000, storePayload: true }
}

interface SqliteStatement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint }
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
}
interface SqliteDb {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T
  pragma: (s: string) => unknown
  close: () => void
}

/** 会话快照：报文行里冗余会话名，会话删掉后历史依然可读 */
interface SessionSnapshot {
  name: string
  kind: ConnectionKind | string
  group: string
}

export class HistoryStore {
  private db: SqliteDb | null = null
  private config: HistoryConfig = defaultHistoryConfig()
  private frameQueue: Array<[string, Frame]> = []
  private httpQueue: HttpLogEntry[] = []
  private timer: NodeJS.Timeout | null = null
  private snapshots = new Map<string, SessionSnapshot>()
  private insertFrame: SqliteStatement | null = null
  private insertHttp: SqliteStatement | null = null
  private flushFrames: (() => void) | null = null
  private flushHttp: (() => void) | null = null
  /** 落库不可用时记下原因，供界面提示，而不是静默失效 */
  private failure = ''

  /** 打开数据库并建表。任何失败都降级为「历史功能不可用」，不阻塞应用启动。 */
  init(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // 用 require 而非 import：原生模块在打包后走 asarUnpack 路径，require 更稳
      const Database = require('better-sqlite3') as new (p: string) => SqliteDb
      this.db = new Database(join(dir, FILE_NAME))
      // WAL 让读写不互斥：界面查历史时后台仍能继续写入
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = NORMAL')
      this.createSchema()
      this.loadConfig()
      this.prepareStatements()
      this.pruneByRetention()
    } catch (e) {
      this.failure = String((e as Error)?.message ?? e)
      this.db = null
    }
  }

  private createSchema(): void {
    const db = this.db
    if (!db) return
    db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_name TEXT NOT NULL DEFAULT '',
        session_kind TEXT NOT NULL DEFAULT '',
        session_group TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        direction TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        encoding TEXT NOT NULL DEFAULT 'utf8',
        raw BLOB,
        text TEXT NOT NULL DEFAULT '',
        peer_label TEXT NOT NULL DEFAULT '',
        level TEXT,
        conn INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(ts);
      CREATE INDEX IF NOT EXISTS idx_frames_session_ts ON frames(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_frames_conn ON frames(conn, ts);

      CREATE TABLE IF NOT EXISTS http_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_name TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL,
        method TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL DEFAULT '',
        query TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        req_body TEXT NOT NULL DEFAULT '',
        resp_body TEXT NOT NULL DEFAULT '',
        matched_route TEXT NOT NULL DEFAULT '',
        scenario TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_http_ts ON http_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_http_session_ts ON http_logs(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_http_status ON http_logs(status, ts);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  private prepareStatements(): void {
    const db = this.db
    if (!db) return
    this.insertFrame = db.prepare(
      'INSERT INTO frames (session_id, session_name, session_kind, session_group, ts, direction, size, encoding, raw, text, peer_label, level, conn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    this.insertHttp = db.prepare(
      'INSERT INTO http_logs (session_id, session_name, ts, method, path, query, status, duration_ms, req_body, resp_body, matched_route, scenario) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    )
    // 事务包裹批量插入：一次 commit 而不是每行一次 fsync
    this.flushFrames = db.transaction(() => {
      const stmt = this.insertFrame
      if (!stmt) return
      for (const [, f] of this.frameQueue) {
        const snap = this.snapshots.get(f.sessionId)
        stmt.run(
          f.sessionId,
          snap?.name ?? '',
          snap?.kind ?? '',
          snap?.group ?? '',
          f.ts,
          f.direction,
          f.size ?? 0,
          f.encoding ?? 'utf8',
          this.config.storePayload && f.rawBase64 ? Buffer.from(f.rawBase64, 'base64') : null,
          (f.text ?? '').slice(0, 8192),
          f.peerLabel ?? '',
          f.level ?? null,
          f.conn === true ? 1 : 0
        )
      }
    }) as () => void
    this.flushHttp = db.transaction(() => {
      const stmt = this.insertHttp
      if (!stmt) return
      for (const l of this.httpQueue) {
        const snap = this.snapshots.get(l.sessionId)
        stmt.run(
          l.sessionId,
          snap?.name ?? '',
          l.ts,
          l.method ?? '',
          l.path ?? '',
          l.query ?? '',
          l.status ?? 0,
          Math.round(l.durationMs ?? 0),
          this.config.storePayload ? (l.reqBody ?? '').slice(0, 16384) : '',
          this.config.storePayload ? (l.respBody ?? '').slice(0, 16384) : '',
          l.matchedRoute ?? '',
          l.scenario ?? ''
        )
      }
    }) as () => void
  }

  available(): boolean {
    return this.db !== null
  }

  failureReason(): string {
    return this.failure
  }

  getConfig(): HistoryConfig {
    return { ...this.config }
  }

  setConfig(patch: Partial<HistoryConfig>): HistoryConfig {
    this.config = { ...this.config, ...patch }
    if (this.db) {
      try {
        this.db
          .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run('config', JSON.stringify(this.config))
      } catch {
        // 配置写失败不影响运行时行为
      }
      // 关掉开关时把队列里的残留丢掉，避免关闭后又补写进去
      if (!this.config.enabled) {
        this.frameQueue = []
        this.httpQueue = []
      }
      this.pruneByRetention()
    }
    return this.getConfig()
  }

  private loadConfig(): void {
    if (!this.db) return
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('config') as
        | { value: string }
        | undefined
      if (row?.value) {
        const parsed = JSON.parse(row.value) as Partial<HistoryConfig>
        this.config = { ...defaultHistoryConfig(), ...parsed }
      }
    } catch {
      this.config = defaultHistoryConfig()
    }
  }

  /** 会话创建/改名/改分组时同步快照，写入时直接冗余进行 */
  syncSessions(sessions: Session[]): void {
    for (const s of sessions) {
      this.snapshots.set(s.id, {
        name: s.name,
        kind: s.kind,
        group: (s.group ?? '').trim()
      })
    }
  }

  recordFrame(frame: Frame): void {
    if (!this.db || !this.config.enabled) return
    this.frameQueue.push([frame.sessionId, frame])
    this.schedule()
  }

  recordHttpLog(log: HttpLogEntry): void {
    if (!this.db || !this.config.enabled) return
    this.httpQueue.push(log)
    this.schedule()
  }

  /** 达到阈值立即写，否则等一个空闲窗口，兼顾吞吐与「刚发的报文马上能查到」 */
  private schedule(): void {
    if (this.frameQueue.length + this.httpQueue.length >= FLUSH_SIZE) {
      this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.db) return
    try {
      if (this.frameQueue.length > 0 && this.flushFrames) {
        this.flushFrames()
        this.frameQueue = []
      }
      if (this.httpQueue.length > 0 && this.flushHttp) {
        this.flushHttp()
        this.httpQueue = []
      }
    } catch (e) {
      // 写失败时丢弃这一批，避免坏数据反复重试把队列堵死
      this.frameQueue = []
      this.httpQueue = []
      this.failure = String((e as Error)?.message ?? e)
    }
    this.pruneByCount()
  }

  /** 按保留天数清理。启动时与改配置时各跑一次，成本很低。 */
  private pruneByRetention(): void {
    if (!this.db || this.config.retentionDays <= 0) return
    const cutoff = Date.now() - this.config.retentionDays * 86400000
    try {
      this.db.prepare('DELETE FROM frames WHERE ts < ?').run(cutoff)
      this.db.prepare('DELETE FROM http_logs WHERE ts < ?').run(cutoff)
    } catch {
      // ignore
    }
  }

  /**
   * 按条数上限清理。用「先查阈值 id 再按 id 删」而不是 ORDER BY + LIMIT 子查询：
   * id 是主键，范围删除走索引，比排序整表快得多。
   */
  private pruneByCount(): void {
    if (!this.db || this.config.maxFrames <= 0) return
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }
      const excess = row.n - this.config.maxFrames
      if (excess <= 0) return
      const edge = this.db
        .prepare('SELECT id FROM frames ORDER BY id ASC LIMIT 1 OFFSET ?')
        .get(excess) as { id: number } | undefined
      if (edge) this.db.prepare('DELETE FROM frames WHERE id < ?').run(edge.id)
    } catch {
      // ignore
    }
  }

  /** 组装报文查询的 WHERE 子句。参数化拼接，不做字符串插值。 */
  private frameWhere(q: HistoryQuery): { sql: string; params: unknown[] } {
    const parts: string[] = []
    const params: unknown[] = []
    if (q.sessionIds && q.sessionIds.length > 0) {
      parts.push('session_id IN (' + q.sessionIds.map(() => '?').join(',') + ')')
      params.push(...q.sessionIds)
    }
    if (typeof q.from === 'number') {
      parts.push('ts >= ?')
      params.push(q.from)
    }
    if (typeof q.to === 'number') {
      parts.push('ts <= ?')
      params.push(q.to)
    }
    if (q.directions && q.directions.length > 0) {
      parts.push('direction IN (' + q.directions.map(() => '?').join(',') + ')')
      params.push(...q.directions)
    }
    if (q.connOnly) parts.push('conn = 1')
    if (q.keyword) {
      const pats = keywordPatterns(q.keyword)
      parts.push('(' + pats.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ') + ')')
      params.push(...pats)
    }
    if (typeof q.minSize === 'number') {
      parts.push('size >= ?')
      params.push(q.minSize)
    }
    if (typeof q.maxSize === 'number') {
      parts.push('size <= ?')
      params.push(q.maxSize)
    }
    return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params }
  }

  queryFrames(q: HistoryQuery): HistoryPage<HistoryFrameRow> {
    if (!this.db) return { rows: [], total: 0 }
    // 先落盘再查，否则刚发的报文查不到，用户会以为功能坏了
    this.flush()
    const { sql, params } = this.frameWhere(q)
    const order = q.order === 'asc' ? 'ASC' : 'DESC'
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000)
    const offset = Math.max(q.offset ?? 0, 0)
    try {
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM frames' + sql).get(...params) as {
        n: number
      }).n
      const rows = this.db
        .prepare(
          'SELECT id, session_id, session_name, session_kind, session_group, ts, direction, size, encoding, raw, text, peer_label, level, conn FROM frames' +
            sql +
            ' ORDER BY ts ' +
            order +
            ', id ' +
            order +
            ' LIMIT ? OFFSET ?'
        )
        .all(...params, limit, offset) as Array<Record<string, unknown>>
      return { total, rows: rows.map((r) => this.toFrameRow(r)) }
    } catch {
      return { rows: [], total: 0 }
    }
  }

  queryHttp(q: HistoryHttpQuery): HistoryPage<HistoryHttpRow> {
    if (!this.db) return { rows: [], total: 0 }
    this.flush()
    const parts: string[] = []
    const params: unknown[] = []
    if (q.sessionIds && q.sessionIds.length > 0) {
      parts.push('session_id IN (' + q.sessionIds.map(() => '?').join(',') + ')')
      params.push(...q.sessionIds)
    }
    if (typeof q.from === 'number') {
      parts.push('ts >= ?')
      params.push(q.from)
    }
    if (typeof q.to === 'number') {
      parts.push('ts <= ?')
      params.push(q.to)
    }
    if (q.statusFamilies && q.statusFamilies.length > 0) {
      parts.push('(' + q.statusFamilies.map(() => 'status / 100 = ?').join(' OR ') + ')')
      params.push(...q.statusFamilies)
    }
    if (q.method) {
      parts.push('method = ?')
      params.push(q.method)
    }
    if (typeof q.minDurationMs === 'number') {
      parts.push('duration_ms >= ?')
      params.push(q.minDurationMs)
    }
    if (q.keyword) {
      // 路径与响应体一起搜；通配符转义避免用户输入的 % 或 _ 被当成语法
      const kw = '%' + escapeLike(q.keyword) + '%'
      parts.push("(path LIKE ? ESCAPE '\\' OR query LIKE ? ESCAPE '\\' OR req_body LIKE ? ESCAPE '\\' OR resp_body LIKE ? ESCAPE '\\')")
      params.push(kw, kw, kw, kw)
    }
    const sql = parts.length ? ' WHERE ' + parts.join(' AND ') : ''
    const order = q.order === 'asc' ? 'ASC' : 'DESC'
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000)
    const offset = Math.max(q.offset ?? 0, 0)
    try {
      const total = (this.db.prepare('SELECT COUNT(*) AS n FROM http_logs' + sql).get(...params) as {
        n: number
      }).n
      const rows = this.db
        .prepare(
          'SELECT id, session_id, session_name, ts, method, path, query, status, duration_ms, req_body, resp_body, matched_route, scenario FROM http_logs' +
            sql +
            ' ORDER BY ts ' +
            order +
            ', id ' +
            order +
            ' LIMIT ? OFFSET ?'
        )
        .all(...params, limit, offset) as Array<Record<string, unknown>>
      return { total, rows: rows.map((r) => this.toHttpRow(r)) }
    } catch {
      return { rows: [], total: 0 }
    }
  }

  /** 历史里出现过的会话（含已删除的），供筛选下拉 */
  listSessions(): Array<{ sessionId: string; sessionName: string; sessionKind: string; count: number }> {
    if (!this.db) return []
    this.flush()
    try {
      return (
        this.db
          .prepare(
            'SELECT session_id, MAX(session_name) AS n, MAX(session_kind) AS k, COUNT(*) AS c FROM frames GROUP BY session_id ORDER BY c DESC'
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        sessionId: String(r.session_id),
        sessionName: String(r.n ?? ''),
        sessionKind: String(r.k ?? ''),
        count: Number(r.c ?? 0)
      }))
    } catch {
      return []
    }
  }

  stats(): HistoryStats {
    const path = this.dbPath()
    const empty: HistoryStats = {
      enabled: this.config.enabled,
      frames: 0,
      httpLogs: 0,
      sessions: 0,
      fileBytes: 0,
      oldestTs: null,
      newestTs: null,
      byDay: [],
      bySession: [],
      path
    }
    if (!this.db) return empty
    this.flush()
    try {
      const frames = (this.db.prepare('SELECT COUNT(*) AS n FROM frames').get() as { n: number }).n
      const httpLogs = (this.db.prepare('SELECT COUNT(*) AS n FROM http_logs').get() as { n: number }).n
      const sessions = (
        this.db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM frames').get() as { n: number }
      ).n
      const range = this.db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM frames').get() as {
        a: number | null
        b: number | null
      }
      // 按本地日期分桶：SQLite 的 date() 默认 UTC，这里显式加 localtime 修饰
      const byDay = (
        this.db
          .prepare(
            "SELECT date(ts / 1000, 'unixepoch', 'localtime') AS d, COUNT(*) AS c FROM frames GROUP BY d ORDER BY d DESC LIMIT 14"
          )
          .all() as Array<Record<string, unknown>>
      )
        .map((r) => ({ day: String(r.d), count: Number(r.c) }))
        .reverse()
      const bySession = (
        this.db
          .prepare(
            'SELECT session_id, MAX(session_name) AS n, COUNT(*) AS c FROM frames GROUP BY session_id ORDER BY c DESC LIMIT 8'
          )
          .all() as Array<Record<string, unknown>>
      ).map((r) => ({
        sessionId: String(r.session_id),
        sessionName: String(r.n ?? ''),
        count: Number(r.c)
      }))
      // WAL 模式下新写入先落在 -wal 文件，只统计主库会一直显示 4KB，这里三个文件一起算
      let fileBytes = 0
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fileBytes += statSync(path + suffix).size
        } catch {
          // 文件不存在时忽略
        }
      }
      return {
        enabled: this.config.enabled,
        frames,
        httpLogs,
        sessions,
        fileBytes,
        oldestTs: range.a ?? null,
        newestTs: range.b ?? null,
        byDay,
        bySession,
        path
      }
    } catch {
      return empty
    }
  }


  /**
   * 全局搜索：一次关键字同时打报文与 HTTP 请求两张表。
   *
   * 为什么用 LIKE 而不是 FTS5 全文索引：实测 30 万行库上，罕见词 LIKE 全表扫 65ms、
   * 无命中最坏情况 68ms，对交互式搜索完全够用；而挂上 FTS5 触发器后写入从 83ms
   * 劣化到 1558ms（约 19 倍），还额外占 13MB 索引。报文库是写多读少，
   * 为偶尔的搜索牺牲常态写入吞吐不划算。
   *
   * 代价用 scanLimit 兜住：只回溯最近 N 条记录（按主键范围裁剪，走索引）。
   * 实测限定最近 5 万条时同样的查询降到 6ms。
   */
  search(q: GlobalSearchQuery): GlobalSearchResult {
    const started = Date.now()
    const keyword = (q.keyword ?? '').trim()
    const empty: GlobalSearchResult = {
      keyword,
      frames: [],
      https: [],
      frameTotal: 0,
      httpTotal: 0,
      bySession: [],
      scanned: 0,
      elapsedMs: 0,
      truncated: false
    }
    if (!this.db || keyword.length === 0) return empty
    this.flush()
    const perKind = Math.min(Math.max(q.perKind ?? 40, 1), 200)
    const scanLimit = Math.max(q.scanLimit ?? 0, 0)
    const like = '%' + escapeLike(keyword) + '%'
    try {
      // 公共条件：会话、时间下限、扫描深度
      const build = (table: 'frames' | 'http_logs'): { sql: string; params: unknown[]; scanned: number } => {
        const parts: string[] = []
        const params: unknown[] = []
        let scanned = 0
        if (scanLimit > 0) {
          const edge = this.db!.prepare('SELECT MAX(id) AS m, COUNT(*) AS c FROM ' + table).get() as {
            m: number | null
            c: number
          }
          if (edge.m !== null) {
            // 按主键范围裁剪而不是 ORDER BY + LIMIT 子查询：范围条件能直接走主键索引
            parts.push('id > ?')
            params.push(edge.m - scanLimit)
            scanned = Math.min(edge.c, scanLimit)
          }
        } else {
          scanned = (this.db!.prepare('SELECT COUNT(*) AS c FROM ' + table).get() as { c: number }).c
        }
        if (q.sessionIds && q.sessionIds.length > 0) {
          parts.push('session_id IN (' + q.sessionIds.map(() => '?').join(',') + ')')
          params.push(...q.sessionIds)
        }
        if (typeof q.from === 'number') {
          parts.push('ts >= ?')
          params.push(q.from)
        }
        return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params, scanned }
      }

      const f = build('frames')
      const pats = keywordPatterns(keyword)
      const textMatch = '(' + pats.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ') + ')'
      const frameWhere = f.sql ? f.sql + ' AND ' + textMatch : ' WHERE ' + textMatch
      const frameParams = [...f.params, ...pats]
      const frameTotal = (
        this.db.prepare('SELECT COUNT(*) AS n FROM frames' + frameWhere).get(...frameParams) as {
          n: number
        }
      ).n
      const frameRows = this.db
        .prepare(
          'SELECT id, session_id, session_name, session_kind, ts, direction, size, text FROM frames' +
            frameWhere +
            ' ORDER BY id DESC LIMIT ?'
        )
        .all(...frameParams, perKind) as Array<Record<string, unknown>>

      const h = build('http_logs')
      // HTTP 侧同时搜路径、Query 与请求/响应体：找接口经常只记得住路径片段
      // HTTP 的 body 存的是原文，不存在 HEX/TEXT 双形态，用单一模式即可
      const esc = " ESCAPE '\\'"
      const httpMatch =
        '(path LIKE ?' + esc + ' OR query LIKE ?' + esc + ' OR req_body LIKE ?' + esc + ' OR resp_body LIKE ?' + esc + ')'
      const httpWhere = h.sql ? h.sql + ' AND ' + httpMatch : ' WHERE ' + httpMatch
      const httpParams = [...h.params, like, like, like, like]
      const httpTotal = (
        this.db.prepare('SELECT COUNT(*) AS n FROM http_logs' + httpWhere).get(...httpParams) as {
          n: number
        }
      ).n
      const httpRows = this.db
        .prepare(
          'SELECT id, session_id, session_name, ts, method, path, query, status, duration_ms, req_body, resp_body FROM http_logs' +
            httpWhere +
            ' ORDER BY id DESC LIMIT ?'
        )
        .all(...httpParams, perKind) as Array<Record<string, unknown>>

      const bySessionRows = this.db
        .prepare(
          'SELECT session_id, MAX(session_name) AS n, COUNT(*) AS c FROM frames' +
            frameWhere +
            ' GROUP BY session_id ORDER BY c DESC LIMIT 12'
        )
        .all(...frameParams) as Array<Record<string, unknown>>

      const frames: SearchHit[] = frameRows.map((r) => {
        const text = String(r.text ?? '')
        const cut = snippet(text, keyword)
        return {
          kind: 'frame' as const,
          id: Number(r.id),
          sessionId: String(r.session_id),
          sessionName: String(r.session_name ?? ''),
          sessionKind: String(r.session_kind ?? ''),
          ts: Number(r.ts),
          snippet: cut.text,
          matchAt: cut.at,
          matchLen: cut.len,
          direction: String(r.direction) as SearchHit['direction'],
          size: Number(r.size ?? 0)
        }
      })

      const https: SearchHit[] = httpRows.map((r) => {
        const path = String(r.path ?? '')
        const query = String(r.query ?? '')
        const full = path + (query ? '?' + query : '')
        // 优先在路径里定位关键字；路径没有再退到响应体，最后退到请求体
        let source = full
        if (full.toLowerCase().indexOf(keyword.toLowerCase()) < 0) {
          const resp = String(r.resp_body ?? '')
          const req = String(r.req_body ?? '')
          source = resp.toLowerCase().indexOf(keyword.toLowerCase()) >= 0 ? resp : req
        }
        const cut = snippet(source, keyword)
        return {
          kind: 'http' as const,
          id: Number(r.id),
          sessionId: String(r.session_id),
          sessionName: String(r.session_name ?? ''),
          sessionKind: 'http-mock',
          ts: Number(r.ts),
          snippet: cut.text,
          matchAt: cut.at,
          matchLen: cut.len,
          method: String(r.method ?? ''),
          status: Number(r.status ?? 0),
          path: full
        }
      })

      return {
        keyword,
        frames,
        https,
        frameTotal,
        httpTotal,
        bySession: bySessionRows.map((r) => ({
          sessionId: String(r.session_id),
          sessionName: String(r.n ?? ''),
          count: Number(r.c ?? 0)
        })),
        scanned: f.scanned + h.scanned,
        elapsedMs: Date.now() - started,
        truncated: scanLimit > 0
      }
    } catch (e) {
      this.failure = String((e as Error)?.message ?? e)
      return { ...empty, elapsedMs: Date.now() - started }
    }
  }

  /**
   * 取一条记录在原会话时间轴上的前后文。
   *
   * 为什么按 (ts, id) 而不是 offset 取：分页 offset 会随后续写入漂移，
   * 同一个 offset 过几秒指向的就不是同一行了。这里先读出锚点行的 ts 与 id，
   * 再用「(ts, id) 严格小于锚点」取更早的、「严格大于」取更晚的——
   * 双字段比较是因为高频报文同一毫秒可能有多条，只比 ts 会漏掉或重复。
   *
   * 更早的那一批用 DESC 取完再反转，这样两次查询都能吃到
   * idx_frames_session_ts 索引，不需要全表排序。
   */
  context(q: HistoryContextQuery): HistoryContextResult {
    const empty: HistoryContextResult = {
      kind: q.kind,
      focusId: q.id,
      focusIndex: -1,
      sessionId: '',
      sessionName: '',
      sessionKind: '',
      frames: [],
      https: [],
      hasBefore: false,
      hasAfter: false,
      sessionTotal: 0
    }
    if (!this.db) return empty
    this.flush()
    const before = Math.min(Math.max(q.before ?? 50, 0), 500)
    const after = Math.min(Math.max(q.after ?? 50, 0), 500)
    const table = q.kind === 'http' ? 'http_logs' : 'frames'
    try {
      const anchor = this.db
        .prepare('SELECT id, session_id, ts FROM ' + table + ' WHERE id = ?')
        .get(q.id) as { id: number; session_id: string; ts: number } | undefined
      // 锚点可能已被保留策略清理掉，此时退化为「该会话最新的一批」
      const sessionId = anchor?.session_id ?? ''
      if (!anchor) {
        return { ...empty, sessionId }
      }
      const cols =
        q.kind === 'http'
          ? 'id, session_id, session_name, ts, method, path, query, status, duration_ms, req_body, resp_body, matched_route, scenario'
          : 'id, session_id, session_name, session_kind, session_group, ts, direction, size, encoding, raw, text, peer_label, level, conn'

      // 更早：(ts, id) < (anchor.ts, anchor.id)，取最近的 before 条后反转成升序
      const earlier = this.db
        .prepare(
          'SELECT ' + cols + ' FROM ' + table +
            ' WHERE session_id = ? AND (ts < ? OR (ts = ? AND id < ?))' +
            ' ORDER BY ts DESC, id DESC LIMIT ?'
        )
        .all(sessionId, anchor.ts, anchor.ts, anchor.id, before + 1) as Array<Record<string, unknown>>
      const hasBefore = earlier.length > before
      const earlierRows = earlier.slice(0, before).reverse()

      const anchorRow = this.db
        .prepare('SELECT ' + cols + ' FROM ' + table + ' WHERE id = ?')
        .get(q.id) as Record<string, unknown>

      const later = this.db
        .prepare(
          'SELECT ' + cols + ' FROM ' + table +
            ' WHERE session_id = ? AND (ts > ? OR (ts = ? AND id > ?))' +
            ' ORDER BY ts ASC, id ASC LIMIT ?'
        )
        .all(sessionId, anchor.ts, anchor.ts, anchor.id, after + 1) as Array<Record<string, unknown>>
      const hasAfter = later.length > after
      const laterRows = later.slice(0, after)

      const all = [...earlierRows, anchorRow, ...laterRows]
      const sessionTotal = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE session_id = ?')
          .get(sessionId) as { n: number }
      ).n

      const meta = all[0] ?? anchorRow
      return {
        kind: q.kind,
        focusId: q.id,
        focusIndex: earlierRows.length,
        sessionId,
        sessionName: String(meta?.session_name ?? ''),
        sessionKind: q.kind === 'http' ? 'http-mock' : String(meta?.session_kind ?? ''),
        frames: q.kind === 'frame' ? all.map((r) => this.toFrameRow(r)) : [],
        https: q.kind === 'http' ? all.map((r) => this.toHttpRow(r)) : [],
        hasBefore,
        hasAfter,
        sessionTotal
      }
    } catch (e) {
      this.failure = String((e as Error)?.message ?? e)
      return empty
    }
  }

  /** 行映射抽成方法，让分页查询与上下文查询共用同一套字段口径 */
  private toFrameRow(r: Record<string, unknown>): HistoryFrameRow {
    return {
      id: Number(r.id),
      sessionId: String(r.session_id),
      sessionName: String(r.session_name ?? ''),
      sessionKind: String(r.session_kind ?? ''),
      sessionGroup: String(r.session_group ?? ''),
      ts: Number(r.ts),
      direction: String(r.direction) as HistoryFrameRow['direction'],
      size: Number(r.size ?? 0),
      encoding: String(r.encoding ?? 'utf8') as HistoryFrameRow['encoding'],
      rawBase64: r.raw ? Buffer.from(r.raw as Buffer).toString('base64') : '',
      text: String(r.text ?? ''),
      peerLabel: String(r.peer_label ?? ''),
      level: (r.level as HistoryFrameRow['level']) ?? undefined,
      conn: Number(r.conn ?? 0) === 1
    }
  }

  private toHttpRow(r: Record<string, unknown>): HistoryHttpRow {
    return {
      id: Number(r.id),
      sessionId: String(r.session_id),
      sessionName: String(r.session_name ?? ''),
      ts: Number(r.ts),
      method: String(r.method ?? ''),
      path: String(r.path ?? ''),
      query: String(r.query ?? ''),
      status: Number(r.status ?? 0),
      durationMs: Number(r.duration_ms ?? 0),
      reqBody: String(r.req_body ?? ''),
      respBody: String(r.resp_body ?? ''),
      matchedRoute: String(r.matched_route ?? ''),
      scenario: String(r.scenario ?? '')
    }
  }

  clearAll(): void {
    if (!this.db) return
    this.frameQueue = []
    this.httpQueue = []
    try {
      this.db.exec('DELETE FROM frames; DELETE FROM http_logs;')
      this.db.exec('VACUUM')
      this.checkpoint()
    } catch {
      // ignore
    }
  }

  clearSession(sessionId: string): void {
    if (!this.db) return
    this.flush()
    try {
      this.db.prepare('DELETE FROM frames WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM http_logs WHERE session_id = ?').run(sessionId)
      this.checkpoint()
    } catch {
      // ignore
    }
  }

  /** 手动压缩。删除大量行后文件不会自动缩小，需要 VACUUM 回收。 */
  vacuum(): void {
    if (!this.db) return
    this.flush()
    try {
      this.db.exec('VACUUM')
      this.checkpoint()
    } catch {
      // ignore
    }
  }

  /**
   * 把 WAL 日志并回主库并截断日志文件。
   * WAL 模式下删除与 VACUUM 的动作先写进 -wal，不做 checkpoint 的话
   * 「清空历史」之后占用反而会涨，界面上看着像没删掉。
   */
  private checkpoint(): void {
    try {
      this.db?.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      // ignore
    }
  }

  dbPath(): string {
    try {
      return join(app.getPath('userData'), FILE_NAME)
    } catch {
      return ''
    }
  }

  dispose(): void {
    this.flush()
    try {
      this.db?.close()
    } catch {
      // ignore
    }
    this.db = null
  }
}
