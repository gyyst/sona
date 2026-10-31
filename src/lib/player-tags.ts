/**
 * 玩家标签计算（纯函数）
 *
 * 基于近期 SGP 战绩生成可解释的玩家标签：
 * - MVP：连胜 / 连败、一筋、位置偏好
 * - 第二阶段（默认关闭）：疲劳、大乱斗胜率队
 *
 * 约束：
 * - 只读取传入的战绩，不发起任何请求；
 * - 先按 gameCreation 倒序，再在时间窗口内统计；
 * - 字段缺失或数据异常时返回空数组 / 跳过该局，不抛异常。
 */

import type { SgpGameSummaryLol, SgpParticipantLol } from '@/types/sgp'
import type { TranslationKey } from '@/i18n/locales'
import { shouldSkipSonaStrengthGame } from '@/lib/player-strength-score'
import { getChampionById } from '@/lib/assets'

export type PlayerTagId =
  | 'winStreak'
  | 'lossStreak'
  | 'oneTrick'
  | 'roleMain'
  | 'fatigued'
  | 'aramStack'

export type PlayerTagTone = 'positive' | 'negative' | 'neutral'

export type PlayerTagRole = 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY'

export interface PlayerTag {
  id: PlayerTagId
  /** 连胜/连败场次、一筋/位置偏好的样本数 */
  count?: number
  championId?: number
  role?: PlayerTagRole
  tone: PlayerTagTone
}

export interface PlayerTagTeamPlayer {
  puuid: string
  /** 兼容 0-1 与 0-100 两种口径 */
  winRate: number
  games: number
}

export interface PlayerTagTeamContext {
  players: PlayerTagTeamPlayer[]
  sameParty: boolean
}

export interface PlayerTagInput {
  games: SgpGameSummaryLol[]
  puuid: string
  /** 是否计算第二阶段标签（疲劳 / 大乱斗胜率队），默认 false */
  includeAdvanced?: boolean
  /** 当前时间，仅用于疲劳标签；测试可注入 */
  now?: number
  /** 统计窗口，默认 20 场 */
  windowSize?: number
  /** 第二阶段大乱斗胜率队需要的队伍上下文 */
  team?: PlayerTagTeamContext
}

/** 展示标签所需的最小样本；低于该值不生成任何标签 */
const MIN_TOTAL_GAMES = 3
/** 一筋 / 位置偏好的最小样本 */
const MIN_SPECIALIZATION_GAMES = 10
/** 一筋的最低英雄占比 */
const ONE_TRICK_RATIO = 0.6
/** 位置偏好的最低位置占比 */
const ROLE_MAIN_RATIO = 0.5
const DEFAULT_WINDOW_SIZE = 20
const MAX_TAGS = 3

const FATIGUE_WINDOW = 6
const FATIGUE_SPAN_MS = 4 * 60 * 60 * 1000
const FATIGUE_RECENT_MS = 30 * 60 * 1000
const ARAM_STACK_MIN_PLAYERS = 3
const ARAM_STACK_MIN_GAMES = 10
const ARAM_STACK_MIN_WIN_RATE = 60

const TAG_PRIORITY: Record<PlayerTagId, number> = {
  lossStreak: 0,
  winStreak: 1,
  oneTrick: 2,
  roleMain: 3,
  aramStack: 4,
  fatigued: 5,
}

interface ValidGame {
  game: SgpGameSummaryLol
  participant: SgpParticipantLol
  createdAt: number
}

interface DominantEntry<T> {
  value: T
  count: number
}

/** 收集窗口内的有效对局，并按 gameCreation 从新到旧排序 */
function collectValidGames(input: PlayerTagInput): ValidGame[] {
  const games = Array.isArray(input.games) ? input.games : []
  const windowSize = Math.max(1, Math.floor(input.windowSize ?? DEFAULT_WINDOW_SIZE))
  const valid: ValidGame[] = []

  for (const game of games) {
    const participants = game?.json?.participants
    if (!Array.isArray(participants)) continue

    const participant = participants.find((item) => item?.puuid === input.puuid)
    if (!participant) continue

    try {
      if (shouldSkipSonaStrengthGame(game, input.puuid)) continue
    } catch {
      // 结构异常的战绩直接跳过，避免影响其他对局
      continue
    }

    const createdAt = Number(game.json.gameCreation)
    valid.push({
      game,
      participant,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    })
  }

  valid.sort((a, b) => b.createdAt - a.createdAt)
  return valid.slice(0, windowSize)
}

function findDominant<T>(counts: Map<T, number>): DominantEntry<T> | null {
  let best: DominantEntry<T> | null = null
  counts.forEach((count, value) => {
    if (!best || count > best.count) {
      best = { value, count }
    }
  })
  return best
}

function normalizeRole(raw: string | null | undefined): PlayerTagRole | null {
  if (typeof raw !== 'string') return null
  switch (raw.trim().toUpperCase()) {
    case 'TOP':
      return 'TOP'
    case 'JUNGLE':
      return 'JUNGLE'
    case 'MIDDLE':
    case 'MID':
      return 'MIDDLE'
    case 'BOTTOM':
    case 'BOT':
    case 'ADC':
      return 'BOTTOM'
    case 'UTILITY':
    case 'SUPPORT':
      return 'UTILITY'
    default:
      return null
  }
}

/** 位置优先取 teamPosition，其次 individualPosition / lane */
function resolveParticipantRole(participant: SgpParticipantLol): PlayerTagRole | null {
  return normalizeRole(participant.teamPosition)
    ?? normalizeRole(participant.individualPosition)
    ?? normalizeRole(participant.lane)
}

function collectStreakTag(valid: ValidGame[]): PlayerTag | null {
  if (valid.length < MIN_TOTAL_GAMES) return null

  const latestWin = valid[0].participant.win
  if (typeof latestWin !== 'boolean') return null
  let streak = 0
  for (const item of valid) {
    if (item.participant.win !== latestWin) break
    streak++
  }

  if (streak < MIN_TOTAL_GAMES) return null
  return latestWin
    ? { id: 'winStreak', count: streak, tone: 'positive' }
    : { id: 'lossStreak', count: streak, tone: 'negative' }
}

function collectOneTrickTag(valid: ValidGame[]): PlayerTag | null {
  if (valid.length < MIN_SPECIALIZATION_GAMES) return null

  const counts = new Map<number, number>()
  for (const { participant } of valid) {
    const championId = Number(participant.championId)
    if (!Number.isFinite(championId) || championId <= 0) continue
    counts.set(championId, (counts.get(championId) ?? 0) + 1)
  }

  const dominant = findDominant(counts)
  if (!dominant) return null
  if (dominant.count < MIN_SPECIALIZATION_GAMES) return null
  if (dominant.count / valid.length < ONE_TRICK_RATIO) return null

  return {
    id: 'oneTrick',
    count: dominant.count,
    championId: dominant.value,
    tone: 'neutral',
  }
}

function collectRoleMainTag(valid: ValidGame[]): PlayerTag | null {
  if (valid.length < MIN_SPECIALIZATION_GAMES) return null

  const counts = new Map<PlayerTagRole, number>()
  for (const { participant } of valid) {
    const role = resolveParticipantRole(participant)
    if (!role) continue
    counts.set(role, (counts.get(role) ?? 0) + 1)
  }

  const dominant = findDominant(counts)
  if (!dominant) return null
  if (dominant.count < MIN_SPECIALIZATION_GAMES) return null
  if (dominant.count / valid.length < ROLE_MAIN_RATIO) return null

  return {
    id: 'roleMain',
    count: dominant.count,
    role: dominant.value,
    tone: 'neutral',
  }
}

function isAramLike(game: SgpGameSummaryLol): boolean {
  const mode = typeof game.json.gameMode === 'string' ? game.json.gameMode.toUpperCase() : ''
  return mode === 'ARAM' || game.json.mapId === 12
}

function normalizeWinRate(winRate: number): number {
  if (!Number.isFinite(winRate)) return 0
  return winRate > 0 && winRate <= 1 ? winRate * 100 : winRate
}

/** 第二阶段：疲劳 / 大乱斗胜率队，默认不计算 */
function collectAdvancedTags(input: PlayerTagInput, valid: ValidGame[]): PlayerTag[] {
  const tags: PlayerTag[] = []
  const now = Number.isFinite(input.now) ? input.now as number : Date.now()

  if (input.team?.sameParty && valid[0] && isAramLike(valid[0].game)) {
    const players = Array.isArray(input.team.players) ? input.team.players : []
    const qualified = players.filter((player) => {
      return player.games >= ARAM_STACK_MIN_GAMES
        && normalizeWinRate(player.winRate) >= ARAM_STACK_MIN_WIN_RATE
    }).length
    if (qualified >= ARAM_STACK_MIN_PLAYERS) {
      tags.push({ id: 'aramStack', count: qualified, tone: 'positive' })
    }
  }

  if (valid.length >= FATIGUE_WINDOW) {
    const recent = valid.slice(0, FATIGUE_WINDOW)
    const latest = recent[0].createdAt
    const oldest = recent[recent.length - 1].createdAt
    if (
      latest > 0
      && oldest > 0
      && now - latest <= FATIGUE_RECENT_MS
      && latest - oldest <= FATIGUE_SPAN_MS
    ) {
      tags.push({ id: 'fatigued', count: recent.length, tone: 'negative' })
    }
  }

  return tags
}

/**
 * 计算玩家标签。
 *
 * 返回顺序固定：连败 > 连胜 > 一筋 > 位置偏好 > 胜率队 > 疲劳，最多 3 个。
 * 有效样本不足 3 场时返回空数组。
 */
export function computePlayerTags(input: PlayerTagInput): PlayerTag[] {
  if (!input?.puuid) return []

  const valid = collectValidGames(input)
  if (valid.length < MIN_TOTAL_GAMES) return []

  const candidates: Array<PlayerTag | null> = [
    collectStreakTag(valid),
    collectOneTrickTag(valid),
    collectRoleMainTag(valid),
  ]

  if (input.includeAdvanced) {
    candidates.push(...collectAdvancedTags(input, valid))
  }

  return candidates
    .filter((tag): tag is PlayerTag => tag != null)
    .sort((a, b) => TAG_PRIORITY[a.id] - TAG_PRIORITY[b.id])
    .slice(0, MAX_TAGS)
}

export type PlayerTagTranslate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string

const ROLE_LABEL_KEYS: Record<PlayerTagRole, TranslationKey> = {
  TOP: 'opgg.position.top',
  JUNGLE: 'opgg.position.jungle',
  MIDDLE: 'opgg.position.mid',
  BOTTOM: 'opgg.position.adc',
  UTILITY: 'opgg.position.support',
}

/** 将标签格式化为当前语言的短文本（注入与 React 共用） */
export function formatPlayerTag(tag: PlayerTag, t: PlayerTagTranslate): string {
  switch (tag.id) {
    case 'winStreak':
      return t('playerTags.winStreak', { count: tag.count ?? 0 })
    case 'lossStreak':
      return t('playerTags.lossStreak', { count: tag.count ?? 0 })
    case 'oneTrick': {
      // 优先使用客户端语言下的英雄名，避免 SGP 英文名与中文界面混排。
      const champion = tag.championId ? getChampionById(tag.championId)?.name?.trim() : ''
      return champion
        ? t('playerTags.oneTrick', { champion })
        : t('playerTags.oneTrickUnknown')
    }
    case 'roleMain': {
      const role = tag.role ? t(ROLE_LABEL_KEYS[tag.role]) : '?'
      return t('playerTags.roleMain', { role })
    }
    case 'aramStack':
      return t('playerTags.aramStack')
    case 'fatigued':
      return t('playerTags.fatigued')
    default:
      return tag.id
  }
}
