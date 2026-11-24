/**
 * 更新包下载与校验
 *
 * 发布源固定为 gyyst/sona 的 dist-v<version> 标签：
 * - 主源：jsDelivr（CORS、immutable 缓存）
 * - 备源：raw.githubusercontent.com
 *
 * 下载内容只做校验和缓存，绝不在当前进程执行；下次启动由引导器以 ESM 模块加载。
 */

import type { PreparedUpdate, UpdateManifest, UpdateManifestFile } from '@/lib/update/types'
import { UPDATE_REPO } from '@/lib/update/types'
import { normalizeVersion, RELEASE_TAG_PATTERN, toReleaseTag, VERSION_PATTERN } from '@/lib/update/version'

const REQUEST_TIMEOUT_MS = 30000
const MAX_ARTIFACT_SIZE = 8 * 1024 * 1024
const MAX_MANIFEST_SIZE = 64 * 1024
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ARTIFACT_FILES = ['app.js', 'app.css'] as const
type ArtifactName = (typeof ARTIFACT_FILES)[number]

interface ManifestSource {
  manifest: UpdateManifest
  baseUrl: string
}

interface DownloadedArtifact {
  url: string
  text: string
}

/** 版本对应的发布产物基址列表（顺序即回退顺序） */
export function getReleaseSources(version: string): string[] {
  const tag = toReleaseTag(version)
  if (!RELEASE_TAG_PATTERN.test(tag)) throw new Error(`非法版本号：${version}`)
  const artifactRef = `dist-${tag}`
  return [
    `https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@${artifactRef}`,
    `https://raw.githubusercontent.com/${UPDATE_REPO}/${artifactRef}`,
  ]
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fetchBuffer(url: string, maxSize: number): Promise<ArrayBuffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    // 产物 URL 带 dist-v<version>（不可变），允许浏览器复用 HTTP 缓存，
    // 引导器的远程兜底与手动重试都能受益；易变的 GitHub API 请求在 release-api.ts 中单独禁用缓存。
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > maxSize) {
      throw new Error(`文件超过大小上限（${maxSize} 字节）`)
    }

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxSize) throw new Error(`文件超过大小上限（${maxSize} 字节）`)
    return buffer
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('请求超时')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function decodeUtf8(buffer: ArrayBuffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new Error(`${label} 不是有效的 UTF-8 文本`)
  }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) throw new Error('当前环境不支持 SHA-256 校验')
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function normalizeManifestFile(value: unknown, fileName: string): UpdateManifestFile {
  if (!value || typeof value !== 'object') throw new Error(`清单缺少 ${fileName} 条目`)
  const raw = value as Record<string, unknown>
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : ''
  const size = raw.size
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`清单中 ${fileName} 的 sha256 非法`)
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_ARTIFACT_SIZE) {
    throw new Error(`清单中 ${fileName} 的 size 非法或超过 8 MB`)
  }
  return { sha256, size }
}

/** 校验 update.json 的字段、版本号与文件集合 */
export function validateUpdateManifest(raw: unknown, expectedVersion: string): UpdateManifest {
  const version = normalizeVersion(expectedVersion)
  if (!VERSION_PATTERN.test(version)) throw new Error(`非法目标版本：${expectedVersion}`)
  if (!raw || typeof raw !== 'object') throw new Error('更新清单不是对象')

  const data = raw as Record<string, unknown>
  const manifestVersion = typeof data.version === 'string' ? normalizeVersion(data.version) : ''
  if (manifestVersion !== version) {
    throw new Error(`更新清单版本 ${manifestVersion || '(缺失)'} 与目标版本 ${version} 不一致`)
  }
  if (!data.files || typeof data.files !== 'object') throw new Error('更新清单缺少 files')

  const files = data.files as Record<string, unknown>
  const keys = Object.keys(files)
  if (keys.length !== ARTIFACT_FILES.length || !ARTIFACT_FILES.every((fileName) => keys.includes(fileName))) {
    throw new Error('更新清单只允许 app.js 与 app.css 两个文件')
  }

  return {
    version,
    files: {
      'app.js': normalizeManifestFile(files['app.js'], 'app.js'),
      'app.css': normalizeManifestFile(files['app.css'], 'app.css'),
    },
  }
}

async function readManifest(sources: string[], version: string): Promise<ManifestSource> {
  const errors: string[] = []
  for (const baseUrl of sources) {
    const url = `${baseUrl}/update.json`
    try {
      const buffer = await fetchBuffer(url, MAX_MANIFEST_SIZE)
      const parsed = JSON.parse(decodeUtf8(buffer, 'update.json')) as unknown
      return { manifest: validateUpdateManifest(parsed, version), baseUrl }
    } catch (error) {
      errors.push(`${url} -> ${describeError(error)}`)
    }
  }
  throw new Error(errors.join(' | ') || '无法下载更新清单')
}

async function fetchArtifact(
  sources: string[],
  fileName: ArtifactName,
  expected: UpdateManifestFile,
): Promise<DownloadedArtifact> {
  const errors: string[] = []
  for (const baseUrl of sources) {
    const url = `${baseUrl}/${fileName}`
    try {
      const buffer = await fetchBuffer(url, MAX_ARTIFACT_SIZE)
      if (buffer.byteLength !== expected.size) {
        throw new Error(`大小不符（期望 ${expected.size}，实际 ${buffer.byteLength}）`)
      }
      if (await sha256Hex(buffer) !== expected.sha256) throw new Error('SHA-256 不匹配')
      return { url, text: decodeUtf8(buffer, fileName) }
    } catch (error) {
      errors.push(`${url} -> ${describeError(error)}`)
    }
  }
  throw new Error(errors.join(' | ') || `无法下载 ${fileName}`)
}

/**
 * 下载并校验指定版本，返回尚未写入存储的更新包。
 * 任一校验失败都会抛错；调用方不得写入指针。
 */
export async function downloadUpdateBundle(version: string): Promise<PreparedUpdate> {
  const targetVersion = normalizeVersion(version)
  if (!VERSION_PATTERN.test(targetVersion)) throw new Error(`非法目标版本：${version}`)

  const sources = getReleaseSources(targetVersion)
  const { manifest, baseUrl } = await readManifest(sources, targetVersion)
  const orderedSources = [baseUrl, ...sources.filter((source) => source !== baseUrl)]

  const [app, css] = await Promise.all([
    fetchArtifact(orderedSources, 'app.js', manifest.files['app.js']),
    fetchArtifact(orderedSources, 'app.css', manifest.files['app.css']),
  ])

  return {
    pointer: {
      version: manifest.version,
      tag: `v${manifest.version}`,
      appUrl: app.url,
      cssUrl: css.url,
      appSha256: manifest.files['app.js'].sha256,
      cssSha256: manifest.files['app.css'].sha256,
      savedAt: Date.now(),
    },
    appSource: app.text,
    cssSource: css.text,
  }
}
