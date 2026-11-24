/** Sona 冻结引导器：本地版本 → IndexedDB → 远程 CDN → 本地 app.js；零运行时 import，契约见 pengu.d.ts。 */
const POINTER_KEY = 'sona:updatePointer'
const DB_NAME = 'sona-updates'
const DB_VERSION = 1
const BUNDLE_STORE = 'bundles'
const BUNDLE_ID = 'pending'
const IDB_TIMEOUT_MS = 1500
const REMOTE_TIMEOUT_MS = 5000
const ALLOWED_HOSTS = new Set(['cdn.jsdelivr.net', 'raw.githubusercontent.com'])
const VERSION_PATTERN = /^\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const BANNER_VERSION_PATTERN = /@version\s+(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/

interface SonaAppModule { init?: (context: PenguContext) => unknown; load?: () => unknown }
interface LocalVersionInfo { version: string; builtAt: number }
type StyleSelection = { kind: 'link'; href: string } | { kind: 'inline'; source: string }
interface Selection { source: SonaBootstrapInfo['source']; version: string; module: SonaAppModule; style: StyleSelection }
let readyPromise: Promise<void> | null = null
let appModule: SonaAppModule | null = null

export function init(context: PenguContext): Promise<void> {
  if (!readyPromise) readyPromise = boot(context)
  return readyPromise
}

export async function load(): Promise<void> {
  if (!readyPromise) return
  try { await readyPromise } catch (error) { warn('应用初始化失败，跳过 load', error); return }
  try { await appModule?.load?.() } catch (error) { warn('app.load 执行失败', error) }
}

async function boot(context: PenguContext): Promise<void> {
  const baseUrl = installPluginBaseUrl()
  const localVersion = await readLocalVersion(baseUrl)
  const pointer = readPointer()
  let selection: Selection | null = null
  let fallbackError = ''
  let triedPointer = false

  if (pointer && compareVersion(pointer.version, localVersion.version) > 0) {
    triedPointer = true
    selection = await loadFromCache(pointer)
    if (!selection) {
      fallbackError = '缓存包加载失败，尝试远程加载'
      selection = await loadFromRemote(pointer)
      if (!selection) fallbackError = '缓存包与远程包均加载失败，已回退本地版本'
    }
  }

  if (!selection) {
    try {
      selection = await loadLocal(baseUrl, localVersion)
    } catch (localError) {
      warn('本地 app.js 加载失败', localError)
      if (pointer && !triedPointer) {
        selection = await loadFromRemote(pointer)
        if (selection) fallbackError = ''
      }
      if (!selection) throw localError
    }
  }

  // 手动安装的本地版本已追平/超过待更新版本：清理陈旧指针与缓存
  if (selection.source === 'local' && pointer && compareVersion(localVersion.version, pointer.version) >= 0) {
    await clearPending()
  }

  appModule = selection.module
  const info: SonaBootstrapInfo = {
    source: selection.source, runningVersion: selection.version, localVersion: localVersion.version,
  }
  if (pointer && (triedPointer || selection.source !== 'local')) info.attemptedVersion = pointer.version
  if (fallbackError && selection.source === 'local') info.error = fallbackError
  window.__SONA_BOOTSTRAP__ = info
  if (fallbackError) warn(fallbackError)
  try { injectStyle(selection.style) } catch (error) { warn('注入应用样式失败', error) }
  await selection.module.init?.(context)
}

function installPluginBaseUrl(): string {
  let baseUrl = '//plugins/sona/'
  try {
    const url = new URL(import.meta.url)
    url.search = ''
    url.hash = ''
    const lastSlash = url.pathname.lastIndexOf('/')
    url.pathname = lastSlash >= 0 ? url.pathname.slice(0, lastSlash + 1) : '/'
    baseUrl = url.href
  } catch (error) {
    warn('解析插件基址失败，使用默认值', error)
  }
  try { window.__SONA_PLUGIN_BASE_URL__ = baseUrl } catch (error) { warn('写入 __SONA_PLUGIN_BASE_URL__ 失败', error) }
  return baseUrl
}

async function readLocalVersion(baseUrl: string): Promise<LocalVersionInfo> {
  try {
    const response = await fetch(`${baseUrl}version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (response.ok) {
      const data = (await response.json()) as Partial<LocalVersionInfo>
      const version = typeof data.version === 'string' ? normalizeVersion(data.version) : ''
      if (VERSION_PATTERN.test(version)) {
        const builtAt = typeof data.builtAt === 'number' && Number.isFinite(data.builtAt) ? data.builtAt : 0
        return { version, builtAt }
      }
    }
  } catch (error) { warn('version.json 读取失败，尝试 app.js banner', error) }
  return { version: (await readBannerVersion(`${baseUrl}app.js`)) ?? '0.0.0', builtAt: 0 }
}

async function readBannerVersion(appUrl: string): Promise<string | null> {
  try {
    // 优先 Range 只读前 2 KB；Pengu 资源处理器可能忽略 Range，此时响应本身就是全文
    const response = await fetch(appUrl, { cache: 'no-store', headers: { Range: 'bytes=0-2047' } })
    if (!response.ok && response.status !== 206) return null
    const match = (await response.text()).match(BANNER_VERSION_PATTERN)
    if (match?.[1]) return match[1]
    if (response.status !== 206) return null
    const full = await fetch(appUrl, { cache: 'no-store' })
    return full.ok ? (await full.text()).match(BANNER_VERSION_PATTERN)?.[1] ?? null : null
  } catch (error) { warn('app.js banner 版本读取失败', error); return null }
}

function readPointer(): SonaUpdatePointer | null {
  if (typeof DataStore === 'undefined') return null
  let raw: unknown
  try { raw = DataStore.get(POINTER_KEY) } catch (error) { warn('读取待更新指针失败', error); return null }
  if (raw === undefined || raw === null) return null
  const pointer = normalizePointer(raw)
  if (pointer) return pointer
  clearPointer()
  void deleteCachedBundle().catch((error) => warn('清理无效缓存失败', error))
  warn('待更新指针无效，已清理')
  return null
}

function normalizePointer(value: unknown): SonaUpdatePointer | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const version = typeof raw.version === 'string' ? normalizeVersion(raw.version) : ''
  const tag = typeof raw.tag === 'string' ? raw.tag.trim() : ''
  const appUrl = typeof raw.appUrl === 'string' ? raw.appUrl : ''
  const cssUrl = typeof raw.cssUrl === 'string' ? raw.cssUrl : ''
  const appSha256 = typeof raw.appSha256 === 'string' ? raw.appSha256.toLowerCase() : ''
  const cssSha256 = typeof raw.cssSha256 === 'string' ? raw.cssSha256.toLowerCase() : ''
  if (!VERSION_PATTERN.test(version) || tag !== `v${version}`) return null
  if (!isTrustedArtifactUrl(appUrl, 'app.js') || !isTrustedArtifactUrl(cssUrl, 'app.css')) return null
  if (!SHA256_PATTERN.test(appSha256) || !SHA256_PATTERN.test(cssSha256)) return null
  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0
  return { version, tag, appUrl, cssUrl, appSha256, cssSha256, savedAt }
}

function isTrustedArtifactUrl(value: string, fileName: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname) && url.pathname.endsWith(`/${fileName}`)
  } catch { return false }
}

function clearPointer() {
  try { DataStore.remove(POINTER_KEY) } catch (error) { warn('清除待更新指针失败', error) }
}

async function clearPending(): Promise<void> {
  clearPointer()
  try { await withTimeout(deleteCachedBundle(), IDB_TIMEOUT_MS, '缓存清理') } catch (error) { warn('清理 IndexedDB 缓存失败', error) }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB 不可用'))
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BUNDLE_STORE)) db.createObjectStore(BUNDLE_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB 打开失败'))
    request.onblocked = () => reject(new Error('indexedDB 被其他页面占用'))
  })
}

async function readCachedBundle(version: string): Promise<SonaCachedBundle | null> {
  const db = await openDatabase()
  try {
    const record = await new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(BUNDLE_STORE, 'readonly').objectStore(BUNDLE_STORE).get(BUNDLE_ID)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('缓存读取失败'))
    })
    if (!record || typeof record !== 'object') return null
    const bundle = record as Partial<SonaCachedBundle>
    if (bundle.id !== BUNDLE_ID || bundle.version !== version) return null
    if (typeof bundle.appSource !== 'string' || typeof bundle.cssSource !== 'string') return null
    return bundle as SonaCachedBundle
  } finally { db.close() }
}

async function deleteCachedBundle(): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(BUNDLE_STORE, 'readwrite')
      transaction.objectStore(BUNDLE_STORE).delete(BUNDLE_ID)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('缓存删除失败'))
      transaction.onabort = () => reject(transaction.error ?? new Error('缓存删除事务中止'))
    })
  } finally { db.close() }
}

async function loadFromCache(pointer: SonaUpdatePointer): Promise<Selection | null> {
  try {
    const bundle = await withTimeout(readCachedBundle(pointer.version), IDB_TIMEOUT_MS, '缓存读取')
    if (!bundle) return null
    const module = await importFromSource(bundle.appSource)
    if (!isAppModule(module)) return null
    return { source: 'cache', version: bundle.version, module, style: { kind: 'inline', source: bundle.cssSource } }
  } catch (error) { warn('IndexedDB 缓存加载失败', error); return null }
}

async function loadFromRemote(pointer: SonaUpdatePointer): Promise<Selection | null> {
  try {
    const module = await withTimeout(importFromUrl(pointer.appUrl), REMOTE_TIMEOUT_MS, '远程模块加载')
    if (!isAppModule(module)) return null
    return { source: 'remote', version: pointer.version, module, style: { kind: 'link', href: pointer.cssUrl } }
  } catch (error) { warn('远程应用包加载失败', error); return null }
}

async function loadLocal(baseUrl: string, localVersion: LocalVersionInfo): Promise<Selection> {
  const module = await importFromUrl(`${baseUrl}app.js`)
  if (!isAppModule(module)) throw new Error('本地 app.js 未导出 init')
  // 必须带构建指纹 query：非 JS 资源被 Pengu 以 immutable 缓存
  const cssUrl = `${baseUrl}app.css?v=${localVersion.version}-${localVersion.builtAt}`
  return { source: 'local', version: localVersion.version, module, style: { kind: 'link', href: cssUrl } }
}

async function importFromUrl(url: string): Promise<SonaAppModule> {
  return (await import(/* @vite-ignore */ url)) as SonaAppModule
}

async function importFromSource(source: string): Promise<SonaAppModule> {
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try { return await importFromUrl(blobUrl) } finally { URL.revokeObjectURL(blobUrl) }
}

function isAppModule(value: unknown): value is SonaAppModule {
  return typeof value === 'object' && value !== null && typeof (value as SonaAppModule).init === 'function'
}

function injectStyle(style: StyleSelection) {
  const apply = () => {
    const host = document.body
    if (!host) return
    if (style.kind === 'inline') {
      const element = document.createElement('style')
      element.dataset.sonaStyle = 'bootstrap-cache'
      element.textContent = style.source
      host.appendChild(element)
      return
    }
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = style.href
    link.dataset.sonaStyle = 'bootstrap'
    host.appendChild(link)
  }
  if (document.body) apply()
  else document.addEventListener('DOMContentLoaded', apply, { once: true })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs)
  })
  return Promise.race([promise, timeout])
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function compareVersion(a: string, b: string): number {
  const left = normalizeVersion(a).split(/[.-]/)
  const right = normalizeVersion(b).split(/[.-]/)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftNumber = Number.parseInt(left[index] ?? '0', 10) || 0
    const rightNumber = Number.parseInt(right[index] ?? '0', 10) || 0
    if (leftNumber !== rightNumber) return leftNumber - rightNumber
  }
  return 0
}

function warn(message: string, error?: unknown) {
  console.warn(`[Sona:Bootstrap] ${message}`, error ?? '')
}
