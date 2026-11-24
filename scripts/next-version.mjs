#!/usr/bin/env node
/**
 * 计算下一个发布版本号：年.月.日.序号
 *
 * 规则：
 * - 日期按北京时间（Asia/Shanghai）取当天
 * - 序号为同一天内已有 tag 的最大序号 + 1，从 1 开始
 * - 结果写入 stdout，由调用方决定如何消费
 *
 * 使用 .mjs 而非 .ts，是为了让 CI 在未安装依赖时也能直接运行。
 */

import { execFileSync } from 'node:child_process'

const TIME_ZONE = 'Asia/Shanghai'

function getToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}.${pick('month')}.${pick('day')}`
}

function listTags() {
  const output = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

const today = getToday()
const prefix = `v${today}.`
let serial = 0

for (const tag of listTags()) {
  if (!tag.startsWith(prefix)) continue
  const suffix = tag.slice(prefix.length)
  if (!/^\d+$/.test(suffix)) continue
  const value = Number.parseInt(suffix, 10)
  if (Number.isSafeInteger(value) && value > serial) serial = value
}

const version = `${today}.${serial + 1}`
process.stdout.write(`${version}\n`)
