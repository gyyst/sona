/**
 * 换肤面板：选中皮肤的详情
 *
 * - 炫彩：点击直接应用对应色板
 * - 特殊形态：伪形态 ID 无法经客户端选中，仅提示需要外部注入器
 */

import { useI18n } from '@/i18n'
import type { ChampionSkin } from '@/lib/features/skin-changer/state'

export interface SkinDetailProps {
  skin: ChampionSkin | null
  selectedSkinId: number
  applyingId: number
  ownershipKnown: boolean
  onApplySkin: (skin: ChampionSkin) => void
  onApplyChroma: (skin: ChampionSkin, chromaId: number, chromaName: string) => void
  onNotice: (message: string) => void
}

export function SkinDetail({
  skin,
  selectedSkinId,
  applyingId,
  ownershipKnown,
  onApplySkin,
  onApplyChroma,
  onNotice,
}: SkinDetailProps) {
  const { t } = useI18n()

  if (!skin) {
    return (
      <div className="sona-skin-detail sona-skin-detail--empty">
        <p>{t('skinChanger.empty')}</p>
      </div>
    )
  }

  return (
    <div className="sona-skin-detail">
      <div className="sona-skin-detail-hero">
        <img src={skin.splashPath || skin.imagePath} alt="" draggable={false} />
        <div className="sona-skin-detail-overlay">
          <div className="sona-skin-detail-heading">
            <h4>{skin.name}</h4>
            {ownershipKnown && (
              <span className={`sona-skin-badge${skin.owned ? ' sona-skin-badge--owned' : ''}`}>
                {skin.owned ? t('skinChanger.owned') : t('skinChanger.unowned')}
              </span>
            )}
          </div>
          <button
            type="button"
            className="sona-skin-apply"
            disabled={applyingId === skin.id}
            onClick={() => onApplySkin(skin)}
          >
            {applyingId === skin.id ? t('skinChanger.applying') : t('skinChanger.applyBase')}
          </button>
        </div>
      </div>

      <section className="sona-skin-section">
        <h5>{t('skinChanger.chromas')}</h5>
        {skin.chromas.length === 0 ? (
          <p className="sona-skin-section-empty">{t('skinChanger.noChromas')}</p>
        ) : (
          <div className="sona-skin-chromas">
            {skin.chromas.map((chroma) => {
              const active = selectedSkinId === chroma.id
              return (
                <button
                  key={chroma.id}
                  type="button"
                  className={`sona-skin-chroma${active ? ' sona-skin-chroma--active' : ''}${applyingId === chroma.id ? ' sona-skin-chroma--applying' : ''}`}
                  onClick={() => onApplyChroma(skin, chroma.id, chroma.name)}
                  title={ownershipKnown && !chroma.owned
                    ? `${chroma.name} · ${t('skinChanger.unowned')}`
                    : chroma.name}
                >
                  <span
                    className="sona-skin-chroma-swatch"
                    style={{ background: buildChromaGradient(chroma.colors) }}
                  />
                  <span className="sona-skin-chroma-name">{chroma.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {skin.forms.length > 0 && (
        <section className="sona-skin-section">
          <h5>{t('skinChanger.forms')}</h5>
          <div className="sona-skin-forms">
            {skin.forms.map((form) => (
              <button
                key={form.id}
                type="button"
                className="sona-skin-form sona-skin-form--locked"
                onClick={() => onNotice(t('skinChanger.formOnlyWithInjector'))}
                title={t('skinChanger.formOnlyWithInjector')}
              >
                {t('skinChanger.form', { index: form.index })}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** 用炫彩主色拼出圆形色板；没有色值数据时退回中性灰 */
function buildChromaGradient(colors: string[]): string {
  if (colors.length === 0) return 'linear-gradient(135deg, #4a4a4f, #29272b)'
  if (colors.length === 1) return colors[0]
  const stops = colors.map((color, index) => {
    const percent = Math.round((index / (colors.length - 1)) * 100)
    return `${color} ${percent}%`
  })
  return `linear-gradient(135deg, ${stops.join(', ')})`
}
