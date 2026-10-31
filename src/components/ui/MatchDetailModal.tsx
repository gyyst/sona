import { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { ItemPathSection } from '@/components/ui/match-detail/ItemPathSection'
import { MatchTimelineSection } from '@/components/ui/match-detail/MatchTimelineSection'
import { SkillOrderSection } from '@/components/ui/match-detail/SkillOrderSection'
import { TeamOverviewSection } from '@/components/ui/match-detail/TeamOverviewSection'
import type { DetailPlayer } from '@/components/ui/match-detail/types'
import { PlayerNoteBadge, PlayerNoteEditButton } from '@/components/ui/PlayerNoteBadge'
import { PlayerNoteEditor } from '@/components/ui/PlayerNoteEditor'
import { lcu } from '@/lib/lcu'
import { store } from '@/lib/store'
import { getChampIcon, getItemIcon, getSpellIcon, getPerkIcon, getPerkStyleIcon, getQueueName, getMapName } from '@/lib/assets'
import { buildTeamOverview, groupItemPaths, groupSkillOrders, normalizeLcuTimeline, normalizeSgpDetails } from '@/lib/sgp-details'
import type { NormalizedTimelineEvent } from '@/lib/sgp-details'
import { translate, useI18n } from '@/i18n'
import type { PlayerNote } from '@/lib/player-notes'
import type { SgpGameDetailsLol } from '@/types/sgp'
import type { MatchDetail, Participant, ParticipantIdentity, MatchTeam } from '@/types/lcu'
import blueTurretIcon from '@/../assets/game-statistic-icons/Blue_Turret_icon.png'
import redTurretIcon from '@/../assets/game-statistic-icons/Red_Turret_icon.png'
import '@/styles/MatchDetailModal.css'

type DetailTab = 'overview' | 'timeline' | 'items' | 'skills' | 'teams'
type TimelineSource = 'sgp' | 'lcu' | 'none'

interface TimelineResult {
  source: TimelineSource
  details: SgpGameDetailsLol | null
  events: NormalizedTimelineEvent[]
}

const TIMELINE_CACHE_TTL_MS = 5 * 60 * 1000
const timelineCache = new Map<number, { result: TimelineResult; fetchedAt: number }>()
const timelineInflight = new Map<number, Promise<TimelineResult>>()

/**
 * 按需加载时间轴：SGP DETAILS 优先，失败后回退 LCU game-timelines。
 *
 * 同一局结果缓存 5 分钟，并用进行中 Promise 去重，重复打开详情不会重复请求。
 */
async function loadTimelineData(gameId: number): Promise<TimelineResult> {
  const now = Date.now()
  // 及时清理过期缓存，避免 DETAILS 大对象在长时间会话里无限堆积
  for (const [id, entry] of timelineCache) {
    if (now - entry.fetchedAt >= TIMELINE_CACHE_TTL_MS) timelineCache.delete(id)
  }

  const cached = timelineCache.get(gameId)
  if (cached && now - cached.fetchedAt < TIMELINE_CACHE_TTL_MS) {
    return cached.result
  }

  const inflight = timelineInflight.get(gameId)
  if (inflight) return inflight

  const promise = (async (): Promise<TimelineResult> => {
    let result: TimelineResult = { source: 'none', details: null, events: [] }

    try {
      const matchId = await lcu.resolveSgpMatchId(gameId)
      if (matchId) {
        const details = await lcu.getSgpGameDetails(matchId)
        if (details) {
          const events = normalizeSgpDetails(details)
          if (events.length > 0) {
            result = { source: 'sgp', details, events }
          }
        }
      }

      // DETAILS 不可用或没有事件时，回退 LCU timeline（只有击杀/目标/建筑）
      if (result.source === 'none') {
        const rawTimeline = await lcu.getMatchTimeline(gameId).catch(() => null)
        const events = normalizeLcuTimeline(rawTimeline)
        if (events.length > 0) {
          result = { source: 'lcu', details: null, events }
        }
      }
    } catch (err) {
      console.warn('[MatchDetail] 时间轴加载失败，仅展示概览:', err)
    }

    timelineCache.set(gameId, { result, fetchedAt: Date.now() })
    return result
  })()

  timelineInflight.set(gameId, promise)
  try {
    return await promise
  } finally {
    timelineInflight.delete(gameId)
  }
}

type RankInfo = {
  rankText: string
  rankColor: string
}

type IconMaps = {
  spells: Map<number, string>
  perks: Map<number, string>
  perkStyles: Map<number, string>
}

const RANK_COLORS: Record<string, string> = {
  CHALLENGER: '#f1c40f',
  GRANDMASTER: '#e74c3c',
  MASTER: '#9b59b6',
  DIAMOND: '#3498db',
  EMERALD: '#00d084',
  PLATINUM: '#b8c4cc',
  GOLD: '#c8aa6e',
  SILVER: '#a09b8c',
  BRONZE: '#cd7f32',
  IRON: '#7e7e7e',
  UNRANKED: '#5c5b57',
}

const RANK_NAMES: Record<string, string> = {
  CHALLENGER: '最强王者',
  GRANDMASTER: '傲世宗师',
  MASTER: '超凡大师',
  DIAMOND: '璀璨钻石',
  EMERALD: '流光翡翠',
  PLATINUM: '华贵铂金',
  GOLD: '荣耀黄金',
  SILVER: '不屈白银',
  BRONZE: '英勇青铜',
  IRON: '坚韧黑铁',
}

function formatK(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function formatFullNumber(value: number): string {
  return value.toLocaleString()
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatStartTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function renderKdaValue(value: number, highlight: boolean) {
  return <span className={highlight ? 'smd-kda-max' : undefined}>{value}</span>
}

function readIconFromMap(map: Map<number, string>, id: number): string {
  return id > 0 ? (map.get(id) ?? '') : ''
}

function getIdentity(identityMap: Map<number, ParticipantIdentity>, participantId: number) {
  return identityMap.get(participantId)?.player
}

function getUnrankedInfo(): RankInfo {
  return { rankText: translate('rank.UNRANKED'), rankColor: RANK_COLORS.UNRANKED }
}

function getRankInfoFromTier(tier: string): RankInfo {
  if (!tier || tier === 'UNRANKED') return getUnrankedInfo()
  return {
    rankText: translate(`rank.${tier}` as Parameters<typeof translate>[0]),
    rankColor: RANK_COLORS[tier] ?? RANK_COLORS.UNRANKED,
  }
}

function parseRankInfo(ranked: unknown, fallbackTier = ''): RankInfo {
  const fallback = getRankInfoFromTier(fallbackTier)
  if (!ranked || typeof ranked !== 'object') return fallback

  const queues = (ranked as Record<string, unknown>).queueMap as Record<string, Record<string, unknown>> | undefined
  if (!queues) return fallback

  const tierOrder = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER']
  const divisionOrder: Record<string, number> = { IV: 1, III: 2, II: 3, I: 4 }
  type QueueKey = 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR'
  const candidates: { key: QueueKey; label: string; tier: string; division: string }[] = []

  for (const [key, label] of [['RANKED_SOLO_5x5', translate('rank.queue.RANKED_SOLO_5x5')], ['RANKED_FLEX_SR', translate('rank.queue.RANKED_FLEX_SR')]] as [QueueKey, string][]) {
    const queue = queues[key]
    if (!queue) continue
    const tier = (queue.tier as string) ?? ''
    const division = (queue.division as string) ?? ''
    if (tier && tier !== 'UNRANKED') candidates.push({ key, label, tier, division })
  }

  if (candidates.length === 0) return fallback

  candidates.sort((a, b) => {
    const tierDiff = tierOrder.indexOf(b.tier) - tierOrder.indexOf(a.tier)
    if (tierDiff !== 0) return tierDiff
    return (divisionOrder[b.division] ?? 0) - (divisionOrder[a.division] ?? 0)
  })

  const best = candidates[0]
  return {
    rankText: `${translate(`rank.${best.tier}` as Parameters<typeof translate>[0])}${best.division && best.division !== 'NA' ? ` ${best.division}` : ''} ${best.label}`,
    rankColor: RANK_COLORS[best.tier] ?? RANK_COLORS.UNRANKED,
  }
}

function TeamSummary({ team, participants, isRed }: { team?: MatchTeam; participants: Participant[]; isRed: boolean }) {
  const kills = participants.reduce((sum, p) => sum + p.stats.kills, 0)
  const gold = participants.reduce((sum, p) => sum + p.stats.goldEarned, 0)
  const damage = participants.reduce((sum, p) => sum + p.stats.totalDamageDealtToChampions, 0)

  return (
    <div className="smd-team-summary">
      <span title="击杀">
        <span className="smd-sprite-icon" style={{ WebkitMaskImage: 'url(/fe/lol-match-history/icons.png)', WebkitMaskPositionY: '0%' }} />
        {kills}
      </span>
      <span className="smd-stat-gold" title="金币">
        <span className="smd-stat-icon" style={{ WebkitMaskImage: 'url(/fe/lol-match-history/icon_gold.png)' }} />
        {formatK(gold)}
      </span>
      <span className="smd-team-damage" title="伤害">
        <span className="smd-damage-icon" />
        {formatK(damage)}
      </span>
      <span className="smd-team-turret" title="防御塔">
        <img src={isRed ? redTurretIcon : blueTurretIcon} alt="" />
        {team?.towerKills ?? 0}
      </span>
    </div>
  )
}

function ParticipantRow({
  participant,
  identity,
  maxDamage,
  highlighted,
  isRed,
  rankInfo,
  iconMaps,
  note,
  onEditNote,
}: {
  participant: Participant
  identity?: ParticipantIdentity['player']
  maxDamage: number
  highlighted: boolean
  isRed: boolean
  rankInfo?: RankInfo
  iconMaps: IconMaps
  note?: PlayerNote
  onEditNote?: (puuid: string, displayName: string) => void
}) {
  const stats = participant.stats
  const items = [stats.item0, stats.item1, stats.item2, stats.item3, stats.item4, stats.item5]
  const loadoutIcons = [
    { icon: getPerkIcon(stats.perk0) || readIconFromMap(iconMaps.perks, stats.perk0), type: 'rune' },
    { icon: getPerkStyleIcon(stats.perkSubStyle) || readIconFromMap(iconMaps.perkStyles, stats.perkSubStyle), type: 'rune' },
    { icon: getSpellIcon(participant.spell1Id) || readIconFromMap(iconMaps.spells, participant.spell1Id), type: 'spell' },
    { icon: getSpellIcon(participant.spell2Id) || readIconFromMap(iconMaps.spells, participant.spell2Id), type: 'spell' },
  ].filter((item) => item.icon)
  const maxKdaValue = Math.max(stats.kills, stats.deaths, stats.assists)
  const damageWidth = maxDamage > 0 ? Math.max(6, Math.round((stats.totalDamageDealtToChampions / maxDamage) * 100)) : 0
  const topDamage = maxDamage > 0 && stats.totalDamageDealtToChampions === maxDamage
  const name = identity ? `${identity.gameName}#${identity.tagLine}` : translate('matchDetail.playerFallback', { id: participant.participantId })
  const cs = stats.totalMinionsKilled + stats.neutralMinionsKilled
  const displayRank = rankInfo ?? getRankInfoFromTier(participant.highestAchievedSeasonTier)

  const handleCopyName = () => {
    if (!identity) return
    navigator.clipboard.writeText(name).then(() => {
      Toast.success(translate('matchDetail.copyId'))
    })
  }

  return (
    <div className={`smd-player-row${isRed ? ' smd-player-row--red' : ''}${highlighted ? ' smd-player-row--focus' : ''}${topDamage ? ' smd-player-row--top-damage' : ''}${note?.blacklisted ? ' spn-blacklisted-row' : ''}`}>
      <div className="smd-champ-block">
        <div className="smd-champ">
          <img src={getChampIcon(participant.championId)} alt="" />
          <span className="smd-champ-level">{stats.champLevel}</span>
        </div>
        <div className="smd-loadout">
          {loadoutIcons.map(({ icon, type }, idx) => (
            <div key={`${type}-${idx}`} className={`smd-loadout-slot smd-loadout-${type}`}>
              <img src={icon} alt="" />
            </div>
          ))}
        </div>
      </div>

      <div className="smd-player-identity" title={name}>
        <div className="smd-player-name-line">
          <button className="smd-player-name" onClick={handleCopyName} type="button">
            <span>{identity?.gameName ?? translate('matchDetail.playerFallback', { id: participant.participantId })}</span>
          </button>
          {identity?.puuid && onEditNote ? (
            <>
              <PlayerNoteBadge
                note={note}
                compact
                onClick={() => onEditNote(identity.puuid, name)}
              />
              <PlayerNoteEditButton onClick={() => onEditNote(identity.puuid, name)} />
            </>
          ) : null}
        </div>
        <strong className="smd-kda">
          {renderKdaValue(stats.kills, stats.kills === maxKdaValue)}
          {' / '}
          {renderKdaValue(stats.deaths, stats.deaths === maxKdaValue)}
          {' / '}
          {renderKdaValue(stats.assists, stats.assists === maxKdaValue)}
        </strong>
        <span className="smd-player-rank" style={{ color: displayRank.rankColor }}>
          {displayRank.rankText}
        </span>
      </div>

      <div className="smd-metrics">
        <div className="smd-damage">
          <span className="smd-damage-value">
            <span className="smd-damage-icon" />
            <strong>{formatFullNumber(stats.totalDamageDealtToChampions)}</strong>
          </span>
          <div className="smd-damage-bar">
            <i style={{ width: `${damageWidth}%` }} />
          </div>
        </div>
      </div>

      <div className="smd-items-block">
        <div className="smd-stat-strip">
          <span className="smd-stat-pill" title="补刀">
            <span className="smd-stat-icon" style={{ WebkitMaskImage: 'url(/fe/lol-match-history/icon_minions.png)' }} />
            {cs}
          </span>
          <span className="smd-stat-pill smd-stat-gold" title="金币">
            <span className="smd-stat-icon" style={{ WebkitMaskImage: 'url(/fe/lol-match-history/icon_gold.png)' }} />
            {formatK(stats.goldEarned)}
          </span>
        </div>
        <div className="smd-items">
          {items.map((id, idx) => (
            <div key={idx} className="smd-item">
              {id > 0 && <img src={getItemIcon(id)} alt="" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export interface MatchDetailModalProps {
  open: boolean
  onClose: () => void
  gameId: number | null
  focusPuuid?: string
}

export function MatchDetailModal({ open, onClose, gameId, focusPuuid }: MatchDetailModalProps) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<MatchDetail | null>(null)
  const [rankMap, setRankMap] = useState<Map<string, RankInfo>>(new Map())
  const [iconMaps, setIconMaps] = useState<IconMaps>({
    spells: new Map(),
    perks: new Map(),
    perkStyles: new Map(),
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [playerNotes, setPlayerNotes] = useState<Record<string, PlayerNote>>(() => store.get('playerNotes'))
  const [playerNotesEnabled, setPlayerNotesEnabled] = useState(store.get('playerNotesEnabled'))
  const [editingNotePlayer, setEditingNotePlayer] = useState<{ puuid: string; displayName: string } | null>(null)
  const [tab, setTab] = useState<DetailTab>('overview')
  const [timeline, setTimeline] = useState<TimelineResult | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)

  // 备注 / 黑名单变化时同步徽标；总开关关闭时不显示任何提示
  useEffect(() => {
    const unsubNotes = store.onChange('playerNotes', setPlayerNotes)
    const unsubEnabled = store.onChange('playerNotesEnabled', setPlayerNotesEnabled)
    return () => {
      unsubNotes()
      unsubEnabled()
    }
  }, [])

  const handleEditNote = useCallback((puuid: string, displayName: string) => {
    if (!puuid) return
    setEditingNotePlayer({ puuid, displayName })
  }, [])

  useEffect(() => {
    if (!playerNotesEnabled) setEditingNotePlayer(null)
  }, [playerNotesEnabled])

  useEffect(() => {
    if (!open || !gameId) return

    let cancelled = false
    setLoading(true)
    setError('')
    setDetail(null)
    setRankMap(new Map())

    lcu.getMatchDetail(gameId)
      .then(async (data) => {
        const rankEntries = await Promise.all(data.participantIdentities.map(async (identity) => {
          const ranked = await lcu.getRankedStats(identity.player.puuid).catch(() => null)
          const participant = data.participants.find((p) => p.participantId === identity.participantId)
          return [identity.player.puuid, parseRankInfo(ranked, participant?.highestAchievedSeasonTier ?? '')] as const
        }))
        if (!cancelled) setDetail(data)
        if (!cancelled) setRankMap(new Map(rankEntries))
      })
      .catch(() => {
        if (!cancelled) setError(t('matchDetail.error'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, gameId, t])

  // 时间轴独立加载，不阻塞概览渲染；关闭后忽略过期结果
  useEffect(() => {
    if (!open || !gameId) {
      setTimeline(null)
      setTimelineLoading(false)
      setTab('overview')
      return
    }

    let cancelled = false
    setTimeline(null)
    setTimelineLoading(true)
    setTab('overview')

    loadTimelineData(gameId)
      .then((result) => {
        if (!cancelled) setTimeline(result)
      })
      .catch(() => {
        if (!cancelled) setTimeline({ source: 'none', details: null, events: [] })
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, gameId])

  useEffect(() => {
    if (!open) return

    let cancelled = false

    Promise.all([
      lcu.getSummonerSpells().catch(() => []),
      lcu.getPerks().catch(() => []),
      lcu.getPerkStyles().catch(() => ({ styles: [] })),
    ]).then(([spells, perks, perkStyles]) => {
      if (cancelled) return
      setIconMaps({
        spells: new Map(spells.map((spell) => [spell.id, spell.iconPath.toLowerCase()])),
        perks: new Map(perks.map((perk) => [perk.id, perk.iconPath.toLowerCase()])),
        perkStyles: new Map(perkStyles.styles.map((style) => [style.id, style.iconPath.toLowerCase()])),
      })
    })

    return () => {
      cancelled = true
    }
  }, [open])

  const identityMap = useMemo(() => {
    const map = new Map<number, ParticipantIdentity>()
    detail?.participantIdentities.forEach((identity) => map.set(identity.participantId, identity))
    return map
  }, [detail])

  const teams = useMemo(() => {
    const team100 = detail?.participants.filter((p) => p.teamId === 100) ?? []
    const team200 = detail?.participants.filter((p) => p.teamId === 200) ?? []
    return { team100, team200 }
  }, [detail])

  const maxDamage = useMemo(() => {
    return Math.max(0, ...(detail?.participants.map((p) => p.stats.totalDamageDealtToChampions) ?? [0]))
  }, [detail])

  const players = useMemo<DetailPlayer[]>(() => {
    return (detail?.participants ?? []).map((participant) => {
      const identity = identityMap.get(participant.participantId)?.player
      return {
        participantId: participant.participantId,
        name: identity
          ? `${identity.gameName}#${identity.tagLine}`
          : t('matchDetail.playerFallback', { id: participant.participantId }),
        championId: participant.championId,
        teamId: participant.teamId,
      }
    })
  }, [detail, identityMap, t])

  const itemPaths = useMemo(() => groupItemPaths(timeline?.events ?? []), [timeline])
  const skillOrders = useMemo(() => groupSkillOrders(timeline?.events ?? []), [timeline])
  const hasTimelineEvents = useMemo(
    () => (timeline?.events ?? []).some((event) => event.kind !== 'item' && event.kind !== 'skill'),
    [timeline],
  )
  const teamOverview = useMemo(
    () => buildTeamOverview(timeline?.details, detail),
    [timeline, detail],
  )

  const tabs = useMemo(() => {
    const items: { id: DetailTab; label: string }[] = [
      { id: 'overview', label: t('matchDetail.tab.overview') },
    ]
    if (hasTimelineEvents) {
      items.push({ id: 'timeline', label: t('matchDetail.tab.timeline') })
    }
    if (itemPaths.size > 0) {
      items.push({ id: 'items', label: t('matchDetail.tab.items') })
    }
    if (skillOrders.size > 0) {
      items.push({ id: 'skills', label: t('matchDetail.tab.skills') })
    }
    if (teamOverview) {
      items.push({ id: 'teams', label: t('matchDetail.tab.teams') })
    }
    return items
  }, [t, hasTimelineEvents, itemPaths, skillOrders, teamOverview])

  // 数据刷新后当前页签可能已不可用，回退概览而不是渲染空表
  const activeTab = tabs.some((item) => item.id === tab) ? tab : 'overview'

  const renderTeam = (teamId: 100 | 200, participants: Participant[], isRed: boolean) => {
    const team = detail?.teams.find((t) => t.teamId === teamId)
    const won = team?.win === 'Win' || participants.some((p) => p.stats.win)

    return (
      <section className={`smd-team ${isRed ? 'smd-team--red' : 'smd-team--blue'} ${won ? 'smd-win' : 'smd-loss'}`}>
        <div className={`smd-team-header ${isRed ? 'smd-team-header--red' : 'smd-team-header--blue'}`}>
          <div>
            <strong>{teamId === 100 ? t('matchDetail.team.blue') : t('matchDetail.team.red')}</strong>
            <span>{won ? t('common.win') : t('common.loss')}</span>
          </div>
          <TeamSummary team={team} participants={participants} isRed={isRed} />
        </div>
        <div className="smd-team-list">
          {participants.map((participant) => {
            const identity = getIdentity(identityMap, participant.participantId)
            return (
              <ParticipantRow
                key={participant.participantId}
                participant={participant}
                identity={identity}
                maxDamage={maxDamage}
                highlighted={Boolean(focusPuuid && identity?.puuid === focusPuuid)}
                isRed={isRed}
                rankInfo={identity ? rankMap.get(identity.puuid) : undefined}
                iconMaps={iconMaps}
                note={playerNotesEnabled && identity?.puuid ? playerNotes[identity.puuid] : undefined}
                onEditNote={playerNotesEnabled ? handleEditNote : undefined}
              />
            )
          })}
        </div>
      </section>
    )
  }

  return (
    <>
      <Modal open={open} onClose={onClose} width={1240} height={640}>
      <div className="smd-container">
        <div className="smd-header">
          <div className="smd-title-line">
            <span className="smd-title">{t('matchDetail.reportTitle')}</span>
            {detail && (
              <div className="smd-meta">
                <span>{getQueueName(detail.queueId)}</span>
                <span>{getMapName(detail.mapId)}</span>
                <span>{t('matchDetail.duration', { duration: formatDuration(detail.gameDuration) })}</span>
                <span>{t('matchDetail.start', { time: formatStartTime(detail.gameCreation) })}</span>
                <span>{formatDate(detail.gameCreation)}</span>
                <span>ID:{detail.gameId}</span>
              </div>
            )}
          </div>
        </div>

        <div className="smd-body">
          {loading && <div className="smd-empty">{t('matchDetail.loading')}</div>}
          {error && <div className="smd-empty smd-error">{error}</div>}
          {!loading && !error && detail && (
            <>
              {tabs.length > 1 ? (
                <div className="smd-tab-bar">
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`smd-tab${activeTab === item.id ? ' smd-tab--active' : ''}`}
                      onClick={() => setTab(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                  {timelineLoading ? (
                    <span className="smd-tab-loading">{t('matchDetail.timeline.loading')}</span>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'overview' ? (
                <div className="smd-teams">
                  <div className="smd-team-divider" aria-hidden="true" />
                  {renderTeam(100, teams.team100, false)}
                  {renderTeam(200, teams.team200, true)}
                </div>
              ) : null}

              {activeTab === 'timeline' && timeline ? (
                <div className="smd-tab-panel">
                  <MatchTimelineSection
                    events={timeline.events}
                    players={players}
                    source={timeline.source === 'sgp' ? 'sgp' : 'lcu'}
                  />
                </div>
              ) : null}

              {activeTab === 'items' ? (
                <div className="smd-tab-panel">
                  <ItemPathSection events={timeline?.events ?? []} players={players} />
                </div>
              ) : null}

              {activeTab === 'skills' ? (
                <div className="smd-tab-panel">
                  <SkillOrderSection events={timeline?.events ?? []} players={players} />
                </div>
              ) : null}

              {activeTab === 'teams' ? (
                <div className="smd-tab-panel">
                  <TeamOverviewSection overview={teamOverview} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      </Modal>
      <PlayerNoteEditor
        open={Boolean(editingNotePlayer)}
        onClose={() => setEditingNotePlayer(null)}
        player={editingNotePlayer}
      />
    </>
  )
}
