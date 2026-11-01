import { logger } from '@/index'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { LCUEventMessage, GameflowPhase } from '@/lib/lcu'
import { sleep } from '@/lib/utils'
import { translate } from '@/i18n'
import type { EndOfGamePlayer, EndOfGameStats, ReportCategory } from '@/types/lcu'

// ==================== 对局结束自动举报异常玩家 ====================

const REPORT_COMMENT = 'Auto-detected: leaver/AFK or disruptive behavior.'
/** 举报请求之间的间隔，避免瞬间打满客户端接口 */
const REPORT_INTERVAL_MS = 300
/** 同一对局最多处理 PreEndOfGame / EndOfGame 两个阶段 */
const MAX_ATTEMPTS_PER_GAME = 2
const FEEDING_MAX_DEATHS = 10
const FEEDING_MAX_PARTICIPATION_RATIO = 0.5
const FEEDING_MAX_DAMAGE_RATIO = 0.5

interface ReportTarget {
  puuid: string
  summonerId: number
  label: string
  categories: ReportCategory[]
}

let autoReportUnsub: (() => void) | null = null
let enabled = false
/** 同一时间只处理一轮，避免阶段事件重复触发并发提交 */
let running: Promise<void> | null = null
/** 处理进行中收到的新阶段，等本轮结束后补跑，避免丢掉 EndOfGame 重试 */
let pendingPhase: GameflowPhase | null = null
/** 每个对局已处理过的阶段；自然保证同一对局最多尝试 2 次 */
const attemptedGames = new Map<number, Set<GameflowPhase>>()
/** 当前对局已成功举报的 puuid，避免重复提交 */
let reportedPuuids = new Set<string>()
let currentGameId: number | null = null

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function getPlayerLabel(player: EndOfGamePlayer): string {
  if (!player.riotIdGameName) return player.championName || player.puuid.slice(0, 8)
  return player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}`
    : player.riotIdGameName
}

function addCategory(categories: ReportCategory[], category: ReportCategory) {
  if (!categories.includes(category)) categories.push(category)
}

/** 统计送人头：死亡多、参战少，且伤害明显低于同队人类中位数 */
function isFeedingPlayer(player: EndOfGamePlayer, medianDamage: number): boolean {
  const stats = player.stats
  if (!stats) return false

  const kills = stats.CHAMPIONS_KILLED
  const deaths = stats.NUM_DEATHS
  const assists = stats.ASSISTS
  const damage = stats.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS
  if (!isFiniteNumber(kills) || !isFiniteNumber(deaths) || !isFiniteNumber(assists) || !isFiniteNumber(damage)) {
    return false
  }

  return deaths >= FEEDING_MAX_DEATHS
    && kills + assists <= deaths * FEEDING_MAX_PARTICIPATION_RATIO
    && damage < medianDamage * FEEDING_MAX_DAMAGE_RATIO
}

/**
 * 从赛后数据中筛出需要举报的玩家。
 * 官方标记优先，统计规则只作为补充；同一玩家多个条件命中时合并去重类别。
 */
function judgePlayers(stats: EndOfGameStats): ReportTarget[] {
  const targets: ReportTarget[] = []

  for (const team of stats.teams ?? []) {
    const players = team.players ?? []
    // 中位数只统计同队非 bot 玩家的有效伤害；样本不足时跳过统计规则，避免误判
    const damages = players
      .filter((player) => !player.botPlayer)
      .map((player) => player.stats?.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS)
      .filter(isFiniteNumber)
    const medianDamage = damages.length >= 2 ? getMedian(damages) : null

    for (const player of players) {
      if (player.botPlayer || player.isLocalPlayer || !player.puuid) continue

      const categories: ReportCategory[] = []
      if (player.wasAfk || player.leaver) {
        addCategory(categories, 'LEAVING_AFK')
      }
      if (player.severeTransgressor) {
        addCategory(categories, 'ASSISTING_ENEMY_TEAM')
      }
      if (medianDamage != null && isFeedingPlayer(player, medianDamage)) {
        addCategory(categories, 'ASSISTING_ENEMY_TEAM')
      }

      if (categories.length > 0) {
        targets.push({
          puuid: player.puuid,
          summonerId: player.summonerId,
          label: getPlayerLabel(player),
          categories,
        })
      }
    }
  }

  return targets
}

/** 记录当前对局；切换到新对局时清理上一局的去重状态 */
function beginGame(gameId: number) {
  if (currentGameId === gameId) return
  currentGameId = gameId
  attemptedGames.clear()
  reportedPuuids = new Set()
}

async function processPhase(phase: GameflowPhase) {
  let stats: EndOfGameStats
  try {
    stats = await lcu.getEogStatsBlock()
  } catch (error) {
    if (phase === 'PreEndOfGame') {
      logger.info('[AutoReport] 赛后数据尚未就绪，等待 EndOfGame 阶段重试')
    } else {
      logger.warn('[AutoReport] 获取赛后数据失败，本局跳过:', error)
    }
    return
  }

  if (!enabled) return

  const gameId = stats.reportGameId || stats.gameId
  if (!gameId) {
    logger.warn('[AutoReport] 赛后数据缺少 gameId，本局跳过')
    return
  }

  beginGame(gameId)

  const attemptedPhases = attemptedGames.get(gameId)
  if (attemptedPhases) {
    // 同一阶段重复触发或已达尝试上限时直接跳过
    if (attemptedPhases.has(phase) || attemptedPhases.size >= MAX_ATTEMPTS_PER_GAME) return
    attemptedPhases.add(phase)
  } else {
    attemptedGames.set(gameId, new Set([phase]))
  }

  const targets = judgePlayers(stats)
  if (targets.length === 0) {
    logger.info('[AutoReport] 本局未检测到异常玩家')
    return
  }

  let reportedInGame = new Set<string>()
  try {
    reportedInGame = new Set((await lcu.getReportedPlayers(gameId)).map(String))
  } catch (error) {
    // 查询失败不应阻止举报，后续仍会依赖本局成功记录去重
    logger.warn('[AutoReport] 查询已举报玩家失败，继续提交:', error)
  }

  if (!enabled) return

  const pending = targets.filter((target) => (
    !reportedInGame.has(target.puuid)
    && !reportedInGame.has(String(target.summonerId))
    && !reportedPuuids.has(target.puuid)
  ))

  if (pending.length === 0) {
    logger.info('[AutoReport] 检测到异常玩家，但均已在举报列表中，跳过')
    return
  }

  logger.info('[AutoReport] 检测到 %d 名异常玩家，开始提交举报', pending.length)

  let successCount = 0
  for (let i = 0; i < pending.length; i++) {
    if (!enabled) break

    const target = pending[i]
    try {
      await lcu.reportPlayer({
        offenderPuuid: target.puuid,
        obfuscatedOffenderPuuid: '',
        categories: target.categories,
        gameId,
        comment: REPORT_COMMENT,
      })
      reportedPuuids.add(target.puuid)
      successCount++
      logger.info('[AutoReport] 举报成功 → %s (%s)', target.label, target.categories.join(', '))
    } catch (error) {
      // 单条失败不影响后续玩家，也不自动重试，避免重复举报
      logger.warn('[AutoReport] 举报失败 → %s:', target.label, error)
    }

    if (i < pending.length - 1) {
      await sleep(REPORT_INTERVAL_MS)
    }
  }

  if (successCount > 0) {
    Toast.success(translate('tools.autoReport.toast', { count: successCount }))
    logger.info('[AutoReport] 已自动举报 %d 名玩家', successCount)
  }
}

function runPhase(phase: GameflowPhase) {
  running = processPhase(phase)
    .catch((error) => {
      logger.error('[AutoReport] 处理对局结束事件失败:', error)
    })
    .finally(() => {
      running = null
      const next = pendingPhase
      pendingPhase = null
      if (next && enabled) runPhase(next)
    })
}

function handlePhaseChange(phase: GameflowPhase) {
  if (phase !== 'PreEndOfGame' && phase !== 'EndOfGame') return
  if (!enabled) return
  if (running) {
    // 当前一轮尚未结束，先暂存阶段，等它收敛后再处理
    pendingPhase = phase
    return
  }
  runPhase(phase)
}

export function updateAutoReportPlayers(enable: boolean) {
  if (enable && !autoReportUnsub) {
    enabled = true
    autoReportUnsub = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
      handlePhaseChange(event.data as GameflowPhase)
    })
    logger.info('[AutoReport] 自动举报已开启')
  } else if (!enable && autoReportUnsub) {
    enabled = false
    autoReportUnsub()
    autoReportUnsub = null
    // 进行中的任务会在下一个检查点自行退出；running 保留到 Promise 收敛，避免并发重复提交
    pendingPhase = null
    attemptedGames.clear()
    reportedPuuids = new Set()
    currentGameId = null
    logger.info('[AutoReport] 自动举报已关闭')
  }
}
