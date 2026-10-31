import { useMemo, useState } from 'react'
import { useI18n, type TranslationKey } from '@/i18n'
import { getItemName } from '@/lib/assets'
import { buildPlayerMap, formatGameTime } from './utils'
import type { NormalizedTimelineEvent, TimelineEventKind } from '@/lib/sgp-details'
import type { DetailPlayer } from './types'

type TimelineFilter = 'all' | 'kill' | 'objective' | 'building'

const FILTERS: TimelineFilter[] = ['all', 'kill', 'objective', 'building']
const FILTER_KEYS: Record<TimelineFilter, TranslationKey> = {
  all: 'matchDetail.timeline.filter.all',
  kill: 'matchDetail.timeline.filter.kill',
  objective: 'matchDetail.timeline.filter.objective',
  building: 'matchDetail.timeline.filter.building',
}

const KIND_KEYS: Record<TimelineEventKind, TranslationKey> = {
  kill: 'matchDetail.timeline.kind.kill',
  item: 'matchDetail.timeline.kind.item',
  skill: 'matchDetail.timeline.kind.skill',
  objective: 'matchDetail.timeline.kind.objective',
  building: 'matchDetail.timeline.kind.building',
  ward: 'matchDetail.timeline.kind.ward',
  other: 'matchDetail.timeline.kind.other',
}

const MONSTER_KEYS: Record<string, TranslationKey> = {
  DRAGON: 'matchDetail.timeline.monster.dragon',
  BARON_NASHOR: 'matchDetail.timeline.monster.baron',
  RIFTHERALD: 'matchDetail.timeline.monster.herald',
  HORDE: 'matchDetail.timeline.monster.horde',
  ATAKHAN: 'matchDetail.timeline.monster.atakhan',
}

const SKILL_NAMES: Record<number, string> = {
  1: 'Q',
  2: 'W',
  3: 'E',
  4: 'R',
}

/** 首次渲染 100 条，避免一局 500+ 事件阻塞弹窗 */
const INITIAL_VISIBLE = 100

function matchesFilter(event: NormalizedTimelineEvent, filter: TimelineFilter): boolean {
  // 装备 / 技能有独立页签，时间轴「全部」只保留战斗与地图事件，避免刷屏
  if (filter === 'all') return event.kind !== 'item' && event.kind !== 'skill'
  if (filter === 'kill') return event.kind === 'kill'
  if (filter === 'objective') return event.kind === 'objective'
  return event.kind === 'building'
}

export interface MatchTimelineSectionProps {
  events: NormalizedTimelineEvent[]
  players: DetailPlayer[]
  source: 'sgp' | 'lcu'
}

export function MatchTimelineSection({ events, players, source }: MatchTimelineSectionProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const [visible, setVisible] = useState(INITIAL_VISIBLE)

  const playerMap = useMemo(() => buildPlayerMap(players), [players])
  const filtered = useMemo(
    () => events.filter((event) => matchesFilter(event, filter)),
    [events, filter],
  )
  const visibleEvents = filtered.slice(0, visible)

  const playerName = (participantId?: number): string => {
    if (participantId == null) return t('matchDetail.timeline.unknownPlayer')
    return playerMap.get(participantId)?.name ?? t('matchDetail.playerFallback', { id: participantId })
  }

  const teamName = (teamId?: number): string => {
    if (teamId === 100) return t('matchDetail.team.blue')
    if (teamId === 200) return t('matchDetail.team.red')
    return t('matchDetail.timeline.unknownTeam')
  }

  /** 事件中的 teamId 表示被摧毁建筑的所有者，击杀者队伍才是贡献方 */
  const ownerTeamToKillerTeam = (teamId?: number): number | undefined => {
    if (teamId === 100) return 200
    if (teamId === 200) return 100
    return undefined
  }

  const describeEvent = (event: NormalizedTimelineEvent): string => {
    switch (event.type) {
      case 'CHAMPION_KILL': {
        const assists = event.assistingParticipantIds?.length ?? 0
        return assists > 0
          ? t('matchDetail.timeline.event.killAssist', {
            killer: playerName(event.killerId),
            victim: playerName(event.victimId),
            assists,
          })
          : t('matchDetail.timeline.event.kill', {
            killer: playerName(event.killerId),
            victim: playerName(event.victimId),
          })
      }
      case 'CHAMPION_SPECIAL_KILL':
        return t('matchDetail.timeline.event.specialKill', { killer: playerName(event.killerId) })
      case 'ELITE_MONSTER_KILL': {
        const killerTeam = event.killerId != null ? playerMap.get(event.killerId)?.teamId : undefined
        const monsterKey = event.monsterType ? MONSTER_KEYS[event.monsterType] : undefined
        return t('matchDetail.timeline.event.objective', {
          team: teamName(killerTeam ?? event.teamId),
          monster: monsterKey ? t(monsterKey) : t('matchDetail.timeline.monster.other'),
        })
      }
      case 'BUILDING_KILL': {
        const killerTeam = event.killerId != null ? playerMap.get(event.killerId)?.teamId : undefined
        const buildingKey: TranslationKey = event.buildingType === 'INHIBITOR_BUILDING'
          ? 'matchDetail.timeline.building.inhibitor'
          : event.buildingType === 'TOWER_BUILDING' || event.towerType
            ? 'matchDetail.timeline.building.tower'
            : 'matchDetail.timeline.building.other'
        return t('matchDetail.timeline.event.building', {
          team: teamName(killerTeam ?? ownerTeamToKillerTeam(event.teamId)),
          target: t(buildingKey),
        })
      }
      case 'TURRET_PLATE_DESTROYED': {
        const killerTeam = event.killerId != null ? playerMap.get(event.killerId)?.teamId : undefined
        return t('matchDetail.timeline.event.turretPlate', {
          team: teamName(killerTeam ?? ownerTeamToKillerTeam(event.teamId)),
        })
      }
      case 'ITEM_PURCHASED': {
        const itemName = event.itemId ? getItemName(event.itemId) : t('matchDetail.itemPath.unknownItem', { id: '?' })
        return t('matchDetail.timeline.event.itemBuy', { player: playerName(event.participantId), item: itemName })
      }
      case 'ITEM_SOLD': {
        const itemName = event.itemId ? getItemName(event.itemId) : t('matchDetail.itemPath.unknownItem', { id: '?' })
        return t('matchDetail.timeline.event.itemSell', { player: playerName(event.participantId), item: itemName })
      }
      case 'ITEM_UNDO': {
        const itemId = event.beforeId ?? event.afterId ?? event.itemId
        const itemName = itemId ? getItemName(itemId) : t('matchDetail.itemPath.unknownItem', { id: '?' })
        return t('matchDetail.timeline.event.itemUndo', { player: playerName(event.participantId), item: itemName })
      }
      case 'SKILL_LEVEL_UP': {
        const skill = event.skillSlot != null ? (SKILL_NAMES[event.skillSlot] ?? '?') : '?'
        return t('matchDetail.timeline.event.skill', { player: playerName(event.participantId), skill })
      }
      case 'LEVEL_UP':
        return t('matchDetail.timeline.event.levelUp', {
          player: playerName(event.participantId),
          level: event.level ?? '?',
        })
      case 'WARD_PLACED':
        return t('matchDetail.timeline.event.wardPlaced', {
          player: playerName(event.creatorId ?? event.participantId),
        })
      case 'WARD_KILL':
        return t('matchDetail.timeline.event.wardKilled', {
          player: playerName(event.killerId ?? event.participantId),
        })
      case 'DRAGON_SOUL_GIVEN':
        return t('matchDetail.timeline.event.dragonSoul', { team: teamName(event.teamId) })
      case 'GAME_END':
        return t('matchDetail.timeline.event.gameEnd')
      default:
        return t('matchDetail.timeline.event.other', { type: event.type })
    }
  }

  return (
    <div className="smd-timeline">
      <div className="smd-timeline-toolbar">
        <div className="smd-timeline-filters">
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              className={`smd-timeline-filter${filter === item ? ' smd-timeline-filter--active' : ''}`}
              onClick={() => {
                setFilter(item)
                setVisible(INITIAL_VISIBLE)
              }}
            >
              {t(FILTER_KEYS[item])}
            </button>
          ))}
        </div>
        <span className="smd-timeline-source">
          {source === 'sgp' ? t('matchDetail.timeline.source.sgp') : t('matchDetail.timeline.source.lcu')}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="smd-tab-empty">{t('matchDetail.timeline.empty')}</div>
      ) : (
        <div className="smd-timeline-list">
          {visibleEvents.map((event, index) => (
            <div
              key={`${event.timestamp}-${event.type}-${index}`}
              className={`smd-timeline-row smd-timeline-row--${event.kind}`}
              title={event.position ? `${event.position.x}, ${event.position.y}` : undefined}
            >
              <span className="smd-timeline-time">{formatGameTime(event.timestamp)}</span>
              <span className={`smd-timeline-kind smd-timeline-kind--${event.kind}`}>
                {t(KIND_KEYS[event.kind])}
              </span>
              <span className="smd-timeline-text">{describeEvent(event)}</span>
            </div>
          ))}
        </div>
      )}

      {filtered.length > visible ? (
        <button
          type="button"
          className="smd-timeline-more"
          onClick={() => setVisible((current) => current + INITIAL_VISIBLE)}
        >
          {t('matchDetail.timeline.loadMore', { count: filtered.length - visible })}
        </button>
      ) : null}
    </div>
  )
}
