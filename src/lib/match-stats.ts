/**
 * 对局数据聚合（纯函数）
 *
 * 输入 SGP SUMMARY 结果，输出看板所需的统计视图。
 * 不发起请求、不读写 store，便于玩家标签等后续功能复用。
 */

import type { SgpGameSummaryLol, SgpParticipantLol } from '@/types/sgp'
import {
  calculateSonaPlayerStrengthScore,
  filterSonaStrengthGamesByQueue,
} from '@/lib/player-strength-score'

export type DashboardRole =
  | 'TOP'
  | 'JUNGLE'
  | 'MIDDLE'
  | 'BOTTOM'
  | 'UTILITY'
  | 'UNKNOWN'

export interface DashboardTrendPoint {
  /** YYYY-MM-DD（本地时区） */
  date: string
  games: number
  wins: number
  /** 0-100 */
  winRate: number
}

export interface DashboardChampionStat {
  championId: number
  games: number
  wins: number
  /** 0-100 */
  winRate: number
  kda: number
}

export interface DashboardRoleStat {
  role: DashboardRole
  games: number
  wins: number
  winRate: number
  kda: number
}

export interface DashboardQueueStat {
  queueId: number
  games: number
  wins: number
  winRate: number
}

export interface DashboardSummary {
  totalGames: number
  wins: number
  losses: number
  /** 0-100 */
  winRate: number
  avgKda: number
  /** 3.0-16.0，来自 calculateSonaPlayerStrengthScore；样本不足时为 null */
  avgScore: number | null
  currentStreak: { type: 'win' | 'loss'; count: number } | null
  championPool: DashboardChampionStat[]
  roleStats: DashboardRoleStat[]
  queueStats: DashboardQueueStat[]
  trend: DashboardTrendPoint[]
}

interface ResolvedGame {
  game: SgpGameSummaryLol
  participant: SgpParticipantLol
  creation: number
}

interface MutableStat {
  games: number
  wins: number
  kdaTotal: number
}

const ROLE_ORDER: DashboardRole[] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN']
const MAX_TREND_DAYS = 30

/** 汇总近期战绩；队列过滤与评分样本清洗均复用既有实现 */
export function summarizeMatchHistory(
  games: SgpGameSummaryLol[],
  puuid: string,
  options: { queueId?: number } = {},
): DashboardSummary {
  const queueId = options.queueId ?? 0
  const filtered = filterSonaStrengthGamesByQueue(games, queueId)
  const resolved = resolveGames(filtered, puuid)

  if (resolved.length === 0) {
    return createEmptySummary()
  }

  // 显式按开局时间倒序，后续连胜/评分都不再依赖服务端顺序
  resolved.sort((a, b) => b.creation - a.creation)

  const championStats = new Map<number, MutableStat>()
  const roleStats = new Map<DashboardRole, MutableStat>()
  const queueStats = new Map<number, MutableStat>()
  const trendStats = new Map<string, { games: number; wins: number }>()

  let wins = 0
  let kdaTotal = 0

  for (const item of resolved) {
    const { participant, game } = item
    const win = Boolean(participant.win)
    const kda = getParticipantKda(participant)

    if (win) wins++
    kdaTotal += kda

    const championId = safeNumber(participant.championId)
    if (championId > 0) {
      accumulate(championStats, championId, win, kda)
    }

    accumulate(roleStats, inferDashboardRole(participant), win, kda)

    const gameQueueId = safeNumber(game.json.queueId)
    accumulate(queueStats, gameQueueId, win, kda)

    const date = formatLocalDate(item.creation)
    if (date) {
      const point = trendStats.get(date) ?? { games: 0, wins: 0 }
      point.games++
      if (win) point.wins++
      trendStats.set(date, point)
    }
  }

  const totalGames = resolved.length
  const strength = calculateSonaPlayerStrengthScore(resolved.map((item) => item.game), puuid)

  return {
    totalGames,
    wins,
    losses: totalGames - wins,
    winRate: toPercent(wins, totalGames),
    avgKda: kdaTotal / totalGames,
    avgScore: strength && Number.isFinite(strength.score) ? strength.score : null,
    currentStreak: calculateCurrentStreak(resolved),
    championPool: Array.from(championStats.entries())
      .map(([championId, stat]) => ({
        championId,
        games: stat.games,
        wins: stat.wins,
        winRate: toPercent(stat.wins, stat.games),
        kda: stat.kdaTotal / stat.games,
      }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate || a.championId - b.championId),
    roleStats: Array.from(roleStats.entries())
      .map(([role, stat]) => ({
        role,
        games: stat.games,
        wins: stat.wins,
        winRate: toPercent(stat.wins, stat.games),
        kda: stat.kdaTotal / stat.games,
      }))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)),
    queueStats: Array.from(queueStats.entries())
      .map(([gameQueueId, stat]) => ({
        queueId: gameQueueId,
        games: stat.games,
        wins: stat.wins,
        winRate: toPercent(stat.wins, stat.games),
      }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate),
    trend: Array.from(trendStats.entries())
      .map(([date, stat]) => ({
        date,
        games: stat.games,
        wins: stat.wins,
        winRate: toPercent(stat.wins, stat.games),
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-MAX_TREND_DAYS),
  }
}

function resolveGames(games: SgpGameSummaryLol[], puuid: string): ResolvedGame[] {
  const resolved: ResolvedGame[] = []

  for (const game of games) {
    const participant = game.json.participants?.find((item) => item.puuid === puuid)
    if (!participant) continue

    const creation = safeNumber(game.json.gameCreation)
    resolved.push({ game, participant, creation })
  }

  return resolved
}

function accumulate<K>(
  map: Map<K, MutableStat>,
  key: K,
  win: boolean,
  kda: number,
) {
  const stat = map.get(key) ?? { games: 0, wins: 0, kdaTotal: 0 }
  stat.games++
  if (win) stat.wins++
  stat.kdaTotal += kda
  map.set(key, stat)
}

function calculateCurrentStreak(resolved: ResolvedGame[]): DashboardSummary['currentStreak'] {
  const latest = resolved[0]
  if (!latest) return null

  const type: 'win' | 'loss' = latest.participant.win ? 'win' : 'loss'
  let count = 0

  for (const item of resolved) {
    const itemType: 'win' | 'loss' = item.participant.win ? 'win' : 'loss'
    if (itemType !== type) break
    count++
  }

  return { type, count }
}

function inferDashboardRole(participant: SgpParticipantLol): DashboardRole {
  const position = String(
    participant.teamPosition || participant.individualPosition || participant.lane || '',
  ).toUpperCase()

  if (position === 'TOP') return 'TOP'
  if (position === 'JUNGLE') return 'JUNGLE'
  if (position === 'MIDDLE' || position === 'MID') return 'MIDDLE'
  if (position === 'BOTTOM' || position === 'BOT') return 'BOTTOM'
  if (position === 'UTILITY' || position === 'SUPPORT') return 'UTILITY'
  return 'UNKNOWN'
}

/** challenges 可能缺失，回退到本地 KDA 计算 */
function getParticipantKda(participant: SgpParticipantLol): number {
  const challengeKda = participant.challenges?.kda
  if (typeof challengeKda === 'number' && Number.isFinite(challengeKda) && challengeKda > 0) {
    return challengeKda
  }

  const kills = safeNumber(participant.kills)
  const deaths = safeNumber(participant.deaths)
  const assists = safeNumber(participant.assists)
  return (kills + assists) / Math.max(deaths, 1)
}

function formatLocalDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''

  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function createEmptySummary(): DashboardSummary {
  return {
    totalGames: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgKda: 0,
    avgScore: null,
    currentStreak: null,
    championPool: [],
    roleStats: [],
    queueStats: [],
    trend: [],
  }
}

function toPercent(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}
