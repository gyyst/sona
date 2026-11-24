import { useEffect, useState } from 'react'
import { SonaButton } from '@/components/ui/SonaButton'
import {
  checkForUpdates,
  downloadUpdate,
  getReleasePageUrl,
  getUpdateState,
  onUpdateStateChange,
  skipUpdateVersion,
  type UpdateState,
} from '@/lib/update/update-checker'
import {
  getUpdateErrorText,
  getUpdateStatusText,
  getUpdateTargetVersion,
} from '@/components/ui/update/update-status'
import { reloadClient, restoreLocalVersion } from '@/lib/update/update-runtime'
import { useI18n, type TranslationKey } from '@/i18n'
import '@/styles/UpdatePage.css'

const GROUP_FILE_URL = ''
const QUARK_URL = 'https://pan.quark.cn/s/72e3caf2e3d9'

function formatPublishedDate(value: string, locale: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
  } catch {
    return value
  }
}

function getSourceLabelKey(source: SonaBootstrapInfo['source']): TranslationKey {
  if (source === 'cache') return 'update.source.cache'
  if (source === 'remote') return 'update.source.remote'
  return 'update.source.local'
}

export function UpdatePage() {
  const { t, locale } = useI18n()
  const [updateState, setUpdateState] = useState<UpdateState>(() => getUpdateState())

  useEffect(() => onUpdateStateChange(setUpdateState), [])

  const { status, info, errorKind, runtime, pendingVersion, cached } = updateState
  const targetVersion = getUpdateTargetVersion(updateState)
  const showRestore = runtime.source !== 'local' || errorKind === 'bootstrap'
  // 已就绪时手动复查会短暂进入 checking，仍应保留重启/跳过入口
  const showRestart = status === 'ready' || (status === 'checking' && Boolean(pendingVersion))
  const canSkip = Boolean(targetVersion)
    && (status === 'available' || status === 'ready' || status === 'error' || showRestart)
  // 错误只保留一种主操作：检查失败重新检查；下载/启动失败重试更新
  const retryDownloadAction = status === 'error' && errorKind !== 'check'
  const recheckAction = status === 'idle'
    || status === 'latest'
    || (status === 'error' && errorKind === 'check')

  const statusText = getUpdateStatusText(updateState, t)
  const errorText = status === 'error' ? getUpdateErrorText(updateState, t) : ''

  const openUrl = (url: string) => {
    if (!url) return
    window.open(url, '_blank')
  }

  return (
    <div className="sona-update-page">
      <h2 className="sona-update-title">
        <span>Sona</span>
        <span className="sona-update-title-version">{` v${runtime.runningVersion}`}</span>
        {targetVersion && (
          <>
            <span className="sona-update-title-arrow">→</span>
            <span className="sona-update-title-version sona-update-title-version--latest">{`v${targetVersion}`}</span>
          </>
        )}
      </h2>

      <div className="sona-update-meta">
        <span>{t('update.sourceLabel')}: {t(getSourceLabelKey(runtime.source))}</span>
        <span>{t('update.localVersion', { version: runtime.localVersion })}</span>
      </div>

      {info && (
        <div className="sona-update-release">
          <div className="sona-update-release-head">
            <span>{info.releaseName}</span>
            {info.publishedAt && <time dateTime={info.publishedAt}>{formatPublishedDate(info.publishedAt, locale)}</time>}
          </div>
          <pre className="sona-update-notes">{info.releaseBody || t('update.noNotes')}</pre>
        </div>
      )}

      <div className="sona-update-status">
        <h3>{t('update.statusTitle')}</h3>
        {statusText && <p>{statusText}</p>}
        {errorText && <p className="sona-update-error">{errorText}</p>}
        {showRestart && !cached && <p className="sona-update-hint">{t('update.notCached')}</p>}

        <div className="sona-update-actions">
          {status === 'available' && (
            <SonaButton variant="primary" onClick={() => { void downloadUpdate() }}>
              {t('update.downloadNow')}
            </SonaButton>
          )}
          {status === 'downloading' && (
            <SonaButton disabled>{t('update.downloading')}</SonaButton>
          )}
          {showRestart && (
            <SonaButton variant="primary" onClick={reloadClient}>
              {t('update.restartNow')}
            </SonaButton>
          )}
          {retryDownloadAction && (
            <SonaButton variant="primary" onClick={() => { void downloadUpdate() }}>
              {t('update.retryDownload')}
            </SonaButton>
          )}
          {recheckAction && (
            <SonaButton onClick={() => { void checkForUpdates() }}>
              {status === 'error' ? t('update.recheck') : t('update.checkNow')}
            </SonaButton>
          )}
          {canSkip && targetVersion && (
            <SonaButton onClick={() => skipUpdateVersion(targetVersion)}>
              {t('update.skipVersion', { version: targetVersion })}
            </SonaButton>
          )}
          {showRestore && (
            <SonaButton onClick={() => { void restoreLocalVersion() }}>
              {t('update.restoreLocal')}
            </SonaButton>
          )}
        </div>
      </div>

      <div className="sona-update-download">
        <h3>{t('update.downloadTitle')}</h3>
        <p>{t('update.downloadDescription')}</p>
        <div className="sona-update-actions">
          <SonaButton onClick={() => openUrl(info?.releaseUrl || getReleasePageUrl())}>
            {t('update.openRelease')}
          </SonaButton>
          <SonaButton onClick={() => openUrl(GROUP_FILE_URL)} disabled={!GROUP_FILE_URL}>
            {t('update.groupFile')}
          </SonaButton>
          <SonaButton onClick={() => openUrl(QUARK_URL)} disabled={!QUARK_URL}>
            {t('update.quark')}
          </SonaButton>
        </div>
      </div>
    </div>
  )
}
