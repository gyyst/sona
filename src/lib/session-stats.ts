/**
 * 本次客户端会话统计
 *
 * 只保存在内存中，客户端重启后自然清零。
 * 监听 EndOfGame 阶段，等结算数据就绪后读取当前对局详情并记录。
 */

import { logger } from '@/index'
import { resolveCurrentPuuid } from '@/lib/assets'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { GameflowPhase, LCUEventMessage } from '@/lib/lcu'
import { sleep } from '@/lib/utils'

export interface SessionGameRecord {
  gameId: number
  win: boolean
  queueId: number
  championId: number
  endedAt: number
}

export interface SessionStats {
  startedAt: number
  games: SessionGameRecord[]
  wins: number
  losses: number
  netWins: number
  durationMs: number
}

const RECORD_DELAY_MS = 2000

let startedAt = 0
let initialized = false
let recording = false
let unsubscribe: (() => void) | null = null

const records: SessionGameRecord[] = []
const recordedGameIds = new Set<number>()

/** 启动会话统计；幂等，重复调用不会重复监听 */
export function initSessionStats(): void {
  if (initialized) return

  initialized = true
  startedAt = Date.now()
  unsubscribe = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
    if ((event.data as GameflowPhase) !== 'EndOfGame') return
    void recordEndOfGame()
  })

  logger.info('[SessionStats] 会话统计已启动')
}

export function getSessionStats(): SessionStats {
  if (!startedAt) startedAt = Date.now()

  let wins = 0
  for (const record of records) {
    if (record.win) wins++
  }

  const losses = records.length - wins
  return {
    startedAt,
    games: [...records],
    wins,
    losses,
    netWins: wins - losses,
    durationMs: Math.max(0, Date.now() - startedAt),
  }
}

/** 仅供测试/开发：停止监听并清空本次会话记录 */
export function disposeSessionStats(): void {
  unsubscribe?.()
  unsubscribe = null
  initialized = false
  recording = false
  startedAt = 0
  records.length = 0
  recordedGameIds.clear()
}

async function recordEndOfGame(): Promise<void> {
  if (recording) return
  recording = true

  try {
    const puuid = await resolveCurrentPuuid()
    if (!puuid) {
      logger.warn('[SessionStats] 无法获取当前账号 PUUID，跳过本次记录')
      return
    }

    // 先取 gameId，避免延迟期间阶段切换导致 gameflow session 被清空
    const session = await lcu.getGameflowSession()
    const gameId = Number(session.gameData?.gameId) || 0
    if (gameId <= 0) {
      logger.warn('[SessionStats] 当前对局没有可用的 gameId，跳过记录')
      return
    }
    if (recordedGameIds.has(gameId)) return

    // 刚进入结算时详情接口可能还没准备好，稍等片刻再读
    await sleep(RECORD_DELAY_MS)

    const detail = await lcu.getMatchDetail(gameId)
    if (recordedGameIds.has(gameId)) return

    const identity = detail.participantIdentities?.find((item) => item.player?.puuid === puuid)
    if (!identity) {
      logger.warn('[SessionStats] 对局详情中找不到当前账号，跳过记录')
      return
    }

    const participant = detail.participants?.find(
      (item) => item.participantId === identity.participantId,
    )
    if (!participant) {
      logger.warn('[SessionStats] 对局详情中找不到当前参与者，跳过记录')
      return
    }

    recordedGameIds.add(gameId)
    records.push({
      gameId,
      win: Boolean(participant.stats?.win),
      queueId: Number(detail.queueId) || 0,
      championId: Number(participant.championId) || 0,
      endedAt: Date.now(),
    })

    logger.info(
      '[SessionStats] 记录对局 %d (%s, queue=%d)',
      gameId,
      participant.stats?.win ? '胜' : '负',
      detail.queueId,
    )
  } catch (err) {
    logger.warn('[SessionStats] 记录对局失败:', err)
  } finally {
    recording = false
  }
}
