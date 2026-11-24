/**
 * 换肤面板：皮肤网格
 *
 * 点击卡片直接应用该皮肤；当前应用的皮肤（含炫彩）高亮。
 */

import { useI18n } from '@/i18n'
import type { ChampionSkin } from '@/lib/features/skin-changer/state'

export interface SkinGridProps {
  skins: ChampionSkin[]
  /** 当前客户端选中的皮肤/炫彩 ID */
  selectedSkinId: number
  /** 正在提交的皮肤/炫彩 ID */
  applyingId: number
  /** 是否显示拥有状态标记 */
  ownershipKnown: boolean
  onApply: (skin: ChampionSkin) => void
}

function isSkinSelected(skin: ChampionSkin, selectedSkinId: number): boolean {
  return skin.id === selectedSkinId
    || skin.chromas.some((chroma) => chroma.id === selectedSkinId)
}

export function SkinGrid({ skins, selectedSkinId, applyingId, ownershipKnown, onApply }: SkinGridProps) {
  const { t } = useI18n()

  return (
    <div className="sona-skin-grid">
      {skins.map((skin) => {
        const selected = isSkinSelected(skin, selectedSkinId)
        const applying = applyingId === skin.id
        return (
          <button
            key={skin.id}
            type="button"
            className={`sona-skin-card${selected ? ' sona-skin-card--selected' : ''}${applying ? ' sona-skin-card--applying' : ''}`}
            onClick={() => onApply(skin)}
            title={skin.name}
          >
            <span className="sona-skin-card-media">
              <img src={skin.imagePath} alt="" loading="lazy" draggable={false} />
              {applying && <span className="sona-skin-card-spinner" aria-hidden="true" />}
              {selected && <span className="sona-skin-card-current">{t('skinChanger.current')}</span>}
            </span>
            <span className="sona-skin-card-meta">
              <span className="sona-skin-card-name">{skin.name}</span>
              {ownershipKnown && (
                <span className={`sona-skin-card-ownership${skin.owned ? ' sona-skin-card-ownership--owned' : ''}`}>
                  {skin.owned ? t('skinChanger.owned') : t('skinChanger.unowned')}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
