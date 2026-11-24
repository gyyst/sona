/**
 * GitHub Releases 查询
 *
 * - 直连 GitHub API 优先（API 本身带 CORS），失败时回退 corsproxy.io
 * - 单版本接口失败后回退 releases 列表
 * - 只接受正式版本：tag 合法、非 prerelease、非 draft
 */

import { normalizeVersion, RELEASE_TAG_PATTERN, VERSION_PATTERN } from '@/lib/update/version'

export interface ReleaseInfo {
  /** 原始 tag，如 v1.13.1 */
  tag: string
  /** 去 v 前缀的版本，如 1.13.1 */
  version: string
  name: string
  htmlUrl: string
  body: string
  publishedAt: string
}

const RELEASE_PAGE_URL = 'https://github.com/gyyst/sona/releases'
const GITHUB_API_LATEST = 'https://api.github.com/repos/gyyst/sona/releases/latest'
const GITHUB_API_RELEASES = 'https://api.github.com/repos/gyyst/sona/releases'
const REQUEST_TIMEOUT_MS = 15000

interface ReleaseCandidate {
  url: string
  kind: 'single' | 'array'
}

function wrapCorsProxy(targetUrl: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
}

function getReleaseCandidates(): ReleaseCandidate[] {
  return [
    { url: GITHUB_API_LATEST, kind: 'single' },
    { url: wrapCorsProxy(GITHUB_API_LATEST), kind: 'single' },
    { url: GITHUB_API_RELEASES, kind: 'array' },
    { url: wrapCorsProxy(GITHUB_API_RELEASES), kind: 'array' },
  ]
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('请求超时')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function isReleasePageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/gyyst/sona/')
  } catch {
    return false
  }
}

/** 把 GitHub API 的原始响应规范化为可信的 ReleaseInfo；不可用时返回 null */
function normalizeRelease(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (data.draft === true || data.prerelease === true) return null

  const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : ''
  const version = normalizeVersion(tag)
  if (!RELEASE_TAG_PATTERN.test(tag) || !VERSION_PATTERN.test(version)) return null

  const htmlUrl = typeof data.html_url === 'string' && isReleasePageUrl(data.html_url)
    ? data.html_url
    : RELEASE_PAGE_URL
  return {
    tag,
    version,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : `Sona v${version}`,
    htmlUrl,
    body: typeof data.body === 'string' ? data.body : '',
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
  }
}

function pickFromCandidate(parsed: unknown, kind: 'single' | 'array'): unknown {
  if (kind === 'single') return parsed
  if (!Array.isArray(parsed)) return null
  for (const item of parsed) {
    if (normalizeRelease(item)) return item
  }
  return null
}

export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  const errors: string[] = []

  for (const candidate of getReleaseCandidates()) {
    try {
      const parsed = await fetchJson(candidate.url)
      const release = normalizeRelease(pickFromCandidate(parsed, candidate.kind))
      if (!release) {
        errors.push(`${candidate.url} -> 无可用正式版本`)
        continue
      }
      return release
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${candidate.url} -> ${message}`)
    }
  }

  throw new Error(errors.join(' | ') || '无法获取 Release 信息')
}

export function getReleasePageUrl(): string {
  return RELEASE_PAGE_URL
}
