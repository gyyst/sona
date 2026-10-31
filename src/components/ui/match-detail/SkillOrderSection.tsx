import { useMemo, useState } from 'react'
import { useI18n } from '@/i18n'
import { groupSkillOrders } from '@/lib/sgp-details'
import { PlayerPicker } from './PlayerPicker'
import { formatGameTime } from './utils'
import type { NormalizedTimelineEvent } from '@/lib/sgp-details'
import type { DetailPlayer } from './types'

export interface SkillOrderSectionProps {
  events: NormalizedTimelineEvent[]
  players: DetailPlayer[]
}

export function SkillOrderSection({ events, players }: SkillOrderSectionProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const grouped = useMemo(() => groupSkillOrders(events), [events])
  const availablePlayers = useMemo(
    () => players.filter((player) => grouped.has(player.participantId)),
    [players, grouped],
  )

  const activeId = selectedId != null && availablePlayers.some((player) => player.participantId === selectedId)
    ? selectedId
    : (availablePlayers[0]?.participantId ?? null)
  const entry = activeId != null ? grouped.get(activeId) : undefined

  if (availablePlayers.length === 0 || !entry) {
    return <div className="smd-tab-empty">{t('matchDetail.skillOrder.empty')}</div>
  }

  return (
    <div className="smd-path-layout">
      <PlayerPicker players={availablePlayers} activeId={activeId} onSelect={setSelectedId} />

      <div className="smd-skill-content">
        <div className="smd-skill-summary">
          {t('matchDetail.skillOrder.count', { count: entry.order.length })}
        </div>
        <div className="smd-skill-sequence">
          {entry.order.map((letter, index) => (
            <span
              key={`${letter}-${index}`}
              className={`smd-skill-cell smd-skill-cell--${letter.toLowerCase()}`}
            >
              <strong>{letter}</strong>
              <small>{formatGameTime(entry.timestamps[index] ?? 0)}</small>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
