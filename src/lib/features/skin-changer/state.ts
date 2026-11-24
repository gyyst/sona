/**
 * 换肤模块：类型、瞬时状态与皮肤记忆
 *
 * 数据来源：
 * - `/lol-game-data/assets/v1/champions/{championId}.json`：全部皮肤与炫彩（含未拥有）
 * - `/lol-champions/v1/inventories/{summonerId}/champions/{championId}`：拥有状态
 *
 * 客户端内选择由 LCU 完成；游戏内模型替换由可选的 ltk-bridge 后台负责。
 */

import { store } from '@/lib/store'

// ==================== 类型 ====================

/** 炫彩（色板） */
export interface SkinChroma {
  /** 炫彩 ID，可直接作为 selectedSkinId 提交给 LCU */
  id: number
  name: string
  /** 主色列表（LCU 返回的 Hex 字符串，如 "#ff0000"） */
  colors: string[]
  /** 炫彩缩略图 */
  imagePath: string
  owned: boolean
}

/** 特殊形态（元素使拉克丝、DJ 娑娜等） */
export interface SkinForm {
  /** 形态 ID。伪 ID 无法经 LCU 选中，仅供外部注入器识别 */
  id: number
  /** 展示序号（1 起） */
  index: number
}

/** 单款皮肤 */
export interface ChampionSkin {
  id: number
  name: string
  isBase: boolean
  owned: boolean
  /** 轮播/网格用缩略图，来自 LCU 的 tilePath */
  imagePath: string
  /** 大图，用于面板背景 */
  splashPath: string
  chromas: SkinChroma[]
  forms: SkinForm[]
}

/** 某个英雄的完整皮肤数据 */
export interface ChampionSkinData {
  championId: number
  championName: string
  skins: ChampionSkin[]
  /** 是否成功拿到拥有状态；false 时 owned 均为 false，仅作展示降级 */
  ownershipKnown: boolean
}

/** 选择皮肤的触发来源 */
export type SkinSelectionSource = 'manual' | 'remembered' | 'random'

/** 随机皮肤范围 */
export type SkinRandomScope = 'all' | 'owned'

/** 换肤面板运行状态（非持久化，供 React 订阅） */
export interface SkinChangerState {
  championId: number
  championName: string
  skins: ChampionSkin[]
  /** 是否拿到拥有状态；false 时 UI 不显示“已拥有/未拥有”标记 */
  ownershipKnown: boolean
  /** 当前选中的皮肤/炫彩 ID（0 表示未选） */
  selectedSkinId: number
  loading: boolean
  error: string | null
}

/** 皮肤选择事件。通过 window 的 `sona-skin-selection` 派发，供注入器桥接 */
export interface SkinSelectionEventDetail {
  championId: number
  skinId: number
  /** 基础皮肤 ID（炫彩/形态注入时用于定位资源目录） */
  baseSkinId: number
  chromaId?: number
  formId?: number
  skinName: string
  owned: boolean
  source: SkinSelectionSource
  timestamp: number
}

/** 皮肤选择事件的 window 事件名 */
export const SKIN_SELECTION_EVENT = 'sona-skin-selection'

// ==================== 瞬时状态 ====================

type Listener = () => void

const initialState: SkinChangerState = {
  championId: 0,
  championName: '',
  skins: [],
  ownershipKnown: false,
  selectedSkinId: 0,
  loading: false,
  error: null,
}

let state: SkinChangerState = initialState
const listeners = new Set<Listener>()

/** 读取当前状态（useSyncExternalStore 的 getSnapshot） */
export function getSkinChangerState(): SkinChangerState {
  return state
}

/** 订阅状态变化，返回取消订阅函数 */
export function subscribeSkinChanger(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 合并更新状态并通知订阅者 */
export function setSkinChangerState(patch: Partial<SkinChangerState>) {
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof SkinChangerState>) {
    if (state[key] !== patch[key]) {
      changed = true
      break
    }
  }
  if (!changed) return

  state = { ...state, ...patch }
  notifyListeners()
}

/** 重置为初始状态（离开选人阶段时调用） */
export function resetSkinChangerState() {
  state = initialState
  notifyListeners()
}

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // 单个订阅者的异常不应阻断其他订阅者
    }
  }
}

// ==================== 皮肤记忆 ====================

/** 读取某英雄上次选择的皮肤/炫彩 ID */
export function getRememberedSkinId(championId: number): number | null {
  const selections = store.get('skinSelections')
  const value = selections[String(championId)]
  return typeof value === 'number' && value > 0 ? value : null
}

/** 记住某英雄本次选择的皮肤/炫彩 ID */
export function rememberSkinId(championId: number, skinId: number) {
  if (championId <= 0 || skinId <= 0) return
  const selections = store.get('skinSelections')
  if (selections[String(championId)] === skinId) return
  store.set('skinSelections', {
    ...selections,
    [String(championId)]: skinId,
  })
}

// ==================== 事件 ====================

/** 广播皮肤选择事件，供 ltk-bridge 或其他注入器监听 */
export function emitSkinSelection(detail: SkinSelectionEventDetail) {
  try {
    window.dispatchEvent(new CustomEvent(SKIN_SELECTION_EVENT, { detail }))
  } catch {
    // ignore
  }
}
