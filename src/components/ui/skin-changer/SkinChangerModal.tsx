/**
 * 换肤面板主体
 *
 * 数据来自 skin-changer 模块的瞬时状态（useSyncExternalStore）。
 * 点击皮肤 / 炫彩 / 形态即写入客户端选择。
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Modal } from '@/components/ui/Modal'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales'
import {
  getSkinChangerState,
  subscribeSkinChanger,
} from '@/lib/features/skin-changer/state'
import { applySkinSelection } from '@/lib/features/skin-changer/skin-apply'
import {
  ltkBridgeClient,
  type LtkConnectionState,
} from '@/lib/features/skin-changer/ltk-client'
import type { ChampionSkin } from '@/lib/features/skin-changer/state'
import { SkinGrid } from './SkinGrid'
import { SkinDetail } from './SkinDetail'

export interface SkinChangerModalProps {
  open: boolean
  onClose: () => void
}

interface ApplyMeta {
  baseSkinId: number
  chromaId?: number
}

function ltkStateKey(state: LtkConnectionState): TranslationKey {
  switch (state) {
    case 'connecting':
      return 'skinChanger.ltk.connecting'
    case 'applying':
      return 'skinChanger.ltk.applying'
    case 'applied':
      return 'skinChanger.ltk.applied'
    case 'skipped-owned':
      return 'skinChanger.ltk.skippedOwned'
    case 'error':
      return 'skinChanger.ltk.error'
    default:
      return 'skinChanger.ltk.connected'
  }
}

export function SkinChangerModal({ open, onClose }: SkinChangerModalProps) {
  const { t } = useI18n()
  const state = useSyncExternalStore(subscribeSkinChanger, getSkinChangerState, getSkinChangerState)
  const ltkStatus = useSyncExternalStore(
    ltkBridgeClient.subscribe,
    ltkBridgeClient.getStatus,
    ltkBridgeClient.getStatus,
  )
  const [activeSkinId, setActiveSkinId] = useState(0)
  const [applyingId, setApplyingId] = useState(0)
  const [notice, setNotice] = useState('')
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const activeSkin = useMemo<ChampionSkin | null>(() => {
    if (state.skins.length === 0) return null
    return state.skins.find((skin) => skin.id === activeSkinId)
      ?? state.skins.find((skin) => skin.id === state.selectedSkinId
        || skin.chromas.some((chroma) => chroma.id === state.selectedSkinId))
      ?? state.skins[0]
  }, [state.skins, state.selectedSkinId, activeSkinId])

  const showNotice = (message: string) => {
    setNotice(message)
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice('')
      noticeTimerRef.current = null
    }, 3000)
  }

  const apply = async (
    skinId: number,
    skinName: string,
    owned: boolean,
    meta: ApplyMeta,
  ) => {
    if (state.championId <= 0) return
    setApplyingId(skinId)
    try {
      const ok = await applySkinSelection({
        championId: state.championId,
        skinId,
        baseSkinId: meta.baseSkinId,
        chromaId: meta.chromaId,
        skinName,
        owned,
        source: 'manual',
      })
      if (!ok) Toast.error(t('skinChanger.applyFailed'))
    } catch (error) {
      Toast.error(error instanceof Error ? error.message : t('skinChanger.applyFailed'))
    } finally {
      setApplyingId(0)
    }
  }

  const handleApplySkin = (skin: ChampionSkin) => {
    setActiveSkinId(skin.id)
    void apply(skin.id, skin.name, skin.owned, { baseSkinId: skin.id })
  }

  const handleApplyChroma = (skin: ChampionSkin, chromaId: number, chromaName: string) => {
    setActiveSkinId(skin.id)
    const chroma = skin.chromas.find((item) => item.id === chromaId)
    void apply(chromaId, `${skin.name} · ${chromaName}`, chroma?.owned ?? false, {
      baseSkinId: skin.id,
      chromaId,
    })
  }

  const subtitle = state.championName
    ? t('skinChanger.subtitle', { champion: state.championName, count: state.skins.length })
    : t('skinChanger.title')

  return (
    <Modal open={open} onClose={onClose} width={940} height={640}>
      <div className="sona-skin-panel">
        <header className="sona-skin-panel-header">
          <div>
            <h3>{t('skinChanger.title')}</h3>
            <p>{subtitle}</p>
          </div>
          <div className="sona-skin-panel-meta">
            {ltkStatus.state !== 'disabled' && (
              <span
                className={`sona-skin-ltk sona-skin-ltk--${ltkStatus.state}`}
                title={ltkStatus.message}
              >
                {t(ltkStateKey(ltkStatus.state))}
                {ltkStatus.state === 'applied' && ltkStatus.skinName
                  ? ` · ${ltkStatus.skinName}`
                  : ''}
              </span>
            )}
            <span className="sona-skin-panel-hint">{t('skinChanger.previewNotice')}</span>
          </div>
        </header>

        {notice && <div className="sona-skin-notice">{notice}</div>}

        <div className="sona-skin-panel-body">
          <div className="sona-skin-panel-list">
            {state.loading && <p className="sona-skin-panel-status">{t('skinChanger.loading')}</p>}
            {!state.loading && state.error && (
              <p className="sona-skin-panel-status sona-skin-panel-status--error">
                {t('skinChanger.error', { message: state.error })}
              </p>
            )}
            {!state.loading && !state.error && state.skins.length === 0 && (
              <p className="sona-skin-panel-status">{t('skinChanger.empty')}</p>
            )}
            {state.skins.length > 0 && (
              <SkinGrid
                skins={state.skins}
                selectedSkinId={state.selectedSkinId}
                applyingId={applyingId}
                ownershipKnown={state.ownershipKnown}
                onApply={handleApplySkin}
              />
            )}
          </div>

          <SkinDetail
            skin={activeSkin}
            selectedSkinId={state.selectedSkinId}
            applyingId={applyingId}
            ownershipKnown={state.ownershipKnown}
            onApplySkin={handleApplySkin}
            onApplyChroma={handleApplyChroma}
            onNotice={showNotice}
          />
        </div>
      </div>
    </Modal>
  )
}
