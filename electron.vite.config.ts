import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/*
  产物混淆。

  先说清楚这件事的上限：Electron 应用做不到真正的加密。渲染进程的 JS 最终要交给
  Chromium 执行，主进程的 JS 要交给 Node 执行，两者都必须以可执行形式存在于安装目录里。
  asar 只是一个未压缩的归档格式，`npx asar extract` 一条命令就能摊开，它从来不是保护手段。

  所以目标不是「不可能读」，而是「读了也没有收益」：

  - **删掉全部注释**。这是默认构建里最实在的一处泄漏 —— 本项目的注释专门解释「为什么这么做」
    （字序为什么要两个开关、为什么不上 FTS5、冷却为什么要在改规则时清掉），
    这些是真正花时间试出来的判断，比代码本身值钱得多。默认构建把它们原样保留在产物里。
  - **标识符改名**。`alertRuntime`、`cooldownLedger`、`slaveDataArea` 这类名字本身就是架构说明书，
    压成单字母后，读的人得自己重建整套心智模型。
  - **去掉源码结构**。折行与缩进消失后，函数边界要靠人工判断。

  刻意不做的两件事：

  - **不上 bytenode / V8 字节码**。它把 JS 编译成 .jsc，看着更彻底，代价是字节码与 Electron 的
    V8 版本强绑定：升一次 Electron 就要全量重编，且一旦版本对不上是启动即崩而不是报错。
    而它防的仍然只是「随手看一眼」的人 —— 字节码可以反汇编。为一个提升有限的效果换来一处
    版本耦合的崩溃风险，不划算。
  - **不加壳 / 不加密 asar**。解密密钥必须随程序分发，等于把钥匙插在锁上。
*/
const minifyOptions = {
  // esbuild 够快也够狠，且已是 vite 内置，不额外引 terser
  minify: 'esbuild' as const,
  // 默认会保留 /*! 与 @license 段；这里全部丢掉（依赖许可证在仓库的 package.json 里可查）
  cssMinify: true
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...minifyOptions,
      // 不出 sourcemap：它把压缩过的产物一键还原回带注释的原始代码，等于前面的工作全部作废
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    esbuild: {
      legalComments: 'none'
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...minifyOptions,
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    esbuild: {
      legalComments: 'none'
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      ...minifyOptions,
      sourcemap: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          // 产物名带 hash 即可，不再把源文件名写进 chunk 名（那等于把目录结构也一起发出去）
          entryFileNames: 'assets/[hash].js',
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash].[ext]'
        }
      }
    },
    esbuild: {
      legalComments: 'none'
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
