/**
 * LTK Manager 安装状态卡片
 *
 * 只负责展示后台推送的安装状态与触发命令；下载、校验和安装都在
 * sona-ltk 后台执行。官方安装器只允许安装到 Program Files。
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SonaButton } from '@/components/ui/SonaButton'
import { useI18n } from '@/i18n'
import { ltkBridgeClient } from '@/lib/features/skin-changer/bridge/ltk-client'

const MANUAL_DOWNLOAD_URL = 'https://github.com/LeagueToolkit/ltk-manager/releases/latest'
const INSTALL_CAPABILITY = 'ltk-manager-install'
const NO_RESPONSE_TIMEOUT_MS = 5000

const ACTIVE_STATES = new Set(['downloading', 'verifying', 'installing'])

export function LtkManagerInstall() {
  const { t } = useI18n()
  const status = useSyncExternalStore(
    ltkBridgeClient.subscribe,
    ltkBridgeClient.getStatus,
    ltkBridgeClient.getStatus,
  )
  const [pending, setPending] = useState(false)
  const baselineRef = useRef({
    status: status.managerStatus,
    message: status.managerMessage,
    progress: status.managerProgress,
  })
  const timerRef = useRef<number | null>(null)

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => () => clearTimer(), [])

  useEffect(() => {
    if (!pending) return
    const baseline = baselineRef.current
    if (
      status.managerStatus !== baseline.status
      || status.managerMessage !== baseline.message
      || status.managerProgress !== baseline.progress
      || !status.connected
    ) {
      clearTimer()
      setPending(false)
    }
  }, [
    pending,
    status.managerStatus,
    status.managerMessage,
    status.managerProgress,
    status.connected,
  ])

  const handleInstall = () => {
    if (!ltkBridgeClient.installManager()) {
      Toast.error(t('tools.ltkManager.notConnected'))
      return
    }
    baselineRef.current = {
      status: status.managerStatus,
      message: status.managerMessage,
      progress: status.managerProgress,
    }
    setPending(true)
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setPending(false)
      timerRef.current = null
      Toast.error(t('tools.ltkManager.noResponse'))
    }, NO_RESPONSE_TIMEOUT_MS)
  }

  if (status.state === 'disabled') {
    return <p className="sona-subtitle">{t('tools.ltkManager.disabled')}</p>
  }

  if (!status.connected) {
    if (status.state === 'connecting') {
      return <p className="sona-subtitle">{t('tools.ltkManager.connecting')}</p>
    }
    return (
      <p className="sona-subtitle" style={{ color: '#f87171' }}>
        {status.message || t('tools.ltkManager.disconnected')}
      </p>
    )
  }

  if (!status.capabilities.includes(INSTALL_CAPABILITY)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p className="sona-subtitle">{t('tools.ltkManager.unsupported')}</p>
        <SonaButton variant="secondary" onClick={() => window.open(MANUAL_DOWNLOAD_URL, '_blank')}>
          {t('tools.ltkManager.manual')}
        </SonaButton>
      </div>
    )
  }

  const active = ACTIVE_STATES.has(status.managerStatus)
  const installed = status.managerStatus === 'installed'
  const failed = status.managerStatus === 'error'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {installed && (
        <p className="sona-subtitle" style={{ color: '#4ade80' }}>
          {status.managerMessage || t('tools.ltkManager.installed')}
        </p>
      )}

      {active && (
        <>
          <p className="sona-subtitle">{status.managerMessage}</p>
          {status.managerStatus === 'downloading' && (
            <div
              style={{
                height: 6,
                borderRadius: 3,
                overflow: 'hidden',
                background: 'rgba(255,255,255,0.12)',
              }}
            >
              <div
                style={{
                  width: `${status.managerProgress}%`,
                  height: '100%',
                  background: '#3b82f6',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
          )}
          {status.managerStatus === 'installing' && (
            <p className="sona-subtitle">{t('tools.ltkManager.waitUac')}</p>
          )}
        </>
      )}

      {failed && (
        <>
          <p className="sona-subtitle" style={{ color: '#f87171' }}>
            {status.managerMessage || t('tools.ltkManager.error')}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <SonaButton onClick={handleInstall}>{t('tools.ltkManager.retry')}</SonaButton>
            <SonaButton variant="secondary" onClick={() => window.open(MANUAL_DOWNLOAD_URL, '_blank')}>
              {t('tools.ltkManager.manual')}
            </SonaButton>
          </div>
        </>
      )}

      {!active && !installed && !failed && (
        <>
          <p className="sona-subtitle">{t('tools.ltkManager.description')}</p>
          <SonaButton onClick={handleInstall} disabled={pending}>
            {pending ? t('tools.ltkManager.starting') : t('tools.ltkManager.install')}
          </SonaButton>
        </>
      )}
    </div>
  )
}
