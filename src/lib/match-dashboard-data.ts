/**
 * 对局数据看板查询
 *
 * 负责分页拉取 SGP 战绩、短期缓存与并发去重。
 * SGP 失败时的 LCU 回退由 lcu.getSgpMatchHistory 内部处理，这里不重复实现。
 */

import { lcu, queueIdToTag } from '@/lib/lcu'
import { sleep, withTimeout } from '@/lib/utils'
import type { SgpGameSummaryLol } from '@/types/sgp'

export interface DashboardQueryOptions {
  puuid: string
  /** 0 = 全部模式 */
  queueId: number
  maxGames: number
  /** 手动刷新时跳过缓存读取（仍复用进行中的请求） */
  force?: boolean
}

export interface DashboardFetchResult {
  games: SgpGameSummaryLol[]
  /** 是否因 maxGames 上限而截断（可能还有更多对局） */
  truncated: boolean
  /** 是否发生 SGP → LCU 原生战绩回退；回退数据字段不完整 */
  fallback: boolean
}

const PAGE_SIZE = 20
const PAGE_DELAY_MS = 50
const PAGE_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  expiresAt: number
  value: DashboardFetchResult
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<DashboardFetchResult>>()

export async function fetchDashboardMatches(
  options: DashboardQueryOptions,
): Promise<DashboardFetchResult> {
  const queueId = Number.isFinite(options.queueId) ? options.queueId : 0
  const maxGames = Math.max(1, Math.floor(options.maxGames))
  const key = `${options.puuid}|${queueId}|${maxGames}`

  if (!options.force) {
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }
  }

  const pending = inflight.get(key)
  if (pending) return pending

  const task = fetchPages(options.puuid, queueId, maxGames)
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value })
      return value
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, task)
  return task
}

async function fetchPages(
  puuid: string,
  queueId: number,
  maxGames: number,
): Promise<DashboardFetchResult> {
  const tag = queueIdToTag(queueId) || undefined
  const games: SgpGameSummaryLol[] = []
  let startIndex = 0
  let hasMore = true
  let fallback = false

  while (games.length < maxGames && hasMore) {
    const count = Math.min(PAGE_SIZE, maxGames - games.length)
    const resp = await withTimeout(
      lcu.getSgpMatchHistory(puuid, { startIndex, count, tag }),
      PAGE_TIMEOUT_MS,
      `getSgpMatchHistory(${startIndex}, ${count})`,
    )
    const page = resp.games ?? []

    if (page.some(isFallbackGame)) fallback = true
    games.push(...page)

    // 服务端返回不足请求数量，说明已经到底
    if (page.length < count) {
      hasMore = false
      break
    }

    startIndex += page.length
    if (games.length < maxGames) {
      await sleep(PAGE_DELAY_MS)
    }
  }

  return {
    games: games.slice(0, maxGames),
    truncated: hasMore && games.length >= maxGames,
    fallback,
  }
}

/**
 * 识别 getSgpMatchHistory 的 LCU 回退数据。
 * 回退映射会把所有参与者的 championName 固定为空串，正常 SGP 数据不会出现。
 */
function isFallbackGame(game: SgpGameSummaryLol): boolean {
  const participants = game.json.participants ?? []
  if (participants.length === 0) return game.metadata?.data_version === ''
  return participants.every((participant) => !participant.championName)
}
