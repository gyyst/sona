/**
 * 对位克制数据（OP.GG counters）
 *
 * 只查询我方英雄，最多 5 个请求；独立 8 秒超时，失败静默降级。
 * 结果按 `championId + position + mode + tier` 缓存 5 分钟，进行中的请求复用同一个 Promise。
 */

import { logger } from '@/index'
import { mapOpggMatchups } from '@/lib/opgg-position'
import { opggApi, type OpggMode, type OpggPosition, type OpggTier } from '@/lib/opgg-api'

export interface PositionedChampion {
  championId: number
  position: OpggPosition
}

export interface MatchupEntry {
  position: OpggPosition
  allyChampionId: number
  enemyChampionId: number
  /** 我方英雄对该敌方英雄的胜率 0-1 */
  winRate: number
  /** 样本场次 */
  play: number
}

export interface TeamMatchupsResult {
  entries: MatchupEntry[]
  /** 我方对位平均胜率 0-1；无数据为 null */
  allyAverageWinRate: number | null
}

const MATCHUP_CACHE_TTL_MS = 5 * 60 * 1000
const MATCHUP_TIMEOUT_MS = 8_000

const POSITION_ORDER: Record<OpggPosition, number> = {
  top: 1,
  jungle: 2,
  mid: 3,
  adc: 4,
  support: 5,
  all: 99,
  none: 99,
}

type ChampionCounters = Map<number, { winRate: number; play: number }>

interface MatchupCacheEntry {
  expiresAt: number
  promise: Promise<ChampionCounters | null>
}

const matchupCache = new Map<string, MatchupCacheEntry>()

/** 清理已过期的缓存项，避免长时间会话中 Map 无限增长 */
function pruneExpiredCache(now: number): void {
  for (const [key, entry] of matchupCache) {
    if (entry.expiresAt <= now) matchupCache.delete(key)
  }
}

function getCacheKey(options: {
  championId: number
  position: OpggPosition
  mode: OpggMode
  tier: OpggTier
}): string {
  return [options.championId, options.position, options.mode, options.tier].join('|')
}

async function loadChampionCounters(options: {
  championId: number
  position: OpggPosition
  mode: OpggMode
  tier: OpggTier
}): Promise<ChampionCounters | null> {
  const key = getCacheKey(options)
  const now = Date.now()
  const cached = matchupCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise

  pruneExpiredCache(now)

  const promise = (async (): Promise<ChampionCounters | null> => {
    try {
      const champion = await opggApi.getChampion({
        id: options.championId,
        region: 'global',
        mode: options.mode,
        tier: options.tier,
        position: options.position,
        timeoutMs: MATCHUP_TIMEOUT_MS,
      })

      if (!('counters' in champion.data) || !Array.isArray(champion.data.counters)) {
        return new Map()
      }

      const counters: ChampionCounters = new Map()
      for (const matchup of mapOpggMatchups(champion.data.counters)) {
        counters.set(matchup.championId, { winRate: matchup.winRate, play: matchup.play })
      }
      return counters
    } catch (err) {
      matchupCache.delete(key)
      logger.warn(
        '[GameAnalysis] OP.GG 对位数据请求失败: championId=%d, position=%s',
        options.championId,
        options.position,
        err,
      )
      return null
    }
  })()

  matchupCache.set(key, { expiresAt: now + MATCHUP_CACHE_TTL_MS, promise })
  return promise
}

/**
 * 按分路匹配双方英雄并查询我方英雄的对位胜率。
 *
 * 非召唤师峡谷对局（大乱斗 / 斗魂等）没有稳定对位，直接返回空结果。
 */
export async function loadTeamMatchups(options: {
  allies: PositionedChampion[]
  enemies: PositionedChampion[]
  mode: OpggMode
  tier: OpggTier
}): Promise<TeamMatchupsResult> {
  if (options.mode !== 'ranked') {
    return { entries: [], allyAverageWinRate: null }
  }

  const enemyByPosition = new Map<OpggPosition, number>()
  for (const enemy of options.enemies) {
    if (enemy.championId <= 0 || enemy.position === 'none' || enemy.position === 'all') continue
    if (!enemyByPosition.has(enemy.position)) enemyByPosition.set(enemy.position, enemy.championId)
  }

  const pairs = options.allies
    .filter((ally) => ally.championId > 0 && ally.position !== 'none' && ally.position !== 'all')
    .map((ally) => ({ ally, enemyChampionId: enemyByPosition.get(ally.position) ?? 0 }))
    .filter((pair) => pair.enemyChampionId > 0)

  const settled = await Promise.allSettled(pairs.map(async ({ ally, enemyChampionId }) => {
    const counters = await loadChampionCounters({
      championId: ally.championId,
      position: ally.position,
      mode: options.mode,
      tier: options.tier,
    })
    if (!counters) return null

    const counter = counters.get(enemyChampionId)
    if (!counter) return null

    return {
      position: ally.position,
      allyChampionId: ally.championId,
      enemyChampionId,
      winRate: counter.winRate,
      play: counter.play,
    } satisfies MatchupEntry
  }))

  const entries: MatchupEntry[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) entries.push(result.value)
  }
  entries.sort((a, b) => (POSITION_ORDER[a.position] ?? 99) - (POSITION_ORDER[b.position] ?? 99))

  const allyAverageWinRate = entries.length > 0
    ? entries.reduce((sum, entry) => sum + entry.winRate, 0) / entries.length
    : null

  return { entries, allyAverageWinRate }
}
