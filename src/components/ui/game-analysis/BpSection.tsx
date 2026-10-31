import { getChampIcon, getChampionById } from '@/lib/assets'
import type { OpggPosition } from '@/lib/opgg-api'
import type { MatchupEntry } from '@/lib/team-matchups'
import { useI18n, type TranslationKey } from '@/i18n'

const POSITION_LABEL_KEYS: Partial<Record<OpggPosition, TranslationKey>> = {
  top: 'opgg.position.top',
  jungle: 'opgg.position.jungle',
  mid: 'opgg.position.mid',
  adc: 'opgg.position.adc',
  support: 'opgg.position.support',
}

interface MatchupStatus {
  labelKey: TranslationKey
  className: string
}

function getMatchupStatus(winRate: number): MatchupStatus {
  if (winRate >= 0.52) {
    return { labelKey: 'gameAnalysis.matchups.advantage', className: 'sga-bp-status--advantage' }
  }
  if (winRate <= 0.48) {
    return { labelKey: 'gameAnalysis.matchups.disadvantage', className: 'sga-bp-status--disadvantage' }
  }
  return { labelKey: 'gameAnalysis.matchups.neutral', className: 'sga-bp-status--neutral' }
}

function getChampionName(championId: number): string {
  return getChampionById(championId)?.name ?? String(championId)
}

export function BpSection({ entries }: { entries: MatchupEntry[] }) {
  const { t } = useI18n()
  if (entries.length === 0) return null

  return (
    <section className="sga-insight sga-bp">
      <div className="sga-insight-title">{t('gameAnalysis.matchups.title')}</div>
      <div className="sga-bp-list">
        {entries.map((entry) => {
          const status = getMatchupStatus(entry.winRate)
          const allyName = getChampionName(entry.allyChampionId)
          const enemyName = getChampionName(entry.enemyChampionId)

          return (
            <div
              key={`${entry.position}-${entry.allyChampionId}-${entry.enemyChampionId}`}
              className="sga-bp-row"
            >
              <span className="sga-bp-pos">
                {t(POSITION_LABEL_KEYS[entry.position] ?? 'opgg.position.mid')}
              </span>
              <span className="sga-bp-champ" title={`${t('gameAnalysis.matchups.ally')}: ${allyName}`}>
                <img className="sga-bp-icon" src={getChampIcon(entry.allyChampionId)} alt="" />
                <span className="sga-bp-name">{allyName}</span>
              </span>
              <span className="sga-bp-vs">{t('gameAnalysis.matchups.versus')}</span>
              <span className="sga-bp-champ" title={`${t('gameAnalysis.matchups.enemy')}: ${enemyName}`}>
                <img className="sga-bp-icon" src={getChampIcon(entry.enemyChampionId)} alt="" />
                <span className="sga-bp-name">{enemyName}</span>
              </span>
              <span className={`sga-bp-rate ${status.className}`}>
                {(entry.winRate * 100).toFixed(0)}%
              </span>
              <span className={`sga-bp-status ${status.className}`}>{t(status.labelKey)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
