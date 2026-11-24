/**
 * 自动更新持久化
 *
 * 冻结契约：
 * - DataStore: sona:updatePointer → SonaUpdatePointer
 * - IndexedDB: sona-updates (v1) / bundles (keyPath id) / pending → SonaCachedBundle
 *
 * 所有失败都返回结构化结果，不把异常抛给 UI；引导器只信任通过校验的指针。
 */

import { isTrustedArtifactUrl } from '@/lib/update/types'
import { normalizeVersion, toReleaseTag, VERSION_PATTERN } from '@/lib/update/version'

const POINTER_KEY = 'sona:updatePointer'
const DB_NAME = 'sona-updates'
const DB_VERSION = 1
const BUNDLE_STORE = 'bundles'
const BUNDLE_ID = 'pending'
const IDB_TIMEOUT_MS = 3000
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export interface ClearPendingResult {
  pointerCleared: boolean
  cacheCleared: boolean
}

/** 校验从 DataStore 读到的任意值，损坏或非法时返回 null */
export function normalizeUpdatePointer(value: unknown): SonaUpdatePointer | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const version = typeof raw.version === 'string' ? normalizeVersion(raw.version) : ''
  const tag = typeof raw.tag === 'string' ? raw.tag.trim() : ''
  const appUrl = typeof raw.appUrl === 'string' ? raw.appUrl : ''
  const cssUrl = typeof raw.cssUrl === 'string' ? raw.cssUrl : ''
  const appSha256 = typeof raw.appSha256 === 'string' ? raw.appSha256.toLowerCase() : ''
  const cssSha256 = typeof raw.cssSha256 === 'string' ? raw.cssSha256.toLowerCase() : ''

  if (!VERSION_PATTERN.test(version)) return null
  if (tag !== toReleaseTag(version)) return null
  if (!isTrustedArtifactUrl(appUrl, 'app.js') || !isTrustedArtifactUrl(cssUrl, 'app.css')) return null
  if (!SHA256_PATTERN.test(appSha256) || !SHA256_PATTERN.test(cssSha256)) return null

  const savedAt = typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0
  return { version, tag, appUrl, cssUrl, appSha256, cssSha256, savedAt }
}

export function readUpdatePointer(): SonaUpdatePointer | null {
  if (typeof DataStore === 'undefined') return null
  let raw: unknown
  try {
    raw = DataStore.get(POINTER_KEY)
  } catch {
    return null
  }
  if (raw === undefined || raw === null) return null

  const pointer = normalizeUpdatePointer(raw)
  if (!pointer) {
    // 与冻结引导器保持一致：无效指针同时清理 IndexedDB 中的陈旧缓存
    clearUpdatePointer()
    void deleteCachedBundle()
    return null
  }
  return pointer
}

export function saveUpdatePointer(pointer: SonaUpdatePointer): boolean {
  if (typeof DataStore === 'undefined') return false
  const normalized = normalizeUpdatePointer(pointer)
  if (!normalized) return false
  try {
    return DataStore.set(POINTER_KEY, normalized) !== false
  } catch {
    return false
  }
}

export function clearUpdatePointer(): boolean {
  if (typeof DataStore === 'undefined') return false
  try {
    return DataStore.remove(POINTER_KEY) !== false
  } catch {
    return false
  }
}

function isCachedBundle(value: unknown, version?: string): value is SonaCachedBundle {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SonaCachedBundle>
  if (record.id !== BUNDLE_ID) return false
  if (typeof record.version !== 'string' || !VERSION_PATTERN.test(record.version)) return false
  if (version && record.version !== version) return false
  if (typeof record.appSource !== 'string' || typeof record.cssSource !== 'string') return false
  return typeof record.savedAt === 'number' && Number.isFinite(record.savedAt)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB 不可用'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BUNDLE_STORE)) {
        db.createObjectStore(BUNDLE_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB 打开失败'))
    request.onblocked = () => reject(new Error('indexedDB 被其他页面占用'))
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs)
  })
  return Promise.race([promise, timeout])
}

/** 读取缓存包；不存在、损坏或超时都返回 null */
export async function readCachedBundle(version?: string): Promise<SonaCachedBundle | null> {
  try {
    const record = await withTimeout((async () => {
      const db = await openDatabase()
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction(BUNDLE_STORE, 'readonly').objectStore(BUNDLE_STORE).get(BUNDLE_ID)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error ?? new Error('缓存读取失败'))
        })
      } finally {
        db.close()
      }
    })(), IDB_TIMEOUT_MS, '缓存读取')

    return isCachedBundle(record, version) ? record : null
  } catch {
    return null
  }
}

/** 写入缓存包；失败时返回 false，调用方仍可写指针并依赖远程 URL */
export async function saveCachedBundle(version: string, appSource: string, cssSource: string): Promise<boolean> {
  const record: SonaCachedBundle = {
    id: BUNDLE_ID,
    version: normalizeVersion(version),
    appSource,
    cssSource,
    savedAt: Date.now(),
  }
  try {
    await withTimeout((async () => {
      const db = await openDatabase()
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(BUNDLE_STORE, 'readwrite')
          transaction.objectStore(BUNDLE_STORE).put(record)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('缓存写入失败'))
          transaction.onabort = () => reject(transaction.error ?? new Error('缓存写入事务中止'))
        })
      } finally {
        db.close()
      }
    })(), IDB_TIMEOUT_MS, '缓存写入')
    return true
  } catch {
    return false
  }
}

export async function deleteCachedBundle(): Promise<boolean> {
  try {
    await withTimeout((async () => {
      const db = await openDatabase()
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(BUNDLE_STORE, 'readwrite')
          transaction.objectStore(BUNDLE_STORE).delete(BUNDLE_ID)
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('缓存删除失败'))
          transaction.onabort = () => reject(transaction.error ?? new Error('缓存删除事务中止'))
        })
      } finally {
        db.close()
      }
    })(), IDB_TIMEOUT_MS, '缓存清理')
    return true
  } catch {
    return false
  }
}

/** 清除待更新指针与 IndexedDB 缓存（跳过版本 / 恢复本地 / 陈旧指针清理） */
export async function clearPendingUpdate(): Promise<ClearPendingResult> {
  const pointerCleared = clearUpdatePointer()
  const cacheCleared = await deleteCachedBundle()
  return { pointerCleared, cacheCleared }
}
