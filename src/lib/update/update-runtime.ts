/**
 * 运行时信息与客户端操作
 *
 * 引导器在调用 app.init 前写入 window.__SONA_BOOTSTRAP__；
 * 业务代码必须在初始化后（而不是模块顶层）读取它。
 */

declare const __PLUGIN_VERSION__: string

import { logger } from '@/index'
import type { UpdateRuntimeInfo } from '@/lib/update/types'
import { clearPendingUpdate } from '@/lib/update/update-store'
import { compareVersion, normalizeVersion, VERSION_PATTERN } from '@/lib/update/version'

/** 读取本次运行信息；开发模式（无引导器）按本地版本处理 */
export function getRuntimeInfo(): UpdateRuntimeInfo {
  const pluginVersion = normalizeVersion(__PLUGIN_VERSION__)
  const bootstrap = typeof window === 'undefined' ? undefined : window.__SONA_BOOTSTRAP__
  if (!bootstrap) {
    return {
      source: 'local',
      runningVersion: pluginVersion,
      localVersion: pluginVersion,
      attemptedVersion: '',
      error: '',
    }
  }

  const runningVersion = normalizeVersion(bootstrap.runningVersion)
  const localVersion = normalizeVersion(bootstrap.localVersion)
  const attemptedVersion = bootstrap.attemptedVersion ? normalizeVersion(bootstrap.attemptedVersion) : ''
  return {
    source: bootstrap.source,
    runningVersion: VERSION_PATTERN.test(runningVersion) ? runningVersion : pluginVersion,
    localVersion: VERSION_PATTERN.test(localVersion) ? localVersion : '0.0.0',
    attemptedVersion: VERSION_PATTERN.test(attemptedVersion) ? attemptedVersion : '',
    error: bootstrap.error ?? '',
  }
}

/** 引导器尝试加载待更新版本但回退到本地 */
export function isRuntimeFallback(info: UpdateRuntimeInfo): boolean {
  return info.source === 'local'
    && Boolean(info.attemptedVersion)
    && compareVersion(info.attemptedVersion, info.localVersion) > 0
}

/** 重载客户端；用于应用已下载的更新 */
export function reloadClient(): void {
  try {
    if (typeof window.reloadClient === 'function') {
      window.reloadClient()
      return
    }
  } catch (error) {
    logger.warn('[Update] reloadClient 调用失败，尝试页面刷新:', error)
  }

  try {
    window.location.reload()
  } catch (error) {
    logger.error('[Update] 无法重载客户端，请手动重启:', error)
  }
}

/** 恢复本地版本：清除待更新指针与 IndexedDB 缓存，然后重载客户端 */
export async function restoreLocalVersion(): Promise<void> {
  logger.info('[Update] 恢复本地版本：清除待更新指针与缓存')
  const result = await clearPendingUpdate()
  if (!result.pointerCleared || !result.cacheCleared) {
    logger.warn('[Update] 清理待更新数据不完整: 指针=%s 缓存=%s', String(result.pointerCleared), String(result.cacheCleared))
  }
  reloadClient()
}
