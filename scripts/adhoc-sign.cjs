const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

/**
 * electron-builder 的 afterSign 钩子：给 mac 产物做 ad-hoc 签名。
 *
 * 为什么必须签：Apple Silicon 内核会拒绝执行签名无效的二进制，未签名的 .app
 * 双击后被直接杀掉（用户侧表现为闪退或「App 已损坏」）。我们没有 Apple
 * 开发者证书，用 `codesign -s -` 做 ad-hoc 签名即可满足内核校验；
 * 代价是首次打开仍需在「隐私与安全性」里点一次「仍要打开」（Gatekeeper 公证是另一回事）。
 *
 * 为什么自己签而不交给 electron-builder：配置里 identity: null 会让它整体跳过
 * 签名流程（这是我们要的，避免它去找不存在的证书然后报错），所以补签放在这里。
 */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  // 只在 mac 上执行；Windows/Linux 机器上交叉打 mac 包时没有 codesign 命令
  if (process.platform !== 'darwin') {
    console.log('[adhoc-sign] 跳过：当前不是 macOS，无 codesign 命令')
    return
  }

  const appName = context.packager.appInfo.productFilename + '.app'
  const appPath = join(context.appOutDir, appName)
  if (!existsSync(appPath)) {
    console.log('[adhoc-sign] 跳过：未找到 ' + appPath)
    return
  }

  // 收集需要单独签名的内层目标：原生 .node、Helper 子应用、dylib/framework。
  // asarUnpack 出来的 better-sqlite3 / serialport 二进制就在这里面。
  const inner = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.endsWith('.app') || e.name.endsWith('.framework')) inner.push(p)
        walk(p, depth + 1)
      } else if (e.isFile() && (e.name.endsWith('.node') || e.name.endsWith('.dylib'))) {
        inner.push(p)
      }
    }
  }
  walk(join(appPath, 'Contents'), 0)

  // 由内到外：路径越深先签，最后签 .app 本体
  inner.sort((a, b) => b.split('/').length - a.split('/').length)

  // entitlements 只加在最外层 .app 上：对 .node / .dylib 附加 entitlements 会被
  // codesign 拒绝，而权限本身是按 App 主可执行文件生效的。
  const entPath = join(__dirname, '..', 'build', 'entitlements.mac.plist')
  const hasEnt = existsSync(entPath)

  const sign = (target, withEntitlements) => {
    const args = ['--deep', '--force', '--sign', '-', '--timestamp=none']
    if (withEntitlements && hasEnt) args.push('--entitlements', entPath)
    args.push(target)
    execFileSync('codesign', args, { stdio: 'pipe' })
  }

  let ok = 0
  for (const target of inner) {
    sign(target, false)
    ok++
  }
  // 最后签本体。内层内容变过之后外层签名必然失效，所以顺序不能反。
  sign(appPath, true)
  console.log('[adhoc-sign] 完成：内层 ' + ok + '/' + inner.length + ' 个 + 应用本体 ' + appName)

  // 立刻自检，避免把坏包发出去
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })
    console.log('[adhoc-sign] 校验通过')
  } catch {
    console.warn('[adhoc-sign] 校验未通过，产物可能无法在 Apple Silicon 上启动')
  }
}
