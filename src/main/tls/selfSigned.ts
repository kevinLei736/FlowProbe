import * as crypto from 'node:crypto'

/**
 * 自签名证书生成器（纯 node:crypto，无第三方依赖）。
 *
 * 为什么自己拼 ASN.1 而不是装 selfsigned/node-forge：
 * 这里需要的是「一张本地自签服务器证书」，X.509 的必需结构就那么几段。
 * 为此引入 node-forge（连带一整套自实现的 RSA/ASN.1 运算）会给主进程
 * 增加数百 KB 且多一条供应链依赖，而密钥生成与签名 node:crypto 本来就有。
 * 生成结果会用 crypto.X509Certificate 回读校验，结构错了当场就能发现。
 */

// —— 最小 DER 编码器 ——

/** 编码 ASN.1 长度：短格式 < 128，否则长格式（0x80 | 字节数）+ 大端长度 */
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts))
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts))
const derNull = (): Buffer => Buffer.from([0x05, 0x00])
const derBool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]))
const utf8Str = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const ia5Str = (s: string): Buffer => tlv(0x16, Buffer.from(s, 'ascii'))
const octetStr = (b: Buffer): Buffer => tlv(0x04, b)

/** INTEGER：DER 要求最短补码表示，最高位为 1 时需前置 0x00 以保持正数 */
function derInt(value: number | Buffer): Buffer {
  let buf: Buffer
  if (typeof value === 'number') {
    if (value === 0) return tlv(0x02, Buffer.from([0]))
    const bytes: number[] = []
    let v = value
    while (v > 0) {
      bytes.unshift(v & 0xff)
      v = Math.floor(v / 256)
    }
    buf = Buffer.from(bytes)
  } else {
    buf = value
    let i = 0
    while (i < buf.length - 1 && buf[i] === 0 && (buf[i + 1] & 0x80) === 0) i++
    buf = buf.subarray(i)
  }
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf])
  return tlv(0x02, buf)
}

/** BIT STRING：首字节是「末字节未使用位数」，证书里用到的都是 0 */
const bitStr = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]))

/** OID：前两节压成 40*a+b，其余按 7 位一组的可变长编码 */
function derOid(dotted: string): Buffer {
  const parts = dotted.split('.').map((x) => Number(x))
  const bytes: number[] = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    if (part === 0) {
      bytes.push(0)
      continue
    }
    const group: number[] = []
    let v = part
    while (v > 0) {
      group.unshift(v & 0x7f)
      v = v >>> 7
    }
    for (let i = 0; i < group.length - 1; i++) group[i] |= 0x80
    bytes.push(...group)
  }
  return tlv(0x06, Buffer.from(bytes))
}

/** UTCTime：YYMMDDHHMMSSZ，X.509 对 2049 年前的时间要求用这个类型 */
function utcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0')
  const s =
    p(d.getUTCFullYear() % 100) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    'Z'
  return tlv(0x17, Buffer.from(s, 'ascii'))
}

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  sha256Rsa: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
  serverAuth: '1.3.6.1.5.5.7.3.1'
}

function name(cn: string, org: string): Buffer {
  return seq(
    set(seq(derOid(OID.organization), utf8Str(org))),
    set(seq(derOid(OID.commonName), utf8Str(cn)))
  )
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
  return critical
    ? seq(derOid(oid), derBool(true), octetStr(value))
    : seq(derOid(oid), octetStr(value))
}

/** 判断是否为 IPv4 字面量：SAN 里 IP 必须走 iPAddress，写成 dNSName 浏览器与 Node 都不认 */
function asIPv4(host: string): Buffer | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = [1, 2, 3, 4].map((i) => Number(m[i]))
  if (parts.some((x) => x > 255)) return null
  return Buffer.from(parts)
}

export interface SelfSignedOptions {
  /** 主机名与 IP 列表，第一个非 IP 项作为 CN */
  hosts: string[]
  /** 有效天数 */
  days: number
  /** 组织名，仅用于证书主题展示 */
  org?: string
}

export interface SelfSignedResult {
  certPem: string
  keyPem: string
}

/**
 * 生成一张自签名服务器证书（RSA-2048 / SHA-256）。
 *
 * 同时把自己写成 CA（basicConstraints cA=TRUE + keyCertSign），
 * 这样用户可以把这张证书直接导入系统信任库让浏览器认它——
 * 只签自己却不是 CA 的证书，导入后 Chrome 仍会报 ERR_CERT_AUTHORITY_INVALID。
 */
export function generateSelfSigned(opts: SelfSignedOptions): SelfSignedResult {
  const hosts = opts.hosts.map((h) => h.trim()).filter(Boolean)
  if (hosts.length === 0) hosts.push('localhost')
  const cn = hosts.find((h) => !asIPv4(h)) ?? hosts[0]
  const org = opts.org && opts.org.trim() ? opts.org.trim() : 'FlowProbe'

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer

  const notBefore = new Date(Date.now() - 60 * 60 * 1000) // 回拨 1 小时，容忍机器间时钟偏差
  const notAfter = new Date(Date.now() + Math.max(1, opts.days) * 24 * 60 * 60 * 1000)

  // subjectKeyIdentifier 按 RFC 5280 取公钥 BIT STRING 内容的 SHA-1
  const spkiBitString = ((): Buffer => {
    // SPKI = SEQUENCE { algorithm, subjectPublicKey BIT STRING }，取最后那段 BIT STRING 的内容
    let i = 1
    const readLen = (): number => {
      const first = spki[i++]
      if (first < 0x80) return first
      let n = 0
      for (let k = 0; k < (first & 0x7f); k++) n = n * 256 + spki[i++]
      return n
    }
    readLen()
    // 跳过 algorithm
    const algTag = spki[i++]
    void algTag
    const algLen = readLen()
    i += algLen
    // 现在指向 BIT STRING
    i++
    const bitLen = readLen()
    return spki.subarray(i + 1, i + bitLen) // +1 跳过未使用位数字节
  })()
  const skid = crypto.createHash('sha1').update(spkiBitString).digest()

  const sanNames = hosts.map((h) => {
    const ip = asIPv4(h)
    // dNSName = [2] IA5String（隐式），iPAddress = [7] OCTET STRING（隐式）
    return ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(h, 'ascii'))
  })

  const extensions = tlv(
    0xa3,
    seq(
      extension(OID.basicConstraints, true, seq(derBool(true))),
      // digitalSignature(0) + keyEncipherment(2) + keyCertSign(5) → 0b10100100，末字节 2 位未用
      extension(OID.keyUsage, true, tlv(0x03, Buffer.from([0x01, 0xa4]))),
      extension(OID.extKeyUsage, false, seq(derOid(OID.serverAuth))),
      extension(OID.subjectAltName, false, seq(...sanNames)),
      extension(OID.subjectKeyId, false, octetStr(skid))
    )
  )

  const sigAlg = seq(derOid(OID.sha256Rsa), derNull())
  const subject = name(cn, org)
  const serial = ((): Buffer => {
    const b = crypto.randomBytes(8)
    b[0] = b[0] & 0x7f // 保证正数
    return b
  })()

  const tbs = seq(
    tlv(0xa0, derInt(2)), // version v3
    derInt(serial),
    sigAlg,
    subject, // 自签：issuer == subject
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    extensions
  )

  const signature = crypto.createSign('sha256').update(tbs).sign(privateKey)
  const cert = seq(tbs, sigAlg, bitStr(signature))

  const certPem = pem('CERTIFICATE', cert)
  const keyPem = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString()

  // 立刻回读校验：结构错了这里就抛，不会把坏证书写到磁盘再等启动失败
  const parsed = new crypto.X509Certificate(certPem)
  if (!parsed.subject) throw new Error('生成的证书无法解析')

  return { certPem, keyPem }
}

function pem(label: string, der: Buffer): string {
  const b64 = der.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64))
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}
