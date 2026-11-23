#!/usr/bin/env node
/**
 * 在 CHANGELOG.md 顶部插入一个新的版本块。
 *
 * 用法：node scripts/prepend-changelog.mjs <version> <date> <body-file> [section-title]
 * 示例：node scripts/prepend-changelog.mjs 2026.11.24.1 2026-11-24 /tmp/notes.md "📝 变更"
 *
 * 使用 .mjs 而非 .ts，是为了让 CI 在未安装依赖时也能直接运行。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const CHANGELOG_FILE = 'CHANGELOG.md'
const [version, date, bodyFile, section = '📝 变更'] = process.argv.slice(2)

if (!version || !date || !bodyFile) {
  console.error('用法：node scripts/prepend-changelog.mjs <version> <date> <body-file> [section-title]')
  process.exit(1)
}
if (!existsSync(bodyFile)) {
  console.error(`找不到发布说明文件：${bodyFile}`)
  process.exit(1)
}

const body = readFileSync(bodyFile, 'utf8').trim() || '- 无详细说明'
const block = [
  `## [${version}] - ${date}`,
  '',
  `### ${section}`,
  '',
  body,
  '',
  '---',
  '',
].join('\n')

if (!existsSync(CHANGELOG_FILE)) {
  writeFileSync(CHANGELOG_FILE, `# Changelog\n\n${block}`)
  console.log(`已创建 ${CHANGELOG_FILE} 并写入 ${version}`)
  process.exit(0)
}

const content = readFileSync(CHANGELOG_FILE, 'utf8')
const index = content.search(/^## \[/m)

if (index === -1) {
  writeFileSync(CHANGELOG_FILE, `${content.trimEnd()}\n\n${block}`)
} else {
  const head = content.slice(0, index).trimEnd()
  writeFileSync(CHANGELOG_FILE, `${head}\n\n${block}\n${content.slice(index)}`)
}

console.log(`已插入版本块 ${version}`)
