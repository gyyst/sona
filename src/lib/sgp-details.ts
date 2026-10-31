/**
 * SGP DETAILS / LCU timeline 归一化
 *
 * SGP DETAILS 是装备购买、技能加点、守卫事件的唯一稳定来源；
 * LCU `/lol-match-history/v1/game-timelines` 只稳定提供击杀/目标/建筑事件，
 * 作为 DETAILS 不可用时的降级数据源。
 *
 * 本模块只做纯数据处理：所有字段按可选处理，缺失时跳过事件而不是抛异常。
 */

import type { SgpGameDetailsLol, SgpTimelineEventLol, SgpTimelineFrameLol } from '@/types/sgp'
import type { MatchDetail } from '@/types/lcu'

// ==================== 归一化模型 ====================

export type TimelineEventKind = 'kill' | 'item' | 'skill' | 'objective' | 'building' | 'ward' | 'other'

export interface TimelinePosition {
  x: number
  y: number
}

export interface NormalizedTimelineEvent {
  kind: TimelineEventKind
  type: string
  timestamp: number
  participantId?: number
  killerId?: number
  victimId?: number
  creatorId?: number
  assistingParticipantIds?: number[]
  itemId?: number
  beforeId?: number
  afterId?: number
  /** 1-4 对应 Q/W/E/R */
  skillSlot?: number
  levelUpType?: string
  level?: number
  monsterType?: string
  monsterSubType?: string
  buildingType?: string
  towerType?: string
  laneType?: string
  teamId?: number
  killType?: string
  wardType?: string
  bounty?: number
  shutdownBounty?: number
  killStreakLength?: number
  goldGain?: number
  winningTeam?: number
  position?: TimelinePosition
  raw: unknown
}

// ==================== 基础字段读取 ====================

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readId(value: unknown): number | undefined {
  const numeric = readNumber(value)
  return numeric != null && numeric > 0 ? numeric : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function readPosition(value: unknown): TimelinePosition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { x?: unknown; y?: unknown }
  const x = readNumber(record.x)
  const y = readNumber(record.y)
  return x != null && y != null ? { x, y } : undefined
}

function readParticipantIds(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.map(readId).filter((id): id is number => id != null)
  return ids.length > 0 ? ids : undefined
}

const EVENT_KIND_BY_TYPE: Record<string, TimelineEventKind> = {
  CHAMPION_KILL: 'kill',
  CHAMPION_SPECIAL_KILL: 'kill',
  ITEM_PURCHASED: 'item',
  ITEM_SOLD: 'item',
  ITEM_UNDO: 'item',
  ITEM_DESTROYED: 'item',
  SKILL_LEVEL_UP: 'skill',
  LEVEL_UP: 'skill',
  ELITE_MONSTER_KILL: 'objective',
  DRAGON_SOUL_GIVEN: 'objective',
  OBJECTIVE_BOUNTY_PRESTART: 'objective',
  BUILDING_KILL: 'building',
  TURRET_PLATE_DESTROYED: 'building',
  WARD_PLACED: 'ward',
  WARD_KILL: 'ward',
}

/** LCU timeline 只映射这些事件，其余忽略 */
const LCU_TIMELINE_EVENT_TYPES = new Set([
  'CHAMPION_KILL',
  'ELITE_MONSTER_KILL',
  'BUILDING_KILL',
])

function normalizeEvent(raw: unknown): NormalizedTimelineEvent | null {
  if (!raw || typeof raw !== 'object') return null

  const source = raw as SgpTimelineEventLol
  const type = readString(source.type)
  if (!type) return null

  const timestamp = readNumber(source.timestamp)
  if (timestamp == null) return null

  return {
    kind: EVENT_KIND_BY_TYPE[type] ?? 'other',
    type,
    timestamp,
    participantId: readId(source.participantId),
    killerId: readId(source.killerId),
    victimId: readId(source.victimId),
    creatorId: readId(source.creatorId),
    assistingParticipantIds: readParticipantIds(source.assistingParticipantIds),
    itemId: readId(source.itemId),
    beforeId: readId(source.beforeId),
    afterId: readId(source.afterId),
    skillSlot: readNumber(source.skillSlot),
    levelUpType: readString(source.levelUpType),
    level: readNumber(source.level),
    monsterType: readString(source.monsterType),
    monsterSubType: readString(source.monsterSubType),
    buildingType: readString(source.buildingType),
    towerType: readString(source.towerType),
    laneType: readString(source.laneType),
    teamId: readId(source.teamId),
    killType: readString(source.killType),
    wardType: readString(source.wardType),
    bounty: readNumber(source.bounty),
    shutdownBounty: readNumber(source.shutdownBounty),
    killStreakLength: readNumber(source.killStreakLength),
    goldGain: readNumber(source.goldGain),
    winningTeam: readNumber(source.winningTeam),
    position: readPosition(source.position),
    raw,
  }
}

// ==================== 事件展平 ====================

/** 展平 SGP DETAILS 的 frames[].events，按时间升序；无 frames 返回空数组 */
export function normalizeSgpDetails(details: SgpGameDetailsLol | null | undefined): NormalizedTimelineEvent[] {
  const frames = details?.json?.frames
  if (!Array.isArray(frames)) return []

  const events: NormalizedTimelineEvent[] = []
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue
    if (!Array.isArray(frame.events)) continue

    for (const raw of frame.events) {
      const event = normalizeEvent(raw)
      if (event) events.push(event)
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp)
  return events
}

/** 展平 LCU game-timelines 的 frames[].events，只保留击杀/目标/建筑 */
export function normalizeLcuTimeline(timeline: unknown): NormalizedTimelineEvent[] {
  if (!timeline || typeof timeline !== 'object') return []

  const frames = (timeline as { frames?: unknown }).frames
  if (!Array.isArray(frames)) return []

  const events: NormalizedTimelineEvent[] = []
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue

    const frameRecord = frame as { events?: unknown }
    if (!Array.isArray(frameRecord.events)) continue

    for (const raw of frameRecord.events) {
      if (!raw || typeof raw !== 'object') continue
      const type = readString((raw as { type?: unknown }).type)
      if (!type || !LCU_TIMELINE_EVENT_TYPES.has(type)) continue

      const event = normalizeEvent(raw)
      if (event) events.push(event)
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp)
  return events
}

// ==================== 装备路线 ====================

export type ItemPathAction = 'buy' | 'sell' | 'undo'

export interface ItemPathEntry {
  timestamp: number
  itemId: number
  action: ItemPathAction
  beforeId?: number
  afterId?: number
}

/** 按 participantId 分组装备购买/出售/撤销记录，组内按时间升序 */
export function groupItemPaths(events: NormalizedTimelineEvent[]): Map<number, ItemPathEntry[]> {
  const grouped = new Map<number, ItemPathEntry[]>()

  for (const event of events) {
    if (event.type !== 'ITEM_PURCHASED' && event.type !== 'ITEM_SOLD' && event.type !== 'ITEM_UNDO') continue
    if (event.participantId == null) continue

    // ITEM_UNDO 的 beforeId/afterId 语义随版本略有差异，优先取非零值
    const itemId = event.type === 'ITEM_UNDO'
      ? (event.beforeId ?? event.afterId ?? event.itemId)
      : event.itemId
    if (itemId == null || itemId <= 0) continue

    const action: ItemPathAction = event.type === 'ITEM_PURCHASED'
      ? 'buy'
      : event.type === 'ITEM_SOLD'
        ? 'sell'
        : 'undo'

    const entry: ItemPathEntry = {
      timestamp: event.timestamp,
      itemId,
      action,
      beforeId: event.beforeId,
      afterId: event.afterId,
    }

    const entries = grouped.get(event.participantId)
    if (entries) entries.push(entry)
    else grouped.set(event.participantId, [entry])
  }

  for (const entries of grouped.values()) {
    entries.sort((a, b) => a.timestamp - b.timestamp)
  }

  return grouped
}

// ==================== 技能加点 ====================

export type SkillLetter = 'Q' | 'W' | 'E' | 'R'

const SKILL_LETTERS: Record<number, SkillLetter> = {
  1: 'Q',
  2: 'W',
  3: 'E',
  4: 'R',
}

export interface SkillOrderEntry {
  participantId: number
  order: SkillLetter[]
  timestamps: number[]
}

/** 按 participantId 聚合 SKILL_LEVEL_UP 的加点顺序 */
export function groupSkillOrders(events: NormalizedTimelineEvent[]): Map<number, SkillOrderEntry> {
  const grouped = new Map<number, SkillOrderEntry>()

  for (const event of events) {
    if (event.type !== 'SKILL_LEVEL_UP') continue
    if (event.participantId == null || event.skillSlot == null) continue

    const letter = SKILL_LETTERS[event.skillSlot]
    if (!letter) continue

    let entry = grouped.get(event.participantId)
    if (!entry) {
      entry = { participantId: event.participantId, order: [], timestamps: [] }
      grouped.set(event.participantId, entry)
    }
    entry.order.push(letter)
    entry.timestamps.push(event.timestamp)
  }

  return grouped
}

// ==================== 队伍总览 ====================

export interface TeamOverviewSide {
  kills: number
  gold: number
  dragons: number
  barons: number
  towers: number
  /** 被禁用的英雄 championId；LCU bans 是 unknown[]，只保留合法的正数 ID */
  bans: number[]
}

export interface TeamOverview {
  blue: TeamOverviewSide
  red: TeamOverviewSide
}

type TeamSide = 'blue' | 'red'

function emptySide(): TeamOverviewSide {
  return { kills: 0, gold: 0, dragons: 0, barons: 0, towers: 0, bans: [] }
}

/** LCU `teams[].bans` 是 `unknown[]`，防御式提取正数 championId（-1/0 表示无禁用） */
function readBanChampionIds(bans: unknown): number[] {
  if (!Array.isArray(bans)) return []

  const championIds: number[] = []
  for (const ban of bans) {
    if (!ban || typeof ban !== 'object') continue
    const championId = readId((ban as { championId?: unknown }).championId)
    if (championId != null) championIds.push(championId)
  }
  return championIds
}

function sideOfTeamId(teamId: number | undefined): TeamSide | null {
  if (teamId === 100) return 'blue'
  if (teamId === 200) return 'red'
  return null
}

function oppositeSide(side: TeamSide): TeamSide {
  return side === 'blue' ? 'red' : 'blue'
}

function lastTimelineFrame(frames: SgpTimelineFrameLol[] | undefined): SgpTimelineFrameLol | undefined {
  if (!Array.isArray(frames)) return undefined

  let last: SgpTimelineFrameLol | undefined
  let lastTimestamp = -Infinity
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue
    const timestamp = readNumber(frame.timestamp) ?? 0
    if (timestamp >= lastTimestamp) {
      lastTimestamp = timestamp
      last = frame
    }
  }
  return last
}

/**
 * 构建双方总览
 *
 * 数据优先级：
 * - 击杀/建筑/史诗野怪：LCU 详情 teams/participants 优先，缺失时从 DETAILS 事件累计；
 * - 金币：DETAILS 最后一帧 participantFrames 优先，缺失时用 LCU 详情。
 * 两边都没有数据时返回 null，UI 据此隐藏区块。
 */
export function buildTeamOverview(
  details: SgpGameDetailsLol | null | undefined,
  lcuDetail?: MatchDetail | null,
): TeamOverview | null {
  const events = normalizeSgpDetails(details)
  const frames = details?.json?.frames
  const hasDetails = events.length > 0 || (Array.isArray(frames) && frames.length > 0)
  if (!lcuDetail && !hasDetails) return null

  const teamByParticipant = new Map<number, TeamSide>()
  if (lcuDetail) {
    for (const participant of lcuDetail.participants) {
      const side = sideOfTeamId(participant.teamId)
      if (side) teamByParticipant.set(participant.participantId, side)
    }
  }

  // 缺少参与者队伍信息时按标准 participantId 分配（1-5 蓝方，6-10 红方）
  if (teamByParticipant.size === 0) {
    for (let participantId = 1; participantId <= 10; participantId += 1) {
      teamByParticipant.set(participantId, participantId <= 5 ? 'blue' : 'red')
    }
  }

  const overview: TeamOverview = { blue: emptySide(), red: emptySide() }

  // 击杀
  if (lcuDetail) {
    for (const participant of lcuDetail.participants) {
      const side = teamByParticipant.get(participant.participantId)
      if (side) overview[side].kills += participant.stats.kills
    }
  } else {
    for (const event of events) {
      if (event.type !== 'CHAMPION_KILL' || event.killerId == null) continue
      const side = teamByParticipant.get(event.killerId)
      if (side) overview[side].kills += 1
    }
  }

  // 金币
  const lastFrame = lastTimelineFrame(frames)
  const participantFrames = lastFrame?.participantFrames
  let goldFromFrames = 0
  if (participantFrames && typeof participantFrames === 'object') {
    for (const [key, frame] of Object.entries(participantFrames)) {
      if (!frame || typeof frame !== 'object') continue
      const participantId = readId(frame.participantId) ?? readId(Number(key))
      const side = participantId != null ? teamByParticipant.get(participantId) : undefined
      if (!side) continue
      const gold = readNumber(frame.totalGold) ?? 0
      overview[side].gold += gold
      goldFromFrames += gold
    }
  }

  // 帧数据缺失或全为 0 时用 LCU 详情兜底
  if (goldFromFrames === 0 && lcuDetail) {
    for (const participant of lcuDetail.participants) {
      const side = teamByParticipant.get(participant.participantId)
      if (side) overview[side].gold += participant.stats.goldEarned
    }
  }

  // 史诗野怪 / 建筑 / 禁用
  if (lcuDetail) {
    for (const team of lcuDetail.teams) {
      const side = sideOfTeamId(team.teamId)
      if (!side) continue
      overview[side].dragons = team.dragonKills
      overview[side].barons = team.baronKills
      overview[side].towers = team.towerKills
      overview[side].bans = readBanChampionIds(team.bans)
    }
  } else {
    for (const event of events) {
      if (event.type === 'ELITE_MONSTER_KILL') {
        const killerSide = event.killerId != null ? teamByParticipant.get(event.killerId) : undefined
        const side = killerSide ?? sideOfTeamId(event.teamId)
        if (!side) continue
        if (event.monsterType === 'DRAGON') overview[side].dragons += 1
        else if (event.monsterType === 'BARON_NASHOR') overview[side].barons += 1
        continue
      }

      if (event.type === 'BUILDING_KILL' && event.buildingType === 'TOWER_BUILDING') {
        const killerSide = event.killerId != null ? teamByParticipant.get(event.killerId) : undefined
        const ownerSide = sideOfTeamId(event.teamId)
        const side = killerSide ?? (ownerSide ? oppositeSide(ownerSide) : null)
        if (side) overview[side].towers += 1
      }
    }
  }

  return overview
}
