#!/usr/bin/env node
/**
 * Sona 构建产物不变量校验（零依赖）
 *
 * 校验自动更新契约：
 * - 产物为 index.js（冻结引导器）+ app.js + app.css + version.json + update.json
 * - 没有额外 JS chunk（引导器与应用包不得共享 chunk）
 * - 没有外部二进制资源，app.js 不 import CSS，app.css 不引用 assets
 * - version.json / update.json 与 package.json、磁盘文件一致
 *
 * 用法：node scripts/check-build.mjs（需先运行 bash scripts/build.sh）
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')
const EXPECTED_FILES = ['index.js', 'app.js', 'app.css', 'version.json', 'update.json']
const EXPECTED_JS = new Set(['index.js', 'app.js'])
const ARTIFACT_FILES = ['app.js', 'app.css']
const MAX_ENTRY_SIZE = 60 * 1024
const MAX_ARTIFACT_SIZE = 8 * 1024 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const failures = []

function fail(message) {
  failures.push(message)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function listFiles(dir, prefix = '') {
  const result = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...listFiles(path.join(dir, entry.name), relativePath))
    } else {
      result.push(relativePath)
    }
  }
  return result
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

if (!fs.existsSync(DIST_DIR)) {
  console.error('[check-build] 未找到 dist/，请先运行 bash scripts/build.sh')
  process.exit(1)
}

const pkg = readJson(path.join(ROOT_DIR, 'package.json'))
const files = listFiles(DIST_DIR)

for (const expected of EXPECTED_FILES) {
  if (!files.includes(expected)) fail(`缺少产物：dist/${expected}`)
}

for (const file of files) {
  if (file.startsWith('assets/')) continue
  if (!EXPECTED_FILES.includes(file)) fail(`dist 中出现预期外的文件：dist/${file}`)
}

for (const file of files.filter((item) => item.endsWith('.js'))) {
  if (!EXPECTED_JS.has(file)) fail(`出现预期外的 JS 产物（可能是共享 chunk）：dist/${file}`)
}

const assetsDir = path.join(DIST_DIR, 'assets')
if (fs.existsSync(assetsDir)) {
  const assetFiles = listFiles(assetsDir)
  if (assetFiles.length > 0) {
    fail(`dist/assets 中存在外部资源，更新负载必须为纯文本：${assetFiles.join(', ')}`)
  }
}

const entryPath = path.join(DIST_DIR, 'index.js')
if (fs.existsSync(entryPath)) {
  const size = fs.statSync(entryPath).size
  if (size <= 0) fail('dist/index.js 为空')
  if (size >= MAX_ENTRY_SIZE) fail(`dist/index.js 体积 ${size} 字节，超过 60 KB 上限`)
}

const appPath = path.join(DIST_DIR, 'app.js')
if (fs.existsSync(appPath)) {
  const appSource = fs.readFileSync(appPath, 'utf8')
  if (!appSource.trim()) fail('dist/app.js 为空')
  if (/(?:import|from)\s*["'][^"']+\.css["']/.test(appSource)) {
    fail('dist/app.js 中仍存在 CSS import，CSS 必须由引导器注入')
  }
  if (/["']\/assets\//.test(appSource)) {
    fail('dist/app.js 中仍存在 /assets/ 绝对路径，资源路径未改写')
  }
}

const cssPath = path.join(DIST_DIR, 'app.css')
if (fs.existsSync(cssPath)) {
  const cssSource = fs.readFileSync(cssPath, 'utf8')
  if (!cssSource.trim()) fail('dist/app.css 为空')
  if (/url\(\s*["']?[^)"']*assets\//.test(cssSource)) {
    fail('dist/app.css 引用了外部 assets 资源，内置资源必须内联')
  }
}

const versionPath = path.join(DIST_DIR, 'version.json')
if (fs.existsSync(versionPath)) {
  const version = readJson(versionPath)
  if (version.version !== pkg.version) {
    fail(`version.json 版本 (${version.version}) 与 package.json (${pkg.version}) 不一致`)
  }
  if (!Number.isFinite(version.builtAt) || version.builtAt <= 0) {
    fail('version.json 缺少有效的 builtAt 时间戳')
  }
}

const manifestPath = path.join(DIST_DIR, 'update.json')
if (fs.existsSync(manifestPath)) {
  const manifest = readJson(manifestPath)
  if (manifest.version !== pkg.version) {
    fail(`update.json 版本 (${manifest.version}) 与 package.json (${pkg.version}) 不一致`)
  }

  const manifestFiles = manifest.files && typeof manifest.files === 'object' ? manifest.files : {}
  const keys = Object.keys(manifestFiles)
  for (const expected of ARTIFACT_FILES) {
    if (!keys.includes(expected)) fail(`update.json 缺少文件条目：${expected}`)
  }
  for (const key of keys) {
    if (!ARTIFACT_FILES.includes(key)) fail(`update.json 包含不允许的文件：${key}`)
  }

  for (const file of ARTIFACT_FILES) {
    const info = manifestFiles[file]
    if (!info) continue
    if (!SHA256_PATTERN.test(info.sha256 ?? '')) {
      fail(`update.json 中 ${file} 的 sha256 不是 64 位小写十六进制`)
    }
    if (!Number.isInteger(info.size) || info.size <= 0 || info.size > MAX_ARTIFACT_SIZE) {
      fail(`update.json 中 ${file} 的 size 非法或超过 8 MB`)
      continue
    }
    const artifactPath = path.join(DIST_DIR, file)
    if (!fs.existsSync(artifactPath)) {
      fail(`缺少 update.json 引用的文件：dist/${file}`)
      continue
    }
    const buffer = fs.readFileSync(artifactPath)
    if (buffer.byteLength !== info.size) {
      fail(`${file} 实际大小 ${buffer.byteLength} 与 update.json (${info.size}) 不一致`)
    }
    if (sha256(buffer) !== info.sha256) {
      fail(`${file} 实际 SHA-256 与 update.json 不一致`)
    }
  }
}

if (failures.length > 0) {
  console.error('[check-build] 构建不变量校验失败：')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('[check-build] 通过：index.js / app.js / app.css / version.json / update.json 符合自动更新契约')
