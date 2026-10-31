import { useI18n, type TranslationKey } from '@/i18n'
import { getChampIcon } from '@/lib/assets'
import { formatNumber } from './utils'
import type { TeamOverview, TeamOverviewSide } from '@/lib/sgp-details'

/** 数值型统计项；禁用单独用图标渲染 */
type StatKey = Exclude<keyof TeamOverviewSide, 'bans'>

interface StatRow {
  key: StatKey
  labelKey: TranslationKey
}

const STAT_ROWS: StatRow[] = [
  { key: 'kills', labelKey: 'matchDetail.teamOverview.kills' },
  { key: 'gold', labelKey: 'matchDetail.teamOverview.gold' },
  { key: 'dragons', labelKey: 'matchDetail.teamOverview.dragons' },
  { key: 'barons', labelKey: 'matchDetail.teamOverview.barons' },
  { key: 'towers', labelKey: 'matchDetail.teamOverview.towers' },
]

export interface TeamOverviewSectionProps {
  overview: TeamOverview | null
}

export function TeamOverviewSection({ overview }: TeamOverviewSectionProps) {
  const { t } = useI18n()

  if (!overview) {
    return <div className="smd-tab-empty">{t('matchDetail.teamOverview.empty')}</div>
  }

  const hasBans = overview.blue.bans.length > 0 || overview.red.bans.length > 0

  const renderSide = (side: 'blue' | 'red', data: TeamOverviewSide) => (
    <section className={`smd-overview-team smd-overview-team--${side}`}>
      <div className="smd-overview-team-title">
        {side === 'blue' ? t('matchDetail.team.blue') : t('matchDetail.team.red')}
      </div>
      {STAT_ROWS.map((row) => {
        const value = data[row.key]
        return (
          <div key={row.key} className="smd-overview-stat">
            <span>{t(row.labelKey)}</span>
            <strong>{row.key === 'gold' ? formatNumber(value) : value}</strong>
          </div>
        )
      })}
      {hasBans ? (
        <div className="smd-overview-bans">
          <span className="smd-overview-bans-label">{t('matchDetail.teamOverview.bans')}</span>
          <div className="smd-overview-bans-icons">
            {data.bans.length === 0 ? (
              <span className="smd-overview-bans-empty">-</span>
            ) : data.bans.map((championId, index) => (
              <img key={`${championId}-${index}`} src={getChampIcon(championId)} alt="" />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )

  return (
    <div className="smd-overview-grid">
      {renderSide('blue', overview.blue)}
      {renderSide('red', overview.red)}
    </div>
  )
}
