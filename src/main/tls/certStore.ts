import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import type { TlsCertInfo, TlsGenerateRequest, TlsMaterial } from '@shared/protocol'
import { generateSelfSigned } from './selfSigned'

/**
 * 证书目录。放在 userData 下而不是安装目录：安装目录在 Program Files 里通常不可写，
 * 而且升级重装会被清掉——证书跟着一起消失是最难查的「昨天还能用」类问题。
 */
function certDir(): string {
  const dir = path.join(app.getPath('userData'), 'certs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function certsDirPath(): string {
  return certDir()
}

/** 文件名安全化：会话名可能带斜杠、冒号等非法字符 */
function safeName(raw: string): string {
  const cleaned = raw.replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '_').slice(0, 40)
  return cleaned || 'mock'
}

/**
 * 解析证书并给出体检结论。
 *
 * 为什么把「私钥是否匹配」也放进来：配错对（拿了另一张证书的 key）时
 * https.createServer 不会立刻报错，而是在第一个请求握手时才失败，
 * 表现为「服务显示监听中，浏览器却打不开」。提前校验能把问题挪到配置阶段。
 */
export function inspectCert(certPem: string, keyPem?: string): TlsCertInfo {
  if (!certPem || !certPem.trim()) return { ok: false, error: '未提供证书' }
  let x: crypto.X509Certificate
  try {
    x = new crypto.X509Certificate(certPem)
  } catch (e) {
    return { ok: false, error: '证书无法解析：' + (e as Error).message }
  }
  const validFrom = Date.parse(x.validFrom)
  const validTo = Date.parse(x.validTo)
  const daysLeft = Math.floor((validTo - Date.now()) / 86400000)
  const altNames = (x.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  let keyMatch: boolean | undefined
  let error: string | undefined
  if (keyPem && keyPem.trim()) {
    try {
      keyMatch = x.checkPrivateKey(crypto.createPrivateKey(keyPem))
      if (!keyMatch) error = '私钥与证书不匹配'
    } catch (e) {
      keyMatch = false
      error = '私钥无法解析：' + (e as Error).message
    }
  }
  if (!error && daysLeft < 0) error = '证书已过期'

  return {
    ok: !error,
    error,
    subject: x.subject.split('\n').join(', '),
    issuer: x.issuer.split('\n').join(', '),
    selfSigned: x.subject === x.issuer,
    validFrom,
    validTo,
    daysLeft,
    altNames,
    fingerprint256: x.fingerprint256,
    keyMatch
  }
}

/** 生成自签证书并落盘，返回 PEM 正文与路径 */
export function generateAndSave(req: TlsGenerateRequest): TlsMaterial {
  const { certPem, keyPem } = generateSelfSigned({
    hosts: req.hosts,
    days: req.days
  })
  const base = safeName(req.name ?? 'mock')
  const stamp = new Date().toISOString().slice(0, 10).split('-').join('')
  const dir = certDir()
  const certPath = path.join(dir, base + '-' + stamp + '.crt')
  const keyPath = path.join(dir, base + '-' + stamp + '.key')
  fs.writeFileSync(certPath, certPem, 'utf8')
  // 私钥只给当前用户读写。Windows 上 mode 基本被忽略，但 mac/Linux 上有实际意义
  fs.writeFileSync(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 })
  return { certPem, keyPem, certPath, keyPath, info: inspectCert(certPem, keyPem) }
}

/** 从磁盘读入一对证书文件 */
export function importFromFiles(certPath: string, keyPath: string): TlsMaterial {
  const certPem = fs.readFileSync(certPath, 'utf8')
  const keyPem = fs.readFileSync(keyPath, 'utf8')
  return { certPem, keyPem, certPath, keyPath, info: inspectCert(certPem, keyPem) }
}
