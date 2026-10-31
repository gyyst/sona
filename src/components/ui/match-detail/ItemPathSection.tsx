import { useMemo, useState } from 'react'
import { useI18n, type TranslationKey } from '@/i18n'
import { getItemIcon, getItemName } from '@/lib/assets'
import { groupItemPaths, type ItemPathAction } from '@/lib/sgp-details'
import { PlayerPicker } from './PlayerPicker'
import { formatGameTime } from './utils'
import type { NormalizedTimelineEvent } from '@/lib/sgp-details'
import type { DetailPlayer } from './types'

const ACTION_KEYS: Record<ItemPathAction, TranslationKey> = {
  buy: 'matchDetail.itemPath.buy',
  sell: 'matchDetail.itemPath.sell',
  undo: 'matchDetail.itemPath.undo',
}

export interface ItemPathSectionProps {
  events: NormalizedTimelineEvent[]
  players: DetailPlayer[]
}

export function ItemPathSection({ events, players }: ItemPathSectionProps) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const grouped = useMemo(() => groupItemPaths(events), [events])
  const availablePlayers = useMemo(
    () => players.filter((player) => (grouped.get(player.participantId)?.length ?? 0) > 0),
    [players, grouped],
  )

  const activeId = selectedId != null && availablePlayers.some((player) => player.participantId === selectedId)
    ? selectedId
    : (availablePlayers[0]?.participantId ?? null)
  const entries = activeId != null ? (grouped.get(activeId) ?? []) : []

  const displayItemName = (itemId: number): string => {
    const name = getItemName(itemId)
    return name === String(itemId) ? t('matchDetail.itemPath.unknownItem', { id: itemId }) : name
  }

  if (availablePlayers.length === 0) {
    return <div className="smd-tab-empty">{t('matchDetail.itemPath.empty')}</div>
  }

  return (
    <div className="smd-path-layout">
      <PlayerPicker players={availablePlayers} activeId={activeId} onSelect={setSelectedId} />

      <div className="smd-path-content">
        {entries.length === 0 ? (
          <div className="smd-tab-empty">{t('matchDetail.itemPath.empty')}</div>
        ) : (
          entries.map((entry, index) => (
            <div key={`${entry.timestamp}-${entry.itemId}-${entry.action}-${index}`} className="smd-path-entry">
              <span className={`smd-path-action smd-path-action--${entry.action}`}>
                {t(ACTION_KEYS[entry.action])}
              </span>
              <span className="smd-path-item">
                <img src={getItemIcon(entry.itemId)} alt="" />
              </span>
              <span className="smd-path-item-name">{displayItemName(entry.itemId)}</span>
              <span className="smd-path-time">{formatGameTime(entry.timestamp)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
