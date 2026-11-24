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
import { registerCarouselSelect, removeCarouselSelect } from './carousel-select'
import { registerSkinLauncher, removeSkinLauncher } from './launcher'
import { getLastAppliedSkinId, notifyExternalSkinSelection, resetLastAppliedSkinId } from './skin-apply'
import { loadChampionSkinData } from './skin-data'
import { getSkinChangerState, resetSkinChangerState, setSkinChangerState, SKIN_SELECTION_EVENT, type SkinSelectionEventDetail } from './state'
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
/** 上一次从 LCU 读到的 selectedSkinId，用于识别原生（已拥有）选择 */
let lcuBaselineSkinId: number | null = null
/** 皮肤数据加载前观察到的外部选择，加载完成后补发 */
let pendingExternalSkinId = 0

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
  registerCarouselSelect()
  void refreshSession()
}

function leaveChampSelect() {
  inChampSelect = false
  currentChampionId = 0
  currentLocked = false
  lcuBaselineSkinId = null
  pendingExternalSkinId = 0
  resetLastAppliedSkinId()
  resetAutoApply()
  removeSkinLauncher()
  removeCarouselSelect()
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
    currentLocked = false
    lcuBaselineSkinId = null
    pendingExternalSkinId = 0
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

  if (championChanged) {
    // 换英雄时的首次快照只作为基线，不当作一次用户选择
    lcuBaselineSkinId = me.selectedSkinId
    pendingExternalSkinId = 0
    setSkinChangerState({
      championId: me.championId,
      selectedSkinId: me.selectedSkinId,
      skins: [],
      loading: true,
      error: null,
    })
  } else {
    handleLcuSelection(me.championId, me.selectedSkinId)
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
    flushPendingExternalSelection(me.championId)
    await maybeAutoApply(me.championId, currentLocked, data)
  } catch (error) {
    if (currentChampionId !== me.championId) return
    setSkinChangerState({
      loading: false,
      error: error instanceof Error ? error.message : '皮肤数据加载失败',
    })
  }
}

// ==================== LCU 回显 ====================

/**
 * 处理 LCU 回显的 selectedSkinId 变化。
 *
 * 只有「LCU 值真的变化」且「不是 Sona 主动写入」时才视为原生选择。
 * 未拥有皮肤不会被 LCU 回显，因此 Sona 的未拥有选择不会在这里被覆盖。
 */
function handleLcuSelection(championId: number, lcuSkinId: number) {
  if (lcuBaselineSkinId === null) {
    lcuBaselineSkinId = lcuSkinId
    return
  }
  if (lcuSkinId === lcuBaselineSkinId) return

  lcuBaselineSkinId = lcuSkinId

  // Sona 自己写入的已拥有皮肤，避免重复通知
  if (lcuSkinId === getLastAppliedSkinId()) return

  const state = getSkinChangerState()
  if (state.skins.length === 0) {
    // 皮肤数据未就绪，等加载完成后补发
    pendingExternalSkinId = lcuSkinId
    return
  }

  notifyExternalSkinSelection(championId, lcuSkinId, state.skins)
}

/** 皮肤数据加载完成后补发之前观察到的外部选择 */
function flushPendingExternalSelection(championId: number) {
  if (!pendingExternalSkinId) return
  const skinId = pendingExternalSkinId
  pendingExternalSkinId = 0
  notifyExternalSkinSelection(championId, skinId, getSkinChangerState().skins)
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
