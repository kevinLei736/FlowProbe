#!/usr/bin/env bash
# macOS 首次打包 / 从 Windows 拷贝过来后的一键修复脚本。
#
# 为什么需要它：项目连同 node_modules 从 Windows 拷到 mac 时，npm 只比对
# package-lock 里的版本号，不校验二进制平台，因此 `npm install` 会直接报
# "up to date" 并跳过安装。结果是：
#   1) node_modules/.bin 里仍是 Windows 的 .cmd/.ps1，且丢了 Unix 可执行位
#      → 运行 npm run build 报 "sh: .../electron-vite: Permission denied"
#   2) better-sqlite3 仍是按 Windows + Electron ABI 编译的 .node
#      → 即便绕过第 1 点，打包或启动时也会崩
# 唯一可靠的解法是把 node_modules 删干净重装，并按 Electron 的 ABI 重编原生模块。

set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> 工作目录: $(pwd)"

if [ "$(id -u)" -eq 0 ]; then
  echo "!! 不要使用 sudo 运行 setup:mac。"
  echo "   npm/node 生成的依赖和 release 产物必须归当前用户所有，否则 electron-builder 无法清理旧文件。"
  exit 1
fi

# 国内网络下载 Electron 二进制很慢，这里默认走镜像。
# 已自行配置代理的用户可以先 export ELECTRON_MIRROR= 覆盖为空。
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

# 前置检查：Xcode Command Line Tools。
# 这里只警告不退出——better-sqlite3 对 darwin-arm64 + Electron ABI 有官方预编译包，
# 能下到预编译产物时不需要本地编译器。真正编译失败会在第 5 步的产物校验里被拦下。
if xcode-select -p >/dev/null 2>&1; then
  echo "==> Xcode CLT: $(xcode-select -p)"
else
  echo "!! 未检测到 Xcode Command Line Tools。"
  echo "   若原生模块无法下载预编译包而需要本地编译，请执行: xcode-select --install"
fi
echo "==> Node: $(node -v) / npm: $(npm -v)"
echo "==> 架构: $(uname -m)"

# 1) 删掉从 Windows 带过来的依赖树。只删本项目内的 node_modules，
#    package-lock.json 保留（版本锁定信息是跨平台通用的）。
if [ -d node_modules ]; then
  echo "==> 移除旧 node_modules（Windows 平台产物）"
  rm -rf node_modules
fi

# 2) 重新安装。--foreground-scripts 让原生模块的编译日志直接可见，
#    出错时能立刻看到是哪个包、缺什么头文件。
echo "==> 重新安装依赖（含原生模块编译，耗时较久）"
npm install --foreground-scripts

# 3) 按 Electron 的 ABI 重编原生模块。
#    注意：npm install 编出来的是 Node ABI 版本，Electron 内置的 V8/Node 版本不同，
#    直接用会报 NODE_MODULE_VERSION 不匹配。install-app-deps 会用 Electron 的头文件重编。
echo "==> 按 Electron ABI 重建原生模块"
npx electron-builder install-app-deps

# 4) 兜底修可执行位。极少数情况下（拷贝残留、umask 异常）.bin 里的软链权限仍不对。
if [ -d node_modules/.bin ]; then
  chmod +x node_modules/.bin/* 2>/dev/null || true
fi

# 5) 校验原生模块真的编出来了。
#    为什么必须显式校验：新版 npm 的 allowScripts 是交互式安全特性，
#    项目 .npmrc 里的 ignore-scripts=false 管不到它。被拦时 npm 只打一行 warn
#    然后**正常退出**，用户完全看不出 better-sqlite3 压根没编译，
#    直到打包完运行时才崩。把隐性失败提前变成显性报错。
missing=0
if [ ! -f node_modules/better-sqlite3/build/Release/better_sqlite3.node ]; then
  echo ""
  echo "!! better-sqlite3 的原生模块没有编译成功。"
  echo "   若上面 npm install 出现过 'install scripts not yet covered by allowScripts'，"
  echo "   说明安装脚本被 npm 拦下了。请执行下面命令放行后重跑本脚本："
  echo "     npm install-scripts approve better-sqlite3"
  echo "     npm install-scripts approve @serialport/bindings-cpp"
  echo "     npm install-scripts approve electron"
  echo "     npm install-scripts approve esbuild"
  missing=1
fi
if [ ! -x node_modules/.bin/electron-vite ]; then
  echo "!! node_modules/.bin/electron-vite 不可执行，构建会报 Permission denied。"
  missing=1
fi
if [ "$missing" = "1" ]; then
  echo ""
  echo "==> 未通过校验，请按上面的提示处理后重新运行本脚本。"
  exit 1
fi
echo "==> 原生模块与可执行位校验通过"

echo ""
echo "==> 完成。接下来可以打包："
echo "    npm run dist:mac        # dmg + zip，arm64 与 x64 都出"
echo "    npm run dist:mac:arm    # 只出 Apple Silicon 版本（更快）"
