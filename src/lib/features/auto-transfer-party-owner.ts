/**
 * 房间内自动转让房主
 *
 * 行为：
 *   - 仅在 Gameflow 阶段为 Lobby、且本地玩家是房主时动作。
 *   - 优先转给用户指定目标（PUUID 优先，其次 Riot ID）；未指定任何目标时，
 *     转给房间内第一位合格成员。
 *   - 持续保证：每次房间更新都重新评估；目标把房主转回来也会再次转让。
 *
 * 防抖/冷却：
 *   - 成功转让后冷却 2 秒，失败后冷却 5 秒，避免事件风暴与来回拉扯时高频调用接口。
 *   - 同一时间只允许一次评估和一个 promote 请求在途。
 */

import { logger } from '@/index'
import { lcu, LcuEventUri } from '@/lib/lcu'
import type { GameflowPhase, LCUEventMessage, Lobby } from '@/lib/lcu'
import type { LobbyMember } from '@/types/lcu'
import { store } from '@/lib/store'

const SUCCESS_COOLDOWN_MS = 2000
const FAILURE_COOLDOWN_MS = 5000
const TARGET_REFRESH_DEBOUNCE_MS = 300

let enabled = false
let lobbyUnsub: (() => void) | null = null
let phaseUnsub: (() => void) | null = null
let currentPhase: GameflowPhase | '' = ''
let evaluating = false
let pendingReevaluate = false
let cooldownUntil = 0
let reevaluateTimer: ReturnType<typeof setTimeout> | null = null
let targetRefreshTimer: ReturnType<typeof setTimeout> | null = null
let lastMissingTargetKey = ''

function normalizeRiotId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

/** 可被转让房主的成员：排除自己、bot 和观战者 */
function isEligibleMember(member: LobbyMember, localPuuid: string): boolean {
  if (!member.puuid || member.puuid === localPuuid) return false
  return !member.isBot && !member.isSpectator
}

function matchesRiotId(member: LobbyMember, input: string): boolean {
  const normalized = normalizeRiotId(input)
  if (!normalized) return false

  const candidates = [member.summonerName, member.summonerInternalName]
    .filter((value): value is string => Boolean(value))
    .map(normalizeRiotId)

  if (normalized.includes('#')) return candidates.includes(normalized)
  // 手动输入可能省略 tag，只比较名称部分
  return candidates.some((candidate) => candidate.split('#')[0] === normalized)
}

function resolveTarget(lobby: Lobby): LobbyMember | null {
  const localPuuid = lobby.localMember?.puuid ?? ''
  const eligible = lobby.members.filter((member) => isEligibleMember(member, localPuuid))
  if (eligible.length === 0) return null

  const targetPuuid = store.get('autoTransferOwnerTargetPuuid').trim()
  const targetRiotId = store.get('autoTransferOwnerTargetRiotId').trim()

  if (targetPuuid) {
    const byPuuid = eligible.find((member) => member.puuid === targetPuuid)
    if (byPuuid) return byPuuid
  }

  if (targetRiotId) {
    // 指定了目标但未匹配到：保持等待，不回退给路人
    return eligible.find((member) => matchesRiotId(member, targetRiotId)) ?? null
  }

  // 未指定任何目标时才自动回退
  return targetPuuid ? null : eligible[0]
}

function hasConfiguredTarget(): boolean {
  return Boolean(
    store.get('autoTransferOwnerTargetPuuid').trim()
    || store.get('autoTransferOwnerTargetRiotId').trim(),
  )
}

function getMissingTargetKey(lobby: Lobby): string {
  return [
    lobby.partyId,
    store.get('autoTransferOwnerTargetPuuid'),
    store.get('autoTransferOwnerTargetRiotId'),
  ].join(':')
}

function clearReevaluateTimer() {
  if (reevaluateTimer != null) {
    clearTimeout(reevaluateTimer)
    reevaluateTimer = null
  }
}

function clearTargetRefreshTimer() {
  if (targetRefreshTimer != null) {
    clearTimeout(targetRefreshTimer)
    targetRefreshTimer = null
  }
}

function scheduleReevaluate(delayMs: number) {
  if (reevaluateTimer != null) return
  reevaluateTimer = setTimeout(() => {
    reevaluateTimer = null
    if (!enabled || currentPhase !== 'Lobby') return
    void refreshLobbyAndEvaluate()
  }, delayMs)
}

async function refreshLobbyAndEvaluate() {
  try {
    const lobby = await lcu.getLobby()
    await evaluateLobby(lobby)
  } catch {
    // 不在房间、接口暂不可用或已退出时静默
  }
}

async function evaluateLobby(lobby?: Lobby | null) {
  if (!enabled || currentPhase !== 'Lobby') return
  if (evaluating) {
    pendingReevaluate = true
    return
  }

  evaluating = true
  try {
    let current = lobby ?? null
    if (!current) {
      try {
        current = await lcu.getLobby()
      } catch {
        return
      }
    }

    if (!enabled || currentPhase !== 'Lobby') return
    if (!current?.localMember?.isLeader) return
    if (current.members.length < 2) return

    const now = Date.now()
    if (now < cooldownUntil) {
      scheduleReevaluate(cooldownUntil - now + 100)
      return
    }

    const target = resolveTarget(current)
    if (!target) {
      if (hasConfiguredTarget()) {
        const key = getMissingTargetKey(current)
        if (key !== lastMissingTargetKey) {
          lastMissingTargetKey = key
          logger.debug('[AutoTransferOwner] 指定目标不在房间内，保持等待')
        }
      }
      return
    }
    lastMissingTargetKey = ''

    try {
      await lcu.promoteLobbyMember(target.summonerId, target.puuid)
      cooldownUntil = Date.now() + SUCCESS_COOLDOWN_MS
      const name = target.summonerName || target.summonerInternalName || target.puuid
      logger.info('[AutoTransferOwner] 已自动转让房主 → %s ✓', name)
    } catch (error) {
      cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
      logger.warn('[AutoTransferOwner] 自动转让房主失败:', error)
      scheduleReevaluate(FAILURE_COOLDOWN_MS + 100)
    }
  } finally {
    evaluating = false
    if (pendingReevaluate) {
      pendingReevaluate = false
      if (enabled && currentPhase === 'Lobby') {
        void refreshLobbyAndEvaluate()
      }
    }
  }
}

function handleLobbyEvent(event: LCUEventMessage) {
  if (!enabled) return

  if (event.eventType === 'Delete') {
    lastMissingTargetKey = ''
    clearReevaluateTimer()
    return
  }

  const lobby = event.data as Lobby | null
  if (lobby?.members) {
    void evaluateLobby(lobby)
  } else {
    void refreshLobbyAndEvaluate()
  }
}

function handlePhaseChange(event: LCUEventMessage) {
  currentPhase = event.data as GameflowPhase
  if (currentPhase !== 'Lobby') {
    clearReevaluateTimer()
    return
  }
  void refreshLobbyAndEvaluate()
}

/** 启用/禁用「房间内自动转让房主」 */
export function updateAutoTransferOwner(nextEnabled: boolean) {
  if (nextEnabled && !lobbyUnsub) {
    enabled = true
    cooldownUntil = 0
    lastMissingTargetKey = ''

    lobbyUnsub = lcu.observe(LcuEventUri.LOBBY, handleLobbyEvent)
    phaseUnsub = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, handlePhaseChange)

    void lcu.getGameflowPhase()
      .then((phase) => {
        if (!enabled) return
        currentPhase = phase
        if (phase === 'Lobby') {
          void refreshLobbyAndEvaluate()
        }
      })
      .catch((error) => logger.warn('[AutoTransferOwner] 获取游戏阶段失败:', error))

    logger.info('Auto transfer party owner enabled ✓')
  } else if (!nextEnabled && lobbyUnsub) {
    enabled = false
    currentPhase = ''
    cooldownUntil = 0
    pendingReevaluate = false
    lastMissingTargetKey = ''

    clearReevaluateTimer()
    clearTargetRefreshTimer()

    lobbyUnsub()
    lobbyUnsub = null
    phaseUnsub?.()
    phaseUnsub = null

    logger.info('Auto transfer party owner disabled')
  }
}

/** 目标配置变化时重新评估，无需重启客户端 */
export function refreshAutoTransferOwner() {
  if (!enabled) return
  clearTargetRefreshTimer()
  targetRefreshTimer = setTimeout(() => {
    targetRefreshTimer = null
    if (!enabled || currentPhase !== 'Lobby') return
    void refreshLobbyAndEvaluate()
  }, TARGET_REFRESH_DEBOUNCE_MS)
}
