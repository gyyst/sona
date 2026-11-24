/**
 * 更新通知（LCU 右下角弹窗）
 *
 * 约束：每个版本只提醒一次；失败不弹通知，只在更新页与日志中体现。
 */

import { logger } from '@/index'
import { translate } from '@/i18n'
import { lcu } from '@/lib/lcu'
import type { UpdateInfo } from '@/lib/update/types'

let notifiedVersion = ''
let notifiedReadyVersion = ''

export function notifyUpdateAvailable(info: UpdateInfo): void {
  if (notifiedVersion === info.latestVersion) return
  notifiedVersion = info.latestVersion

  void lcu.sendNotification(
    translate('notification.updateAvailable.title'),
    translate('notification.updateAvailable.details', { current: info.currentVersion, latest: info.latestVersion }),
  ).catch((error) => {
    notifiedVersion = ''
    logger.warn('[Update] 发送更新可用通知失败:', error)
  })
}

export function notifyUpdateReady(version: string): void {
  if (notifiedReadyVersion === version) return
  notifiedReadyVersion = version

  void lcu.sendNotification(
    translate('notification.updateReady.title'),
    translate('notification.updateReady.details', { version }),
  ).catch((error) => {
    notifiedReadyVersion = ''
    logger.warn('[Update] 发送更新就绪通知失败:', error)
  })
}

/** 跳过某版本后不再提醒该版本 */
export function markVersionNotified(version: string): void {
  notifiedVersion = version
  notifiedReadyVersion = version
}

/** 清除“已跳过版本”后允许重新提醒（含已就绪通知） */
export function resetUpdateNotifications(): void {
  notifiedVersion = ''
  notifiedReadyVersion = ''
}
