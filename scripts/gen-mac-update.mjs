import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('..', import.meta.url)))
const releaseDir = join(root, 'release')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const prefix = 'FlowProbe-'
const suffix = '-mac.zip'

function sha512(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
    stream.on('error', reject)
  })
}

const files = readdirSync(releaseDir)
  .filter(name => name.startsWith(prefix + version + '-') && name.endsWith(suffix))
  .sort()

if (!files.length) {
  console.error('未找到 macOS zip 产物，无法生成 latest-mac.yml')
  process.exit(1)
}

const entries = []
for (const name of files) {
  const filePath = join(releaseDir, name)
  if (!existsSync(filePath)) continue
  entries.push({ name, sha512: await sha512(filePath) })
}

const first = entries[0]
const lines = [
  'version: ' + version,
  'files:'
]
for (const entry of entries) {
  lines.push('  - url: ' + entry.name, '    sha512: ' + entry.sha512)
}
lines.push(
  'path: ' + first.name,
  'sha512: ' + first.sha512,
  'releaseDate: ' + new Date().toISOString(),
  ''
)

const outputPath = join(releaseDir, 'latest-mac.yml')
writeFileSync(outputPath, lines.join('\n'), 'utf8')
console.log('已生成 ' + basename(outputPath) + '（' + entries.length + ' 个 macOS zip）')
