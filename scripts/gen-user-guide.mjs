/**
 * 从应用内使用文档的同一份数据生成 docs/使用文档.md。
 *
 * 为什么走 esbuild 而不是直接 import：guideContent.ts / guideMarkdown.ts 是
 * TypeScript，Node 不能直接跑；也不想为了一个文档脚本引入 ts-node。
 * 打成一个临时 ESM 文件再 import，跑完删掉，仓库里不留产物。
 */
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const tmp = resolve(root, 'node_modules/.cache/guide-bundle.mjs')

mkdirSync(dirname(tmp), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/renderer/src/features/help/guideMarkdown.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: tmp,
  logLevel: 'error'
})

const { guideToMarkdown } = await import('file://' + tmp.split('\\').join('/'))
const md = guideToMarkdown()
const out = resolve(root, 'docs/使用文档.md')
// 文档统一 LF：Markdown 在 Git 与各类渲染器里以 LF 为常态
writeFileSync(out, md.split('\r\n').join('\n'), 'utf8')
rmSync(tmp, { force: true })
console.log('已生成 ' + out + '（' + md.length + ' 字符，' + md.split('\n').length + ' 行）')
