import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, type UpdateSettings, type UpdateState } from '@shared/protocol'

/**
 * 应用自动更新。
 *
 * 为什么值得做：每发一版都要把九十多兆的安装包手动送到每个使用者手上，
 * 这个成本随人数线性增长且永不结束。接上更新通道后，后续所有版本的分发成本归零。
 *
 * 更新地址不可配置 —— 这是一次刻意的收缩。
 *
 * 早先版本让用户在界面里选来源（自建目录 / GitHub 仓库）并填地址与下载代理，
 * 出发点是「换服务器不用重新打包」。但它把一件本该由发布方决定一次的事，
 * 摊给了每一个使用者：填哪种来源、仓库名怎么写、代理选哪个 —— 而任何一处写错，
 * 表现都是同一个 404，用户无从判断错在哪。
 *
 * 现在地址只有一处来源：打包时 electron-builder.yml 的 `publish.url`。
 * electron-builder 会把它写进安装包内的 app-update.yml，electron-updater 启动时自己读，
 * 因此这里连 setFeedURL 都不需要调用。界面上只剩两个开关。
 */

const FILE_NAME = 'update.json'

/**
 * 曾经用过的占位域名。
 *
 * 更新服务地址定下来之前，publish.url 填的是一个不存在的域名以便生成 latest.yml。
 * 现在已换成真实的 GitHub 发布仓库，但这个判断保留着 —— 因为老版本安装包内
 * 仍然带着占位地址，它们点检查更新时应当得到「发布方尚未启用更新服务」，
 * 而不是一个域名解析错误（那是在报告一件与用户无关的事）。
 */
const PLACEHOLDER_HOST = 'update.invalid'

const DEFAULTS: UpdateSettings = {
  autoCheck: true,
  /*
    自动下载默认关。下载完成后要重启才生效，而重启会掐断正在跑的会话与监听端口 ——
    调试工具最不该做的事就是在用户盯着报文时自己动。改为下载也由用户点。
  */
  autoDownload: false
}

function settingsPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

let settings: UpdateSettings = { ...DEFAULTS }

function loadSettings(): UpdateSettings {
  try {
    const path = settingsPath()
    if (!existsSync(path)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateSettings>
    /*
      只挑认识的两个字段，旧版本存下的 feedUrl / githubRepo / githubProxy 自然被丢弃。
      不做「迁移」也不报错：那些字段现在没有对应的功能，留着反而会让人以为还能生效。
    */
    return {
      autoCheck: typeof raw.autoCheck === 'boolean' ? raw.autoCheck : DEFAULTS.autoCheck,
      autoDownload: typeof raw.autoDownload === 'boolean' ? raw.autoDownload : DEFAULTS.autoDownload
    }
  } catch {
    // 配置坏了不该拖住启动，退回默认
    return { ...DEFAULTS }
  }
}

/** 原子写入，与工作区同一套做法：写一半退出不会留下半个 JSON */
function saveSettings(next: UpdateSettings): void {
  try {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = settingsPath()
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    // 存不下就只在内存里生效，不影响本次使用
  }
}

let state: UpdateState = {
  phase: 'idle',
  currentVersion: '0.0.0'
}

/**
 * 读出安装包里内置的更新源描述，只为一件事：判断「这个包到底有没有更新地址」，
 * 好在没有的时候给出一句能看懂的话，而不是让按钮点了半天最后抛个内部错误。
 *
 * 手工解析而不是引 yaml 库：要取的只有三四个顶层标量字段，为此多一个依赖不值得。
 * 读不到就当没有 —— 这不影响 electron-updater 自己工作，它读的是同一个文件。
 *
 * 两种 provider 都要认：generic 把地址写在 `url` 里，而 github 写的是 `owner` + `repo`，
 * 只认 `url` 会把 github 包误判成「没有更新地址」。
 */
type PackagedFeed = { provider: string; url: string; owner: string; repo: string }

let feedCache: PackagedFeed | null = null

function packagedFeed(): PackagedFeed {
  if (feedCache) return feedCache
  const feed: PackagedFeed = { provider: '', url: '', owner: '', repo: '' }
  feedCache = feed
  try {
    // app-update.yml 与 app.asar 同级，由 electron-builder 依 publish 段生成
    const path = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(path)) return feed
    const text = readFileSync(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(provider|url|owner|repo):\s*(.+?)\s*$/.exec(line)
      if (!m) continue
      const value = m[2].replace(/^['"]|['"]$/g, '')
      feed[m[1] as keyof PackagedFeed] = value
    }
  } catch {
    // 读不出来就当没有，不影响更新本身
  }
  return feed
}

/** 是否具备真正检查更新的条件。不满足时界面显示原因，而不是让按钮点了没反应 */
function unavailableReason(): string | null {
  /*
    开发运行里 electron-updater 会因为找不到 app-update.yml 直接抛错。
    与其把这个内部错误抛给界面，不如明确告诉用户「这是源码运行」。
  */
  if (!app.isPackaged) return '开发运行不检查更新（打包后的安装版才会检查）'
  const feed = packagedFeed()
  /*
    github provider 的地址由 owner/repo 拼出来，generic 则是一个完整 url。
    两者都没有才算「这个包没接更新」。
  */
  const hasTarget = (feed.owner && feed.repo) || feed.url
  if (!hasTarget) return '这个安装包没有内置更新地址，请向发布方索取新版本'
  // 老版本安装包里还留着占位域名，认出来给一句人话
  if (feed.url.includes(PLACEHOLDER_HOST)) {
    return '发布方尚未启用更新服务，暂时请手动获取新版本'
  }
  return null
}

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.updateEvent, state)
  }
}

function patch(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  broadcast()
}

/**
 * 惰性加载 electron-updater。
 *
 * 顶层 import 会在应用启动时就把它连带的依赖全读进来，而绝大多数启动根本不检查更新；
 * 更要紧的是它在未打包环境下构造时就可能抛错，顶层引入会连累整个主进程起不来。
 */
type AutoUpdater = typeof import('electron-updater').autoUpdater
let updater: AutoUpdater | null = null

function getUpdater(): AutoUpdater {
  if (updater) return updater
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('electron-updater') as typeof import('electron-updater')
  const u = mod.autoUpdater
  // 自己接管下载与安装时机，库的默认自动行为一律关掉
  u.autoDownload = false
  u.autoInstallOnAppQuit = false
  // 不允许降级：服务器上误传旧版本时不该把用户装回去
  u.allowDowngrade = false

  u.on('checking-for-update', () => patch({ phase: 'checking', error: undefined }))
  u.on('update-available', (info) =>
    patch({
      phase: 'available',
      newVersion: info.version,
      releaseNotes: normalizeNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      checkedAt: Date.now()
    })
  )
  u.on('update-not-available', () =>
    patch({ phase: 'up-to-date', newVersion: undefined, checkedAt: Date.now() })
  )
  u.on('download-progress', (p) =>
    patch({
      phase: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  )
  u.on('update-downloaded', (info) =>
    patch({ phase: 'downloaded', newVersion: info.version, percent: 100 })
  )
  u.on('error', (err) => patch({ phase: 'error', error: friendlyError(err) }))
  updater = u
  return u
}

/**
 * 发布说明可能是字符串，也可能是 { version, note } 数组（多版本累积）。
 * 统一成一段文本，界面就不必分类型处理。
 */
function normalizeNotes(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    return notes
      .map((n) => {
        const o = n as { version?: string; note?: string | null }
        return (o.version ? 'v' + o.version + '\n' : '') + (o.note ?? '')
      })
      .join('\n\n')
  }
  return undefined
}

/**
 * 把库抛出的英文错误翻成能指导下一步动作的中文。
 *
 * 原始信息（ENOTFOUND、404、ERR_UPDATER_CHANNEL_FILE_NOT_FOUND）对使用者是天书。
 * 又因为更新请求走 Electron 的 `net` 模块，错误码是 Chromium 那一套（net::ERR_*），
 * 只认 Node 的 ENOTFOUND 会漏掉大半情况，所以两套都认。
 *
 * 地址不可配之后，这些提示一律不再让用户「检查地址」—— 他没有地址可改，
 * 能做的只有查网络或者等发布方修好服务器。
 */
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return '解析不到更新服务器的域名。如果在内网，请确认这台机器能访问公司网络'
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i.test(msg)) {
    return '当前网络不可用，恢复网络后再试'
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ERR_PROXY_CONNECTION_FAILED/i.test(msg)) {
    return '连不上更新服务器。可能是网络受限或服务器暂时不可用，稍后再试'
  }
  /*
    GitHub 发布源特有的两种情况，都不是「网络出错」，得分开说：
    仓库里还没有任何正式 Release（刚建好仓库、或只发了草稿/预发布），
    以及 Release 存在但附件里少了 latest.yml（上传时漏传或传失败）。
    这两句都指向发布方，而不是让用户去查自己的网络。
  */
  if (/ERR_UPDATER_LATEST_VERSION_NOT_FOUND|please ensure a production release|No published versions/i.test(msg)) {
    return '发布仓库里还没有正式版本，等发布方发出第一个版本后再检查'
  }
  if (/404|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|latest\.yml/i.test(msg)) {
    /*
      404 在地址不可配之后一定是服务端的问题（清单没上传、或被挪走了），
      不再可能是用户填错地址。所以措辞直接指向「联系发布方」而不是「检查地址」。
    */
    return '更新服务器上找不到版本清单，可能新版本还在发布中。稍后再试或联系发布方'
  }
  if (/403|429|502|503|504|ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(msg)) {
    return '更新服务器返回了错误状态，请稍后再试'
  }
  if (/ERR_UPDATER_INVALID_SIGNATURE|sha512|checksum/i.test(msg)) {
    return '安装包校验不通过（可能没下完或与清单不匹配），请重试；反复失败请联系发布方'
  }
  if (/certificate|CERT_|SELF_SIGNED|ERR_SSL|ERR_CERT/i.test(msg)) {
    return 'HTTPS 证书校验失败。内网自签证书需要先装到系统受信任根'
  }
  return msg
}

export function getUpdateState(): UpdateState {
  return state
}

export function getUpdateSettings(): UpdateSettings {
  return settings
}

export function setUpdateSettings(next: Partial<UpdateSettings>): UpdateSettings {
  settings = {
    autoCheck: typeof next.autoCheck === 'boolean' ? next.autoCheck : settings.autoCheck,
    autoDownload: typeof next.autoDownload === 'boolean' ? next.autoDownload : settings.autoDownload
  }
  saveSettings(settings)
  return settings
}

export async function checkForUpdate(): Promise<UpdateState> {
  const reason = unavailableReason()
  if (reason) {
    patch({ phase: 'unconfigured', error: reason })
    return state
  }
  try {
    /*
      不调 setFeedURL：地址已在安装包内的 app-update.yml 里，
      库自己读得到。这里再设一遍等于让同一个地址有两个来源。
    */
    await getUpdater().checkForUpdates()
    // 结果由事件回调写入 state，这里不重复判断
  } catch (err) {
    patch({ phase: 'error', error: friendlyError(err) })
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.phase !== 'available' && state.phase !== 'error') return state
  try {
    patch({ phase: 'downloading', percent: 0, error: undefined })
    await getUpdater().downloadUpdate()
  } catch (err) {
    patch({ phase: 'error', error: friendlyError(err) })
  }
  return state
}

/**
 * 立即重启安装。
 *
 * isSilent=false：安装过程要让用户看得见。静默安装在杀掉当前进程后没有任何反馈，
 * 中途失败就成了「应用点一下就消失了」。
 * isForceRunAfter=true：装完自己起回来，否则用户还得去桌面找图标。
 */
export function quitAndInstall(): boolean {
  if (state.phase !== 'downloaded') return false
  const u = getUpdater()
  // setImmediate 让 IPC 回执先发出去，界面才来得及显示「正在重启」
  setImmediate(() => u.quitAndInstall(false, true))
  return true
}

/**
 * 启动时初始化。
 *
 * 自动检查刻意延迟：应用刚起来的几秒里在恢复会话、开监听端口、初始化历史库，
 * 这时候再去拉网络请求会和它们抢 I/O，用户感知到的是启动变慢。
 */
export function initUpdater(): void {
  settings = loadSettings()
  state = {
    phase: 'idle',
    currentVersion: app.getVersion()
  }
  const reason = unavailableReason()
  if (reason) {
    state = { ...state, phase: 'unconfigured', error: reason }
    return
  }
  if (!settings.autoCheck) return
  setTimeout(() => {
    void checkForUpdate().then(() => {
      if (settings.autoDownload && state.phase === 'available') void downloadUpdate()
    })
  }, 8000)
}
