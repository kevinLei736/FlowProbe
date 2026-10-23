/**
 * 网络错误的统一中文解释。
 *
 * 各适配器原来直接 `emitError(err.message)`，用户看到的是 `connect ECONNREFUSED
 * 127.0.0.1:9000` 这类英文底层错误。同一个原因在不同模块还会出现不同措辞，
 * 排查时很难判断「是端口没开、被防火墙拦了，还是证书不对」。
 * 这里按 errno 收敛成一句原因 + 一句下一步该查什么。
 */

function codeOf(err: Error): string {
  return String((err as NodeJS.ErrnoException).code ?? '')
}

export function describeListenError(err: Error, host: string, port: number): string {
  const code = codeOf(err)
  if (code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用。换一个端口，或先停掉占用它的进程。`
  }
  if (code === 'EACCES') {
    return `没有权限监听 ${host}:${port}。${port < 1024 ? '1024 以下的端口需要管理员权限，' : ''}换一个更高的端口再试。`
  }
  if (code === 'EADDRNOTAVAIL') {
    return `本机没有地址 ${host}，请检查监听地址是否填错。`
  }
  if (code === 'EINVAL') {
    return `监听参数无效：${err.message}`
  }
  return err.message || '监听失败'
}

export function describeConnectError(err: Error, target: string): string {
  const code = codeOf(err)
  if (code === 'ECONNREFUSED') {
    return `连接被拒绝：${target} 上没有服务在监听，或防火墙拦住了这个端口。`
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `域名解析失败：找不到 ${target}。检查地址拼写与本机 DNS。`
  }
  if (code === 'ETIMEDOUT') {
    return `连接超时：${target} 在限定时间内没有响应，检查网络与防火墙。`
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `网络不可达：本机到 ${target} 没有可用路由。`
  }
  if (code === 'ECONNRESET') {
    return `连接被对端重置：${target} 主动断开了链路，可能是协议或鉴权不匹配。`
  }
  if (code === 'EPIPE') {
    return '连接已断开，数据没有发出去。'
  }
  if (
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return `TLS 证书校验失败（${code}）。导入正确的 CA，或在会话设置里关闭「校验服务端证书」。`
  }
  return err.message || '连接失败'
}

/**
 * 串口错误的解释。
 *
 * 串口失败几乎只有三类：被别的工具占着、当前用户没权限、设备不在了。
 * 底层消息在不同平台上分别长成 "Access denied" / "Resource temporarily
 * unavailable" / "File not found"，直接抛给用户等于让他去搜英文。
 */
export function describeSerialError(err: Error, path: string): string {
  const message = err.message || ''
  const code = codeOf(err)
  if (code === 'EBUSY' || code === 'EACCES' || /access denied|resource temporarily unavailable/i.test(message)) {
    return `无法打开串口 ${path}：它正被其他程序占用，或当前用户没有权限。关闭占用它的工具后再试。`
  }
  if (code === 'ENOENT' || /file not found|cannot find/i.test(message)) {
    return `找不到串口 ${path}。确认设备已连接、驱动已安装，并点「刷新」重新枚举。`
  }
  if (code === 'EPERM' || /permission denied/i.test(message)) {
    return `没有权限访问 ${path}。macOS / Linux 下需要把当前用户加入 dialout 或 uucp 组。`
  }
  return message || '串口打开失败'
}
