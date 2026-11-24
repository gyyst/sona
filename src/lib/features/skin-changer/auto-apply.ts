/**
 * 自动应用：记忆皮肤 / 随机皮肤
 *
 * 每个英雄每局只尝试一次；未锁定时失败会在锁定后重试一次。
 * 用户手动选择后立即停止自动应用，避免覆盖用户操作。
 */

import { store } from '@/lib/store'
import { applySkinSelection } from './skin-apply'
import { loadChampionSkinData } from './skin-data'
import { getRememberedSkinId, type ChampionSkin, type ChampionSkinData, type SkinRandomScope } from './state'

interface AutoApplyState {
  championId: number
  /** 未锁定时是否已尝试过 */
  attemptedUnlocked: boolean
  /** 锁定后是否已重试过 */
  attemptedLocked: boolean
  succeeded: boolean
}

let state: AutoApplyState = {
  championId: 0,
  attemptedUnlocked: false,
  attemptedLocked: false,
  succeeded: false,
}

function resetState(championId: number) {
  state = { championId, attemptedUnlocked: false, attemptedLocked: false, succeeded: false }
}

/** 重置自动应用状态（离开选人时调用） */
export function resetAutoApply() {
  resetState(0)
}

/** 用户手动选择后，本局不再自动覆盖 */
export function markManualSelection(championId: number) {
  state = { championId, attemptedUnlocked: true, attemptedLocked: true, succeeded: true }
}

/** 按设置尝试自动应用皮肤 */
export async function maybeAutoApply(
  championId: number,
  locked: boolean,
  loaded?: ChampionSkinData,
) {
  if (state.championId !== championId) resetState(championId)
  if (state.succeeded) return

  const random = store.get('skinRandomPick')
  const remember = store.get('skinRememberSelection')
  if (!random && !remember) return

  // 未锁定与锁定后各最多尝试一次，避免客户端反复推送 session 时重复请求
  if (locked ? state.attemptedLocked : state.attemptedUnlocked) return
  if (locked) {
    state.attemptedLocked = true
  } else {
    state.attemptedUnlocked = true
  }

  const data = loaded ?? await loadChampionSkinData(championId).catch(() => null)
  if (!data) return

  if (random) {
    const skin = pickRandomSkin(data.skins, store.get('skinRandomScope'))
    if (!skin) return
    state.succeeded = await applySkinSelection({
      championId,
      skinId: skin.id,
      skinName: skin.name,
      owned: skin.owned,
      source: 'random',
    }).catch(() => false)
    return
  }

  const skinId = getRememberedSkinId(championId)
  if (!skinId) return
  const target = findSkinTarget(data.skins, skinId)
  const chroma = target?.chromas.find((item) => item.id === skinId)
  state.succeeded = await applySkinSelection({
    championId,
    skinId,
    baseSkinId: target?.id ?? skinId,
    chromaId: chroma?.id,
    skinName: target?.name,
    owned: target?.owned,
    source: 'remembered',
  }).catch(() => false)
}

/** 记忆的 ID 可能是炫彩，需要回溯到所属皮肤 */
function findSkinTarget(skins: ChampionSkin[], skinId: number): ChampionSkin | null {
  const direct = skins.find((skin) => skin.id === skinId)
  if (direct) return direct
  return skins.find((skin) => skin.chromas.some((chroma) => chroma.id === skinId)) ?? null
}

/**
 * 随机挑选一款皮肤。
 * 优先排除基础皮肤；若过滤后为空（例如只有基础皮肤可选），回退到全部候选。
 */
function pickRandomSkin(skins: ChampionSkin[], scope: SkinRandomScope): ChampionSkin | null {
  if (skins.length === 0) return null

  const scopeFiltered = scope === 'owned' ? skins.filter((skin) => skin.owned) : skins
  const candidates = scopeFiltered.length > 0 ? scopeFiltered : skins
  const nonBase = candidates.filter((skin) => !skin.isBase)
  const pool = nonBase.length > 0 ? nonBase : candidates

  return pool[Math.floor(Math.random() * pool.length)] ?? null
}
