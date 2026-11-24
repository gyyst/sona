/**
 * 皮肤选择：把皮肤 / 炫彩 ID 写入客户端
 *
 * 两个 LCU 端点（与 Rose 的实现一致）：
 * - 未锁定英雄：`PATCH /lol-champ-select/v1/session/actions/{actionId}` + selectedSkinId
 * - 已锁定英雄：`PATCH /lol-champ-select/v1/session/my-selection` + selectedSkinId
 *
 * 注意：未拥有的皮肤/炫彩同样可以写入，客户端会接受并在本地显示选中状态。
 * 这只是客户端内的选择，游戏内模型不会替换（需要外部注入器）。
 */

import { lcu } from '@/lib/lcu'
import { ltkBridgeClient } from './bridge/ltk-client'
import { emitSkinSelection, rememberSkinId, setSkinChangerState, type SkinSelectionEventDetail, type SkinSelectionSource } from './state'

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

/** 应用皮肤/炫彩选择。返回是否成功。 */
export async function applySkinSelection(options: ApplySkinOptions): Promise<boolean> {
  const { championId, skinId, skinName = '', owned = false, source = 'manual' } = options
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

  setSkinChangerState({ selectedSkinId: skinId })

  // 只记忆用户的手动选择；随机/自动恢复不污染"上次皮肤"
  if (source === 'manual') {
    rememberSkinId(championId, skinId)
  }

  const detail: SkinSelectionEventDetail = {
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
  emitSkinSelection(detail)
  ltkBridgeClient.sendSelection(detail)

  return true
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
