/**
 * 选人换肤：生命周期编排
 *
 * 只在英雄选择阶段运行：
 * - 注入「换肤」入口按钮（见 launcher.ts）
 * - 解锁皮肤轮播预览
 * - 跟踪当前英雄，按设置自动应用记忆 / 随机皮肤（见 auto-apply.ts）
 * - 把当前英雄的皮肤数据推送到 skin-state，供面板订阅
 */

import { logger } from '@/index'
import { injector } from '@/lib/InjectorManager'
import { lcu, LcuEventUri, type ChampSelectSession, type LCUEventMessage } from '@/lib/lcu'
import { store } from '@/lib/store'
import type { GameflowPhase } from '@/types/lcu'
import { markManualSelection, maybeAutoApply, resetAutoApply } from './auto-apply'
import { registerSkinLauncher, removeSkinLauncher } from './launcher'
import { loadChampionSkinData } from './skin-data'
import { resetSkinChangerState, setSkinChangerState, SKIN_SELECTION_EVENT, type SkinSelectionEventDetail } from './state'
import { scanSkinPreviewUnlock, setSkinPreviewUnlock } from './skin-unlock'

// ==================== 模块状态 ====================

const SESSION_DEBOUNCE_MS = 180

let featureMounted = false
let inChampSelect = false
let phaseUnsub: (() => void) | null = null
let sessionUnsub: (() => void) | null = null
let sessionTimer: number | null = null
let unlockRegistered = false

let currentChampionId = 0
let currentLocked = false

// ==================== 对外：开关 ====================

/** 读取 store 配置并同步换肤功能（幂等，可重复调用） */
export function updateSkinChanger() {
  if (store.get('skinChangerEnabled')) {
    mountFeature()
  } else {
    unmountFeature()
  }
  syncPreviewUnlock()
}

// ==================== 功能挂载 ====================

function mountFeature() {
  if (featureMounted) return
  featureMounted = true

  phaseUnsub = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, (event: LCUEventMessage) => {
    onPhase(event.data as GameflowPhase)
  })
  sessionUnsub = lcu.observe(LcuEventUri.CHAMP_SELECT, () => scheduleSessionRefresh())
  window.addEventListener(SKIN_SELECTION_EVENT, onSkinSelectionEvent)

  lcu.getGameflowPhase()
    .then(onPhase)
    .catch(() => { /* 客户端尚未就绪时忽略 */ })

  logger.info('[SkinChanger] 换肤功能已启用')
}

function unmountFeature() {
  if (!featureMounted) return
  featureMounted = false

  phaseUnsub?.()
  phaseUnsub = null
  sessionUnsub?.()
  sessionUnsub = null
  window.removeEventListener(SKIN_SELECTION_EVENT, onSkinSelectionEvent)
  if (sessionTimer != null) {
    window.clearTimeout(sessionTimer)
    sessionTimer = null
  }

  leaveChampSelect()
  logger.info('[SkinChanger] 换肤功能已禁用')
}

function onPhase(phase: GameflowPhase) {
  if (phase === 'ChampSelect') {
    enterChampSelect()
  } else {
    leaveChampSelect()
  }
}

function enterChampSelect() {
  if (!featureMounted) return
  inChampSelect = true
  syncPreviewUnlock()
  registerSkinLauncher()
  void refreshSession()
}

function leaveChampSelect() {
  inChampSelect = false
  currentChampionId = 0
  currentLocked = false
  resetAutoApply()
  removeSkinLauncher()
  syncPreviewUnlock()
  resetSkinChangerState()
}

// ==================== 预览解锁 ====================

function syncPreviewUnlock() {
  const enabled = featureMounted && inChampSelect && store.get('skinPreviewUnlock')
  setSkinPreviewUnlock(enabled)

  if (enabled && !unlockRegistered) {
    injector.register(scanSkinPreviewUnlock)
    unlockRegistered = true
  } else if (!enabled && unlockRegistered) {
    injector.unregister(scanSkinPreviewUnlock)
    unlockRegistered = false
  }
}

// ==================== 会话同步 ====================

function scheduleSessionRefresh() {
  if (sessionTimer != null) window.clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(() => {
    sessionTimer = null
    void refreshSession()
  }, SESSION_DEBOUNCE_MS)
}

async function refreshSession() {
  if (!featureMounted || !inChampSelect) return

  let session: ChampSelectSession
  try {
    session = await lcu.getChampSelectSession()
  } catch {
    return
  }

  const me = session.myTeam.find((player) => player.cellId === session.localPlayerCellId)
  if (!me || me.championId === 0) {
    currentChampionId = 0
    setSkinChangerState({
      championId: 0,
      championName: '',
      skins: [],
      ownershipKnown: false,
      selectedSkinId: 0,
      loading: false,
      error: null,
    })
    return
  }

  const championChanged = me.championId !== currentChampionId
  currentChampionId = me.championId
  currentLocked = isLocalPlayerLocked(session)

  setSkinChangerState({
    championId: me.championId,
    selectedSkinId: me.selectedSkinId,
    ...(championChanged ? { skins: [], loading: true, error: null } : {}),
  })

  if (!championChanged) {
    await maybeAutoApply(me.championId, currentLocked)
    return
  }

  try {
    const data = await loadChampionSkinData(me.championId)
    if (currentChampionId !== me.championId) return
    setSkinChangerState({
      championName: data.championName,
      skins: data.skins,
      ownershipKnown: data.ownershipKnown,
      loading: false,
      error: null,
    })
    await maybeAutoApply(me.championId, currentLocked, data)
  } catch (error) {
    if (currentChampionId !== me.championId) return
    setSkinChangerState({
      loading: false,
      error: error instanceof Error ? error.message : '皮肤数据加载失败',
    })
  }
}

function isLocalPlayerLocked(session: ChampSelectSession): boolean {
  return session.actions
    .flat(2)
    .some((action) =>
      action.actorCellId === session.localPlayerCellId
      && action.type === 'pick'
      && action.completed)
}

// ==================== 事件 ====================

function onSkinSelectionEvent(event: Event) {
  const detail = (event as CustomEvent<SkinSelectionEventDetail>).detail
  if (!detail) return
  // 用户手动选择后，本局不再自动覆盖
  if (detail.source === 'manual') {
    markManualSelection(detail.championId)
  }
}
