/**
 * 更新状态文案（更新页与设置页共用）
 *
 * 只负责把 UpdateState 映射为本地化文案，不读取全局状态，便于传入任意快照。
 */

import type { TranslationKey } from '@/i18n'
import type { UpdateState, UpdateStatus } from '@/lib/update/types'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/** 本次展示的目标版本：优先最新版本，其次待更新指针（ready / error 时仍可展示） */
export function getUpdateTargetVersion(state: UpdateState): string {
  if (state.info) return state.info.latestVersion
  return state.status === 'ready' || state.status === 'error' ? state.pendingVersion : ''
}

function getStatusLabelKey(status: UpdateStatus): TranslationKey {
  switch (status) {
    case 'checking':
      return 'update.checking'
    case 'latest':
      return 'update.none'
    case 'available':
      return 'update.statusAvailable'
    case 'downloading':
      return 'update.statusDownloading'
    case 'ready':
      return 'update.statusReady'
    default:
      return 'update.statusIdle'
  }
}

/** 状态说明；error 状态返回空字符串，由 getUpdateErrorText 负责 */
export function getUpdateStatusText(state: UpdateState, t: Translate): string {
  if (state.status === 'error') return ''
  const targetVersion = getUpdateTargetVersion(state)
  return t(getStatusLabelKey(state.status), {
    version: state.status === 'ready' ? state.pendingVersion || targetVersion : targetVersion,
  })
}

/** 错误说明：按 errorKind 区分检查失败 / 下载失败 / 启动回退 */
export function getUpdateErrorText(state: UpdateState, t: Translate): string {
  if (state.errorKind === 'bootstrap') {
    return t('update.fallbackError', {
      version: state.runtime.attemptedVersion || state.pendingVersion,
    })
  }
  if (state.errorKind === 'check') {
    return t('update.checkFailed', { error: state.error || t('common.unknown') })
  }
  if (state.errorKind === 'download') {
    return t('update.downloadFailed', { error: state.error || t('common.unknown') })
  }
  return ''
}
