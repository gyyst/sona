/**
 * 皮肤选择：把皮肤 / 炫彩 ID 写入客户端
 *
 * 两个 LCU 端点（与 Rose 的实现一致）：
 * - 未锁定英雄：`PATCH /lol-champ-select/v1/session/actions/{actionId}` + selectedSkinId
 * - 已锁定英雄：`PATCH /lol-champ-select/v1/session/my-selection` + selectedSkinId
 *
 * 注意（客户端 16.23 实测）：未拥有皮肤提交后会返回 204，但 LCU 不回显，客户端也不显示选中。
 * 因此未拥有皮肤的选中态由 carousel-select 自行维护；返回值只代表请求被接受，不代表已生效。
 * 游戏内模型替换仍需外部注入器。
 */

import { lcu } from '@/lib/lcu'
import { ltkBridgeClient } from './bridge/ltk-client'
import {
  emitSkinSelection,
  findSkinBySelectionId,
  rememberSkinId,
  setSkinChangerState,
  type ChampionSkin,
  type SkinSelectionEventDetail,
  type SkinSelectionSource,
} from './state'

export interface ApplySkinOptions {
  championId: number
  skinId: number
  /** 基础皮肤 ID；不传时按 skinId 推导（炫彩/形态应显式传入） */
  baseSkinId?: number
  chromaId?: number
  formId?: number
  skinName?: string
  owned?: boolean
  source?: SkinSelectionSource
}

/** 皮肤 ID 规则：championId * 1000 + 序号 */
function deriveBaseSkinId(skinId: number): number {
  return Math.floor(skinId / 1000) * 1000
}

/** Sona 最近一次主动写入的皮肤 ID，用于过滤 LCU 回显（0 表示本局尚未写入） */
let lastAppliedSkinId = 0

/** 应用皮肤/炫彩选择。返回是否成功。 */
export async function applySkinSelection(options: ApplySkinOptions): Promise<boolean> {
  const { championId, skinId } = options
  if (championId <= 0 || skinId <= 0) return false

  const session = await lcu.getChampSelectSession()
  const me = session.myTeam.find((player) => player.cellId === session.localPlayerCellId)
  if (!me || me.championId === 0) {
    throw new Error('尚未选择英雄')
  }

  let ok = false
  const pendingAction = session.actions
    .flat(2)
    .find((action) =>
      action.actorCellId === session.localPlayerCellId
      && action.type === 'pick'
      && action.isInProgress
      && !action.completed)

  if (pendingAction) {
    ok = await patchActionSkin(pendingAction.id, skinId)
  }

  if (!ok) {
    ok = await patchMySelectionSkin(skinId)
  }

  if (!ok) return false

  // 记录主动写入值，供 LCU 回显过滤（未拥有皮肤不会回显）
  lastAppliedSkinId = skinId
  notifySkinSelection(toSelectionDetail(options))
  return true
}

/** 只做记忆 / 广播 / bridge / 状态更新，不写 LCU（供原生选择已拥有皮肤时复用） */
export function notifySkinSelection(detail: SkinSelectionEventDetail): void {
  setSkinChangerState({ selectedSkinId: detail.skinId })

  // 只记忆用户的手动选择；随机/自动恢复不污染"上次皮肤"
  if (detail.source === 'manual') {
    rememberSkinId(detail.championId, detail.skinId)
  }

  emitSkinSelection(detail)
  ltkBridgeClient.sendSelection(detail)
}

/** 读取 Sona 最近一次主动写入的皮肤 ID */
export function getLastAppliedSkinId(): number {
  return lastAppliedSkinId
}

/** 记录一次由 Sona 决定、但不经 applySkinSelection 写入 LCU 的选择（例如已拥有皮肤交给原生） */
export function markAppliedSkin(skinId: number) {
  lastAppliedSkinId = skinId
}

/**
 * 原生轮盘选择了已拥有皮肤/炫彩：补发通知。
 *
 * 这类选择由客户端自己写入 LCU，Sona 只负责记忆、广播与 bridge 同步；
 * 因此这里不写 LCU，也不更新 lastAppliedSkinId（由调用方决定是否记录）。
 */
export function notifyExternalSkinSelection(
  championId: number,
  skinId: number,
  skins: readonly ChampionSkin[],
): void {
  const skin = findSkinBySelectionId(skins, skinId)
  if (!skin) return

  const chroma = skin.chromas.find((entry) => entry.id === skinId)
  notifySkinSelection({
    championId,
    skinId,
    baseSkinId: skin.id,
    chromaId: chroma?.id,
    skinName: skin.name,
    owned: chroma ? chroma.owned : skin.owned,
    source: 'manual',
    timestamp: Date.now(),
  })
}

/** 重置主动写入记录（离开选人时调用） */
export function resetLastAppliedSkinId(): void {
  lastAppliedSkinId = 0
}

function toSelectionDetail(options: ApplySkinOptions): SkinSelectionEventDetail {
  const { championId, skinId, skinName = '', owned = false, source = 'manual' } = options
  return {
    championId,
    skinId,
    baseSkinId: options.baseSkinId ?? deriveBaseSkinId(skinId),
    chromaId: options.chromaId,
    formId: options.formId,
    skinName,
    owned,
    source,
    timestamp: Date.now(),
  }
}

async function patchActionSkin(actionId: number, skinId: number): Promise<boolean> {
  try {
    const response = await fetch(`/lol-champ-select/v1/session/actions/${actionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedSkinId: skinId }),
    })
    return response.ok
  } catch {
    return false
  }
}

async function patchMySelectionSkin(skinId: number): Promise<boolean> {
  try {
    await lcu.updateMySelection({ selectedSkinId: skinId })
    return true
  } catch {
    return false
  }
}
