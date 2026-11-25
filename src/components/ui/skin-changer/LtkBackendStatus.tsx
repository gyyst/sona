/**
 * 后台运行时版本与自更新状态
 *
 * sona-ltk 会自行检查、下载并替换 sona/ltk 运行时；这里只展示后台协议字段。
 * 旧后台没有版本字段，按 legacy 提示用户手动覆盖一次运行时。
 */

import { useSyncExternalStore } from 'react'
import { SonaButton } from '@/components/ui/SonaButton'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales'
import {
  ltkBridgeClient,
  type LtkBackendUpdateState,
} from '@/lib/features/skin-changer/bridge/ltk-client'
import { shortenBackendVersion } from '@/lib/features/skin-changer/bridge/ltk-status'

const RELEASE_URL = 'https://github.com/gyyst/sona/releases/latest'

type StatusTone = 'normal' | 'ok' | 'error'

interface StatusLine {
  key: TranslationKey
  tone: StatusTone
}

const TONE_COLOR: Record<StatusTone, string | undefined> = {
  normal: undefined,
  ok: '#4ade80',
  error: '#f87171',
}

function statusLine(state: LtkBackendUpdateState): StatusLine | null {
  switch (state) {
    case 'idle':
      return { key: 'tools.ltkBackend.idle', tone: 'ok' }
    case 'checking':
      return { key: 'tools.ltkBackend.checking', tone: 'normal' }
    case 'downloading':
      return { key: 'tools.ltkBackend.downloading', tone: 'normal' }
    case 'ready':
      return { key: 'tools.ltkBackend.ready', tone: 'ok' }
    case 'restarting':
      return { key: 'tools.ltkBackend.restarting', tone: 'ok' }
    case 'error':
      return { key: 'tools.ltkBackend.error', tone: 'error' }
    case 'unsupported':
      return { key: 'tools.ltkBackend.unsupported', tone: 'normal' }
    default:
      return null
  }
}

export function LtkBackendStatus() {
  const { t } = useI18n()
  const status = useSyncExternalStore(
    ltkBridgeClient.subscribe,
    ltkBridgeClient.getStatus,
    ltkBridgeClient.getStatus,
  )

  // 未开启或未连接时的提示由 LtkManagerInstall 统一展示，避免重复
  if (status.state === 'disabled' || !status.connected) return null

  const legacy = status.backendVersion === ''
  const line = statusLine(status.backendUpdateState)
  const detail = status.backendUpdateState === 'error' && status.backendUpdateMessage
    ? status.backendUpdateMessage
    : line
      ? t(line.key)
      : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <p className="sona-subtitle" style={{ margin: 0, color: legacy ? '#f59e0b' : undefined }}>
        {legacy
          ? t('tools.ltkBackend.legacy')
          : t('tools.ltkBackend.version', { version: shortenBackendVersion(status.backendVersion) })}
      </p>
      {detail && (
        <p className="sona-subtitle" style={{ margin: 0, color: line ? TONE_COLOR[line.tone] : undefined }}>
          {detail}
        </p>
      )}
      {(legacy || status.backendUpdateState === 'error') && (
        <div>
          <SonaButton variant="secondary" onClick={() => window.open(RELEASE_URL, '_blank')}>
            {t('tools.ltkBackend.manual')}
          </SonaButton>
        </div>
      )}
    </div>
  )
}
