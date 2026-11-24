#!/usr/bin/env node
/**
 * 将 package.json 与 package-lock.json 的 version 字段同步为指定版本号。
 *
 * 用法：node scripts/update-version.mjs <version>
 * 示例：node scripts/update-version.mjs 2026.11.24.1
 *
 * 使用 .mjs 而非 .ts，是为了让 CI 在未安装依赖时也能直接运行。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/
const version = process.argv[2]

if (!version || !VERSION_PATTERN.test(version)) {
  console.error(`无效版本号：${version ?? '(空)'}，期望格式「年.月.日.序号」，例如 2026.11.24.1`)
  process.exit(1)
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.version = version
writeJson('package.json', pkg)

if (existsSync('package-lock.json')) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  lock.version = version
  if (lock.packages?.['']) lock.packages[''].version = version
  writeJson('package-lock.json', lock)
}

console.log(`版本号已更新为 ${version}`)
