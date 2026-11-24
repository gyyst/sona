/** 版本号规范化与比较（与冻结引导器保持同一套语义） */

/** 不带 v 前缀的版本号，如 1.13.1 / 2026.11.24.1 / 1.13.1-beta.1 */
export const VERSION_PATTERN = /^\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/

/** Release 标签，如 v1.13.1 / v2026.11.24.1 */
export const RELEASE_TAG_PATTERN = /^v\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

export function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(normalizeVersion(version))
}

/** 生成发布标签：1.13.1 → v1.13.1；2026.11.24.1 → v2026.11.24.1 */
export function toReleaseTag(version: string): string {
  return `v${normalizeVersion(version)}`
}

/**
 * 比较两个版本号。
 * 返回 >0 表示 a 更新，<0 表示 b 更新，0 表示相同。
 */
export function compareVersion(a: string, b: string): number {
  const left = normalizeVersion(a).split(/[.-]/)
  const right = normalizeVersion(b).split(/[.-]/)
  const length = Math.max(left.length, right.length)

  for (let index = 0; index < length; index += 1) {
    const leftNumber = Number.parseInt(left[index] ?? '0', 10) || 0
    const rightNumber = Number.parseInt(right[index] ?? '0', 10) || 0
    if (leftNumber !== rightNumber) return leftNumber - rightNumber
  }

  return 0
}
