/**
 * 自动更新状态机
 * idle → checking → latest | available | error；available → downloading → ready | error
 * 自动检查受 autoUpdateMode 与 Pengu.autoUpdateCheck 门控；启动回退本地后不自动重下同一版本。
 * 下载校验通过后先写 IndexedDB，再写 DataStore 指针；失败绝不写指针。
 */

import { logger } from '@/index'
import { normalizeAutoUpdateMode, store } from '@/lib/store'
import { markVersionNotified, notifyUpdateAvailable, notifyUpdateReady, resetUpdateNotifications } from '@/lib/update/update-notifier'
import { fetchLatestRelease, type ReleaseInfo } from '@/lib/update/release-api'
import { downloadUpdateBundle } from '@/lib/update/update-downloader'
import { getRuntimeInfo, isRuntimeFallback } from '@/lib/update/update-runtime'
import {
  clearPendingUpdate, deleteCachedBundle, readCachedBundle,
  readUpdatePointer, saveCachedBundle, saveUpdatePointer,
} from '@/lib/update/update-store'
import type { UpdateInfo, UpdateState } from '@/lib/update/types'
import { compareVersion, normalizeVersion } from '@/lib/update/version'

export { getReleasePageUrl } from '@/lib/update/release-api'
export { isUpdateAttentionRequired, isUpdateFlowActive } from '@/lib/update/types'
export type { UpdateInfo, UpdateState, UpdateStatus } from '@/lib/update/types'

let state: UpdateState | null = null
let autoDownloadBlockedVersion = ''
let cancelledVersion = ''
let checkInFlight: Promise<UpdateState> | null = null
let downloadInFlight: Promise<UpdateState> | null = null
const listeners = new Set<(state: UpdateState) => void>()

/** 惰性初始化：引导器在 import app.js 之后、调用 init 之前才写入 __SONA_BOOTSTRAP__ */
function createInitialState(): UpdateState {
  const runtime = getRuntimeInfo()
  const pointer = readUpdatePointer()
  const stalePointer = Boolean(pointer)
    && runtime.source === 'local'
    && compareVersion(runtime.localVersion, pointer!.version) >= 0

  if (stalePointer) {
    logger.info('[Update] 本地版本已追平，清理陈旧待更新指针')
    void clearPendingUpdate()
  }

  const fallback = isRuntimeFallback(runtime)
  autoDownloadBlockedVersion = fallback ? (pointer?.version ?? runtime.attemptedVersion) : ''
  return {
    status: fallback ? 'error' : 'idle',
    info: null,
    error: fallback ? runtime.error : '',
    errorKind: fallback ? 'bootstrap' : 'none',
    runtime,
    pendingVersion: pointer && !stalePointer ? pointer.version : '',
    cached: false,
  }
}

function getState(): UpdateState {
  if (!state) state = createInitialState()
  return state
}

function emit() {
  const snapshot = getUpdateState()
  listeners.forEach((listener) => listener(snapshot))
}

function setState(next: UpdateState): UpdateState {
  state = next
  emit()
  return getUpdateState()
}

export function getUpdateState(): UpdateState {
  const current = getState()
  return {
    ...current,
    info: current.info ? { ...current.info } : null,
    runtime: { ...current.runtime },
  }
}

export function onUpdateStateChange(listener: (state: UpdateState) => void): () => void {
  listeners.add(listener)
  listener(getUpdateState())
  return () => {
    listeners.delete(listener)
  }
}

function getSkippedUpdateVersion(): string {
  const stored = store.get('skippedUpdateVersion')
  return typeof stored === 'string' ? normalizeVersion(stored) : ''
}

function isPenguAutoUpdateDisabled(): boolean {
  try {
    return typeof Pengu !== 'undefined' && Pengu.autoUpdateCheck === false
  } catch {
    return false
  }
}

/** 自动检查：受 Sona 设置与 Pengu 自动检查开关共同门控 */
export function maybeAutoCheckForUpdates(): void {
  try {
    if (normalizeAutoUpdateMode(store.get('autoUpdateMode')) === 'off') {
      logger.info('[Update] 自动更新已关闭，跳过自动检查')
      return
    }
    if (isPenguAutoUpdateDisabled()) {
      logger.info('[Update] Pengu 已关闭插件自动检查，跳过自动检查')
      return
    }
    void checkForUpdates()
  } catch (error) {
    logger.warn('[Update] 启动自动检查更新失败:', error)
  }
}

/** 手动检查更新（不受自动更新开关限制） */
export function checkForUpdates(): Promise<UpdateState> {
  const current = getState()
  if (current.status === 'downloading') {
    return downloadInFlight ?? Promise.resolve(getUpdateState())
  }
  if (checkInFlight) return checkInFlight

  checkInFlight = runCheck().finally(() => { checkInFlight = null })
  return checkInFlight
}

async function runCheck(): Promise<UpdateState> {
  const previous = getState()
  setState({ ...previous, status: 'checking', error: '', errorKind: 'none' })

  try {
    return await applyRelease(await fetchLatestRelease())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('[Update] 检查更新失败:', error)
    const base = getState()
    const keepBootstrap = previous.errorKind === 'bootstrap'
    return setState({
      ...base,
      status: previous.status === 'ready' ? 'ready' : 'error',
      error: keepBootstrap ? previous.error : message,
      errorKind: keepBootstrap ? 'bootstrap' : 'check',
    })
  }
}

async function applyRelease(release: ReleaseInfo): Promise<UpdateState> {
  const base = getState()
  const runningVersion = base.runtime.runningVersion
  let skippedVersion = getSkippedUpdateVersion()
  if (skippedVersion && compareVersion(runningVersion, skippedVersion) >= 0) {
    store.set('skippedUpdateVersion', null)
    skippedVersion = ''
  }

  if (compareVersion(release.version, runningVersion) <= 0) {
    return setState({ ...base, status: 'latest', info: null, error: '', errorKind: 'none', cached: false })
  }

  if (release.version === skippedVersion) {
    logger.info('[Update] 已跳过版本 %s，本次不再提示', release.version)
    return setState({ ...base, status: 'latest', info: null, error: '', errorKind: 'none', cached: false })
  }

  const info: UpdateInfo = {
    currentVersion: runningVersion,
    latestVersion: release.version,
    releaseName: release.name,
    releaseUrl: release.htmlUrl,
    releaseBody: release.body,
    publishedAt: release.publishedAt,
  }

  // 指针已指向该版本：不重复下载，等待重启（或提示加载失败）
  if (base.pendingVersion === release.version) {
    if (autoDownloadBlockedVersion === release.version) {
      return setState({
        ...base, status: 'error', info, error: base.runtime.error, errorKind: 'bootstrap', cached: false,
      })
    }
    const cached = Boolean(await readCachedBundle(release.version))
    const next = setState({
      ...base, status: 'ready', info, error: '', errorKind: 'none', cached,
    })
    notifyUpdateReady(release.version)
    return next
  }

  const next = setState({ ...base, status: 'available', info, error: '', errorKind: 'none', cached: false })
  logger.info('[Update] 检测到新版本: %s -> %s', runningVersion, release.version)
  const mode = normalizeAutoUpdateMode(store.get('autoUpdateMode'))
  if (mode === 'notify') notifyUpdateAvailable(info)
  else if (mode === 'auto' && !isPenguAutoUpdateDisabled() && autoDownloadBlockedVersion !== release.version) void startDownload(release.version, info)
  return next
}

function startDownload(version: string, info: UpdateInfo): Promise<UpdateState> {
  if (downloadInFlight) return downloadInFlight
  downloadInFlight = runDownload(version, info).finally(() => { downloadInFlight = null })
  return downloadInFlight
}

async function runDownload(version: string, info: UpdateInfo): Promise<UpdateState> {
  setState({ ...getState(), status: 'downloading', info, error: '', errorKind: 'none' })
  logger.info('[Update] 开始下载 v%s', version)

  const cancelled = () => cancelledVersion === version || getSkippedUpdateVersion() === version
  try {
    const prepared = await downloadUpdateBundle(version)
    if (cancelled()) {
      logger.info('[Update] v%s 下载完成但已被跳过，丢弃本次更新', version)
      return getUpdateState()
    }

    const cached = await saveCachedBundle(version, prepared.appSource, prepared.cssSource)
    // 写缓存是异步的：期间用户仍可能“跳过此版本”，必须在写指针前再确认一次
    if (cancelled()) {
      if (cached) await deleteCachedBundle()
      logger.info('[Update] v%s 下载完成但已被跳过，丢弃本次更新', version)
      return getUpdateState()
    }
    if (!cached) logger.warn('[Update] 未能写入 IndexedDB，重启后将依赖远程 URL 加载')
    if (!saveUpdatePointer(prepared.pointer)) {
      if (cached) await deleteCachedBundle()
      throw new Error('无法写入更新指针（DataStore 不可用）')
    }

    autoDownloadBlockedVersion = ''
    const next = setState({
      ...getState(), status: 'ready', info, error: '', errorKind: 'none', pendingVersion: version, cached,
    })
    logger.info('[Update] v%s 已下载并通过校验，等待重启生效', version)
    notifyUpdateReady(version)
    return next
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('[Update] 下载更新失败:', error)
    return setState({ ...getState(), status: 'error', info, error: message, errorKind: 'download' })
  }
}

/** 用户主动更新：必要时先检查，再强制下载（忽略启动回退抑制） */
export async function downloadUpdate(): Promise<UpdateState> {
  if (downloadInFlight) return downloadInFlight
  if (!getState().info) {
    await checkForUpdates()
    if (downloadInFlight) return downloadInFlight
    if (!getState().info) return getUpdateState()
  }

  const info = getState().info
  if (!info) return getUpdateState()
  autoDownloadBlockedVersion = ''
  cancelledVersion = ''
  return startDownload(info.latestVersion, info)
}

export function skipUpdateVersion(version: string): UpdateState {
  const normalized = normalizeVersion(version)
  if (!normalized) return getUpdateState()

  const current = getState()
  store.set('skippedUpdateVersion', normalized)
  markVersionNotified(normalized)
  autoDownloadBlockedVersion = normalized
  cancelledVersion = normalized

  const hasPending = current.pendingVersion === normalized
  if (hasPending) {
    void clearPendingUpdate().then((result) => {
      logger.info('[Update] 已跳过 v%s，清理待更新数据: 指针=%s 缓存=%s',
        normalized, String(result.pointerCleared), String(result.cacheCleared))
    })
  }

  if (current.info?.latestVersion === normalized || hasPending) {
    logger.info('[Update] 跳过版本更新提醒: %s', normalized)
    return setState({
      ...current, status: 'latest', info: null, error: '', errorKind: 'none', pendingVersion: '', cached: false,
    })
  }

  emit()
  logger.info('[Update] 跳过版本更新提醒: %s', normalized)
  return getUpdateState()
}

export function clearSkippedUpdateVersion(): void {
  store.set('skippedUpdateVersion', null)
  resetUpdateNotifications()
  autoDownloadBlockedVersion = ''
  cancelledVersion = ''
}
