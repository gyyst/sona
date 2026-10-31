/**
 * 段位 / LP 会话快照
 *
 * LCU ranked 数据只提供当前值，没有可靠的历史 LP 变化来源。
 * 这里在客户端启动时记录一次快照，用「当前值 - 快照值」得到本次会话变化；
 * 跨段位或数据缺失时返回 null，由页面降级展示。
 */

import { logger } from '@/index'
import { lcu } from '@/lib/lcu'

export interface LpSnapshot {
  queueType: string
  tier: string
  division: string
  leaguePoints: number
  capturedAt: number
}

export interface SessionLpChange {
  current: LpSnapshot | null
  initial: LpSnapshot | null
  /** 同段位时的 LP 差值；跨段位或数据缺失时为 null */
  delta: number | null
  /** 当前段位是否已与初始快照不同 */
  rankChanged: boolean
}

const SUPPORTED_QUEUE_TYPES = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'] as const
const READ_CACHE_TTL_MS = 5000

let initialSnapshot: LpSnapshot | null = null
let capturePromise: Promise<void> | null = null
let captureAttempted = false
let currentCache: { value: LpSnapshot | null; at: number } | null = null

/** 记录本次客户端会话的初始段位快照；幂等，已有快照时直接返回 */
export function captureInitialLp(): Promise<void> {
  if (initialSnapshot) return Promise.resolve()
  if (capturePromise) return capturePromise
  // 只允许启动阶段捕获一次：若启动时拿不到排位数据，页面打开时再捕获会把
  // 「页面打开时刻」误当成会话初始值，从而伪造出 0 LP 变化。
  if (captureAttempted) return Promise.resolve()

  captureAttempted = true

  capturePromise = readCurrentLp(false)
    .then((snapshot) => {
      if (!snapshot) return
      initialSnapshot = snapshot
      logger.info(
        '[LpTracker] 初始段位快照 %s %s %dLP',
        snapshot.tier,
        snapshot.division,
        snapshot.leaguePoints,
      )
    })
    .finally(() => {
      capturePromise = null
    })

  return capturePromise
}

/** 读取当前段位；失败或解析不到时返回 null */
export async function getCurrentLp(): Promise<LpSnapshot | null> {
  return readCurrentLp(false)
}

export async function getSessionLpDelta(): Promise<number | null> {
  const change = await getSessionLpChange()
  return change.delta
}

/** 一次性返回当前段位、初始快照与变化，页面避免重复请求 */
export async function getSessionLpChange(): Promise<SessionLpChange> {
  await captureInitialLp()

  const current = await readCurrentLp(false)
  const initial = initialSnapshot

  if (!initial || !current) {
    return { current, initial, delta: null, rankChanged: false }
  }

  const rankChanged = current.queueType !== initial.queueType
    || current.tier !== initial.tier
    || current.division !== initial.division
  const unranked = current.tier === 'UNRANKED' || initial.tier === 'UNRANKED'

  return {
    current,
    initial,
    delta: rankChanged || unranked ? null : current.leaguePoints - initial.leaguePoints,
    rankChanged,
  }
}

async function readCurrentLp(force: boolean): Promise<LpSnapshot | null> {
  if (!force && currentCache && Date.now() - currentCache.at < READ_CACHE_TTL_MS) {
    return currentCache.value
  }

  try {
    const ranked = await lcu.getCurrentRankedStats()
    const snapshot = parseSnapshot(ranked)
    currentCache = { value: snapshot, at: Date.now() }
    return snapshot
  } catch (err) {
    logger.warn('[LpTracker] 获取排位数据失败:', err)
    currentCache = { value: null, at: Date.now() }
    return null
  }
}

function parseSnapshot(ranked: unknown): LpSnapshot | null {
  if (!ranked || typeof ranked !== 'object') return null

  const queueMap = (ranked as { queueMap?: Record<string, unknown> }).queueMap
  if (!queueMap) return null

  for (const queueType of SUPPORTED_QUEUE_TYPES) {
    const queue = queueMap[queueType]
    if (!queue || typeof queue !== 'object') continue

    const raw = queue as Record<string, unknown>
    const tier = typeof raw.tier === 'string' ? raw.tier : ''
    if (!tier) continue

    const division = typeof raw.division === 'string' ? raw.division : ''
    const leaguePoints = typeof raw.leaguePoints === 'number' && Number.isFinite(raw.leaguePoints)
      ? raw.leaguePoints
      : 0

    return {
      queueType,
      tier,
      division,
      leaguePoints,
      capturedAt: Date.now(),
    }
  }

  return null
}
