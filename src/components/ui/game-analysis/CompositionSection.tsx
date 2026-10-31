import type { TeamComposition } from '@/lib/team-composition'
import { useI18n } from '@/i18n'

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function CompositionTeam({ data, tone }: { data: TeamComposition; tone: 'blue' | 'red' }) {
  const { t } = useI18n()
  const damageTotal = data.ad + data.ap
  const adPercent = damageTotal > 0 ? (data.ad / damageTotal) * 100 : 50
  const apPercent = damageTotal > 0 ? (data.ap / damageTotal) * 100 : 50

  return (
    <div className={`sga-comp-team sga-comp-team--${tone}`}>
      <div className="sga-comp-head">
        <span className="sga-comp-team-name">
          {t(tone === 'blue' ? 'gameAnalysis.blueTeam' : 'gameAnalysis.redTeam')}
        </span>
        <span className="sga-comp-damage-counts">
          <span className="sga-comp-ad">{t('gameAnalysis.composition.ad')} {formatCount(data.ad)}</span>
          <span className="sga-comp-ap">{t('gameAnalysis.composition.ap')} {formatCount(data.ap)}</span>
          {data.mixed > 0 && (
            <span className="sga-comp-mixed">{t('gameAnalysis.composition.mixed')} {formatCount(data.mixed)}</span>
          )}
        </span>
      </div>
      {damageTotal > 0 && (
        <div className="sga-comp-bar">
          <div className="sga-comp-bar-ad" style={{ width: `${adPercent}%` }} />
          <div className="sga-comp-bar-ap" style={{ width: `${apPercent}%` }} />
        </div>
      )}
      <div className="sga-comp-stats">
        <span><strong>{data.melee}</strong> {t('gameAnalysis.composition.melee')}</span>
        <span><strong>{data.ranged}</strong> {t('gameAnalysis.composition.ranged')}</span>
        <span><strong>{data.frontline}</strong> {t('gameAnalysis.composition.frontline')}</span>
        <span><strong>{data.crowdControl}</strong> {t('gameAnalysis.composition.crowdControl')}</span>
        <span><strong>{data.engage}</strong> {t('gameAnalysis.composition.engage')}</span>
        <span><strong>{data.protection}</strong> {t('gameAnalysis.composition.protection')}</span>
      </div>
      {!data.complete && data.resolved > 0 && (
        <div className="sga-comp-warning">{t('gameAnalysis.composition.incomplete')}</div>
      )}
    </div>
  )
}

export function CompositionSection({ blue, red }: { blue: TeamComposition; red: TeamComposition }) {
  const { t } = useI18n()
  if (blue.resolved === 0 && red.resolved === 0) return null

  return (
    <section className="sga-insight sga-composition">
      <div className="sga-insight-title">{t('gameAnalysis.composition.title')}</div>
      <CompositionTeam data={blue} tone="blue" />
      <CompositionTeam data={red} tone="red" />
    </section>
  )
}
