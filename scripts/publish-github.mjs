/**
 * 把打包产物发布到 GitHub Release。
 *
 * 为什么自己写而不用 electron-builder 的 --publish always：builder 会连带做
 * 「重新打包」这件事，而发布时产物已经在手上了；更要紧的是它只认 GITHUB_TOKEN 与
 * 「代码仓库 = 发布仓库」的默认假设，而这里恰恰要把两者分开（代码私有，安装包公开）。
 *
 * 只用内置 fetch，不引第三方依赖：发布脚本挂在 CI 或同事机器上跑，多一个依赖多一处失败点。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 .env 补齐环境变量。
 *
 * 令牌不能进仓库，也不该每次发布都手敲一遍 export。.env 已在 .gitignore 里。
 */
function loadEnvFile() {
  const f = join(root, '.env')
  if (!existsSync(f)) return
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    const v = t.slice(i + 1).trim().replace(/^['\"]|['\"]$/g, '')
    if (!process.env[k]) process.env[k] = v
  }
}

function die(msg) {
  console.error('\n✗ ' + msg + '\n')
  process.exit(1)
}

loadEnvFile()

const token = process.env.DT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const repo = (process.env.DT_RELEASE_REPO || '').trim()

if (!token) {
  die([
    '缺少 GitHub 令牌。',
    '',
    '在项目根目录建一个 .env（已被 .gitignore 忽略），写两行：',
    '  DT_GITHUB_TOKEN=ghp_你的令牌',
    '  DT_RELEASE_REPO=owner/发布仓库名',
    '',
    '令牌在 GitHub → Settings → Developer settings → Personal access tokens 生成，',
    '经典令牌勾 repo 权限即可（细粒度令牌需要对目标仓库有 Contents: read and write）。'
  ].join('\n'))
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) die('DT_RELEASE_REPO 需要形如 owner/repo，当前是：' + (repo || '(空)'))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const tag = 'v' + version
const releaseDir = join(root, 'release')

/*
  只挑这一版真正需要的文件，不整目录上传。
  latest.yml 是必须项：缺了它客户端根本不知道有新版本，而这个失败是静默的
  —— 用户只会看到「已是最新」，不会看到任何报错。
*/
const WANTED = [
  { name: 'latest.yml', required: true, note: 'Windows 版本清单' },
  { name: 'FlowProbe-Setup-' + version + '.exe', required: true, note: 'Windows 安装包' },
  { name: 'FlowProbe-Setup-' + version + '.exe.blockmap', required: false, note: '增量更新块映射' },
  { name: 'latest-mac.yml', required: false, note: 'macOS 版本清单' },
  { name: 'FlowProbe-' + version + '-arm64.dmg', required: false, note: 'macOS Apple Silicon' },
  { name: 'FlowProbe-' + version + '-x64.dmg', required: false, note: 'macOS Intel' },
  { name: 'FlowProbe-' + version + '-arm64-mac.zip', required: false, note: 'macOS arm64 zip（自动更新用）' },
  { name: 'FlowProbe-' + version + '-x64-mac.zip', required: false, note: 'macOS x64 zip（自动更新用）' }
]

const files = []
for (const w of WANTED) {
  const p = join(releaseDir, w.name)
  if (existsSync(p)) files.push({ ...w, path: p, size: statSync(p).size })
  else if (w.required) die('找不到 ' + w.name + '。先执行 npm run dist 打包，再发布。')
}

const api = 'https://api.github.com'
const headers = {
  authorization: 'Bearer ' + token,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'flowprobe-publisher'
}

async function gh(path, init = {}) {
  const res = await fetch(api + path, { ...init, headers: { ...headers, ...(init.headers || {}) } })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { ok: res.ok, status: res.status, body }
}

console.log('发布 ' + pkg.name + ' ' + tag + ' → ' + repo)

// 先确认仓库能访问，再动手：令牌权限不足时报在这里最容易理解
const who = await gh('/repos/' + repo)
if (!who.ok) {
  die(
    who.status === 404
      ? '访问不到仓库 ' + repo + '。仓库不存在，或令牌对它没有权限（私有仓库需要 repo 权限）。'
      : '仓库检查失败（HTTP ' + who.status + '）：' + JSON.stringify(who.body)
  )
}
if (who.body.private) {
  console.warn(
    '\n⚠ 该发布仓库是私有的。私有仓库的 Release 附件必须带令牌才能下载，' +
    '\n  应用内的自动更新（以及所有 GitHub 加速代理）都取不到文件。' +
    '\n  想让自动更新可用，请把发布仓库设为公开 —— 它只放安装包，代码仓库仍可保持私有。\n'
  )
}

// 已存在同名 tag 的 release 就复用，避免版本发一半失败后无法重跑
let rel = await gh('/repos/' + repo + '/releases/tags/' + tag)
if (rel.status === 404) {
  rel = await gh('/repos/' + repo + '/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: pkg.productName || (tag + ' FlowProbe'),
      body: buildNotes(),
      draft: false,
      prerelease: false
    })
  })
  if (!rel.ok) die('创建 Release 失败（HTTP ' + rel.status + '）：' + JSON.stringify(rel.body))
  console.log('  已创建 Release ' + tag)
} else if (!rel.ok) {
  die('查询 Release 失败（HTTP ' + rel.status + '）：' + JSON.stringify(rel.body))
} else {
  console.log('  复用已存在的 Release ' + tag)
}

const relId = rel.body.id
const existing = new Map((rel.body.assets || []).map((a) => [a.name, a]))

for (const f of files) {
  const old = existing.get(f.name)
  if (old) {
    /*
      同名附件先删再传。GitHub 不允许重名，而「跳过已存在」是错的选择：
      重发同一版本通常正是因为上一次传坏了，跳过会让坏文件留在线上。
    */
    const del = await gh('/repos/' + repo + '/releases/assets/' + old.id, { method: 'DELETE' })
    if (!del.ok && del.status !== 404) die('删除旧附件 ' + f.name + ' 失败（HTTP ' + del.status + '）')
    console.log('  替换 ' + f.name)
  }
  const up = uploadUrl(f.name)
  const res = await uploadAsset(up, f)
  if (!res.ok) {
    const t = await res.text()
    die('上传 ' + f.name + ' 失败（HTTP ' + res.status + '）：' + t)
  }
  console.log('  ✓ ' + f.name + '  ' + fmt(f.size) + '  (' + f.note + ')')
}

console.log(
  '\n完成。已安装旧版的客户端点「帮助 → 检查更新」即可看到 ' + tag + '。' +
  '\n（客户端里没有地址设置项，发布仓库是打包时写死的，无需任何一方填写。）' +
  '\n下载页：https://github.com/' + repo + '/releases/tag/' + tag
)

/**
 * 附件上传地址。优先用 Release 响应里的 upload_url 模板，而不是自己拼 ——
 * 那个模板是 GitHub 当次给出的规范地址，仓库改名或后端调整时它会跟着变。
 */
function uploadUrl(name) {
  const tpl = rel.body && rel.body.upload_url
  const base = tpl
    ? tpl.replace(/\{\?[^}]*\}$/, '')
    : 'https://uploads.github.com/repos/' + repo + '/releases/' + relId + '/assets'
  return base + '?name=' + encodeURIComponent(name)
}

/**
 * 上传一个附件，自己处理重定向与重试。
 *
 * 为什么不能依赖 fetch 内置的跟随重定向：请求体是一个**流**，
 * 而流只能被消费一次。GitHub 偶发返回 307 要求换地址重发时，
 * 内置跟随拿不到可重放的 body，结果就是把 307 原样抛给调用方
 * （实测发 1.21.2 时首个文件即撞上）。所以这里手动重发：每次都新开一个流。
 *
 * 顺带做有限重试：百兆文件在国内到 GitHub 的链路上断一次很常见，
 * 而重试的代价远低于让整次发布失败后人工重跑。
 */
async function uploadAsset(url, f, attempt = 1) {
  const MAX = 4
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-length': String(f.size)
      },
      // 流式上传：安装包接近百兆，整体读进内存没必要
      body: createReadStream(f.path),
      duplex: 'half',
      // 关掉自动跟随：流不可重放，跟随只会失败得更含糊
      redirect: 'manual'
    })
  } catch (err) {
    if (attempt >= MAX) throw err
    console.log('  … ' + f.name + ' 上传中断（' + err.message + '），重试 ' + attempt + '/' + (MAX - 1))
    await sleep(2000 * attempt)
    return uploadAsset(url, f, attempt + 1)
  }
  if ([301, 302, 307, 308].includes(res.status)) {
    const next = res.headers.get('location')
    if (next && attempt < MAX) {
      console.log('  … ' + f.name + ' 被重定向，换地址重发')
      return uploadAsset(next, f, attempt + 1)
    }
  }
  // 5xx 是服务端侧的暂时故障，值得重试；4xx 是我们自己的问题，重试没有意义
  if (res.status >= 500 && attempt < MAX) {
    console.log('  … ' + f.name + ' 服务端返回 ' + res.status + '，重试 ' + attempt + '/' + (MAX - 1))
    await sleep(2000 * attempt)
    return uploadAsset(url, f, attempt + 1)
  }
  return res
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB']
  let v = n, i = 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i]
}

/** Release 说明。正文里带上「怎么装」，因为看到这个页面的人多半是来下载的 */
function buildNotes() {
  return [
    '### FlowProbe ' + tag,
    '',
    'Windows：下载 `FlowProbe-Setup-' + version + '.exe` 双击安装。',
    '',
    '已装过旧版的话不用手动下载：打开应用 → 帮助 → 检查更新。',
    '',
    '> `latest.yml` 是自动更新用的版本清单，不需要手动下载。'
  ].join('\n')
}