/**
 * 轮盘卡片 → skinId 解析
 *
 * 客户端 16.23 的卡片背景路径含 `Skins/SkinNN/` 或 `Skins/Base/`，
 * 但多款皮肤可能共用同一张图（如「至臻 2022」与原始至臻）。
 * 因此索引值是候选列表，并支持用客户端当前展示的皮肤名消歧。
 */

import { buildSkinAssetIndex, extractSkinAssetKey } from './skin-data'
import { getSkinChangerState, type ChampionSkin, type ChampionSkinData } from './state'

const CHAMP_SELECT_SCOPE = '.champion-select'
const ITEM_SELECTOR = '.skin-selection-item'
const THUMB_SELECTOR = '.skin-selection-thumbnail'

let cachedChampionId = 0
let itemSkinIdCache = new WeakMap<HTMLElement, number>()
let itemAssetKeyCache = new WeakMap<HTMLElement, string>()
let assetIndex: Map<string, number[]> | null = null

/** 重置按英雄生效的解析缓存 */
export function resetCarouselResolver() {
  cachedChampionId = 0
  itemSkinIdCache = new WeakMap()
  itemAssetKeyCache = new WeakMap()
  assetIndex = null
}

/** 解析轮盘卡片对应的 skinId；useVisibleName 为 true 时用页面展示名消歧 */
export function resolveItemSkinId(
  item: HTMLElement,
  championId: number,
  useVisibleName = false,
): number | null {
  ensureChampionCache(championId)

  const cached = itemSkinIdCache.get(item)
  if (cached != null) return cached

  const state = getSkinChangerState()
  // 皮肤数据未就绪时不缓存，等下一帧重试
  if (state.championId !== championId || state.skins.length === 0) return null

  const key = readItemAssetKey(item)
  if (!key) return null

  const candidates = getAssetIndex(championId)?.get(key)
  let skinId: number | null = null
  if (candidates && candidates.length > 0) {
    skinId = candidates.length === 1
      ? candidates[0]
      : resolveAmbiguousSkin(item, key, candidates, state.skins, useVisibleName)
  } else if (key !== 'base') {
    // 回退：SkinNN → championId * 1000 + NN，并校验皮肤确实存在
    const candidate = championId * 1000 + Number(key.slice(4))
    if (state.skins.some((skin) => skin.id === candidate)) skinId = candidate
  }

  if (skinId != null) itemSkinIdCache.set(item, skinId)
  return skinId
}

function ensureChampionCache(championId: number) {
  if (cachedChampionId === championId) return
  cachedChampionId = championId
  itemSkinIdCache = new WeakMap()
  itemAssetKeyCache = new WeakMap()
  assetIndex = null
}

/**
 * 共用同一张资源图时的消歧。
 *
 * 点击时优先用客户端当前展示的皮肤名匹配；匹配失败或同步选中态时，
 * 退回按卡片 DOM 出现顺序对齐。
 */
function resolveAmbiguousSkin(
  item: HTMLElement,
  key: string,
  candidates: number[],
  skins: readonly ChampionSkin[],
  useVisibleName: boolean,
): number | null {
  if (useVisibleName) {
    const matched = findCandidateByVisibleName(candidates, skins)
    if (matched != null) return matched
  }
  return candidates[assetKeyOccurrence(item, key)] ?? null
}

/** 在页面当前展示的皮肤名中查找候选皮肤 */
function findCandidateByVisibleName(
  candidates: number[],
  skins: readonly ChampionSkin[],
): number | null {
  const names = new Set<string>()
  document.querySelectorAll<HTMLElement>('.champion-skin-name, .skin-name-text').forEach((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) names.add(text)
  })
  if (names.size === 0) return null

  for (const skinId of candidates) {
    const skin = skins.find((entry) => entry.id === skinId)
    if (skin && names.has(skin.name)) return skinId
  }
  return null
}

/** 同一资产键的卡片在 DOM 中的出现序号（0 起） */
function assetKeyOccurrence(item: HTMLElement, key: string): number {
  const items = document.querySelectorAll<HTMLElement>(`${CHAMP_SELECT_SCOPE} ${ITEM_SELECTOR}`)
  let index = 0
  for (const candidate of items) {
    if (candidate === item) return index
    if (readItemAssetKey(candidate) === key) index += 1
  }
  return 0
}

function readItemAssetKey(item: HTMLElement): string | null {
  if (itemAssetKeyCache.has(item)) return itemAssetKeyCache.get(item) ?? null

  const thumb = item.querySelector<HTMLElement>(THUMB_SELECTOR)
  let key: string | null = null
  if (thumb) {
    const value = thumb.style.backgroundImage || getComputedStyle(thumb).backgroundImage
    key = extractSkinAssetKey(value)
  }
  // 背景图可能尚未渲染：只在解析成功时缓存，避免永久失效
  if (key) itemAssetKeyCache.set(item, key)
  return key
}

function getAssetIndex(championId: number): Map<string, number[]> | null {
  if (assetIndex && cachedChampionId === championId) return assetIndex

  const state = getSkinChangerState()
  if (state.championId !== championId || state.skins.length === 0) return null

  const data: ChampionSkinData = {
    championId,
    championName: state.championName,
    skins: state.skins,
    ownershipKnown: state.ownershipKnown,
  }
  assetIndex = buildSkinAssetIndex(data)
  return assetIndex
}
