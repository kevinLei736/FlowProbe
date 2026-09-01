// 把 client-readme/ 下的中英双语 README 发布到客户端仓库（只放安装包的公开仓库）。
//
// 为什么走 Contents API 而不是 clone 发布仓库：
// 发布仓库在本地没有工作副本，为一次文档更新建一个副本会多出一份需要同步的状态。
//
// 用法：node scripts/publish-client-readme.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 令牌只从 .env 读：写进命令行参数会出现在进程列表里，写进远端 URL 会永久留在 .git/config
const readEnv = () => {
  const file = path.join(root, '.env')
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0 && !line.startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

const env = { ...readEnv(), ...process.env }
const token = env.DT_GITHUB_TOKEN
const repo = env.DT_RELEASE_REPO || 'kevinLei736/FlowProbeClient'
if (!token) throw new Error('缺少 DT_GITHUB_TOKEN（放在项目根目录 .env 里）')

const api = async (endpoint, init = {}) => {
  const res = await fetch('https://api.github.com/repos/' + repo + endpoint, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'flowprobe-readme',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样保留，便于看清报错 */ }
  return { status: res.status, body }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 覆盖已有文件必须带它当前的 sha，否则 GitHub 返回 422；新建文件反而不能带。
const putFile = async (name, localPath) => {
  const current = await api('/contents/' + name)
  const sha = current.status === 200 && current.body && current.body.sha ? current.body.sha : undefined
  const payload = {
    message: 'docs: update bilingual README',
    content: fs.readFileSync(localPath).toString('base64'),
    branch: 'main'
  }
  if (sha) payload.sha = sha
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await api('/contents/' + name, { method: 'PUT', body: JSON.stringify(payload) })
    if (res.status === 200 || res.status === 201) {
      console.log(name + ' -> HTTP ' + res.status + (sha ? '（覆盖）' : '（新建）'))
      return true
    }
    console.error(name + ' 第 ' + attempt + ' 次失败 -> HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300))
    // 4xx 是请求本身有问题，重试只会重复失败；5xx 与网络抖动才值得退避重试
    if (res.status < 500) return false
    await sleep(attempt * 2000)
  }
  return false
}

const files = [
  ['README.md', path.join(root, 'client-readme', 'README.md')],
  ['README.en.md', path.join(root, 'client-readme', 'README.en.md')]
]

let failed = false
for (const [name, localPath] of files) {
  if (!(await putFile(name, localPath))) failed = true
}

// 匿名回读一次：带令牌的写入成功不代表匿名访客看到的内容正确（缓存、编码、分支）
// 回读走 raw.githubusercontent.com，本机到它的连通性时有中断，所以重试几次；
// 回读失败只警告不判失败 —— 写入已经返回 200，把上传结果绑在一条易抖的链路上会误报。
const raw = 'https://raw.githubusercontent.com/' + repo + '/main/'
for (const [name] of files) {
  let done = false
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    try {
      const res = await fetch(raw + name + '?t=' + Date.now())
      const text = await res.text()
      const broken = text.includes(String.fromCharCode(65533))
      console.log('回读 ' + name + ' -> HTTP ' + res.status + ' · ' + text.length + ' 字符 · 乱码=' + broken)
      if (res.status !== 200 || broken) failed = true
      done = true
    } catch (err) {
      const reason = err && err.cause && err.cause.code ? err.cause.code : String(err)
      if (attempt === 3) {
        console.warn('回读 ' + name + ' 未完成（' + reason + '）：写入已成功，只是本机连不上 raw 域名，可稍后到网页确认')
      } else {
        await sleep(attempt * 2000)
      }
    }
  }
}

if (failed) process.exit(1)
console.log('完成')