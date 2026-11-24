/**
 * 英雄皮肤数据加载
 *
 * 合并两个 LCU 数据源：
 * 1. game-data：全部皮肤与炫彩（无论是否拥有）
 * 2. inventory：当前账号的拥有状态
 *
 * 结果按英雄缓存；皮肤数据在客户端版本内不会变化，跨对局复用。
 */

import { lcu } from '@/lib/lcu'
import type { ChampionSkin, ChampionSkinData, SkinChroma, SkinForm } from './state'

// ==================== 特殊形态配置 ====================

interface SkinFormGroup {
  /** 基础皮肤 ID */
  baseSkinId: number
  /** 形态伪 ID 列表（不含基础皮肤本身） */
  formIds: number[]
}

/**
 * 特殊形态皮肤表：部分皮肤没有炫彩，而是在同一款皮肤内提供多个形态。
 * 形态 ID 大多不是真实皮肤 ID（伪 ID），客户端无法直接选中。
 * 数据来源：Rose 的 ROSE-FormsWheel / ROSE-ChromaWheel 配置。
 */
const SKIN_FORM_GROUPS: readonly SkinFormGroup[] = [
  // 元素使拉克丝：9 种元素形态
  { baseSkinId: 99007, formIds: [99991, 99992, 99993, 99994, 99995, 99996, 99997, 99998, 99999] },
  // 萨恩·乌祖尔 莫德凯撒
  { baseSkinId: 82054, formIds: [82998, 82999] },
  // 灵魂莲华 莫甘娜
  { baseSkinId: 25080, formIds: [25999] },
  // 至臻 心之钢 瑟提
  { baseSkinId: 875066, formIds: [875998, 875999] },
  // K/DA 萨勒芬妮
  { baseSkinId: 147001, formIds: [147002, 147003] },
  // DJ 娑娜
  { baseSkinId: 37006, formIds: [37998, 37999] },
  // 奥术 破碎 金克丝
  { baseSkinId: 222060, formIds: [222998, 222999] },
  // Uzi 卡莎
  { baseSkinId: 145070, formIds: [145071, 145999] },
  // 佛耶戈（多形态）
  { baseSkinId: 234043, formIds: [234994, 234995, 234996, 234997, 234998, 234999] },
  // 枪神 普朗克（命运小姐）
  { baseSkinId: 21016, formIds: [21997, 21998, 21999] },
  // 九尾妖狐 阿狸（偶像歌手系列形态）
  { baseSkinId: 103085, formIds: [103086, 103087] },
]

const formGroupBySkinId = new Map<number, SkinFormGroup>()

for (const group of SKIN_FORM_GROUPS) {
  formGroupBySkinId.set(group.baseSkinId, group)
  for (const formId of group.formIds) {
    formGroupBySkinId.set(formId, group)
  }
}

/** 按皮肤 ID（基础皮肤或任一形态）查询形态组 */
function findSkinFormGroup(skinId: number): SkinFormGroup | null {
  return formGroupBySkinId.get(skinId) ?? null
}

// ==================== LCU 原始类型 ====================

interface RawChroma {
  id: number
  name: string
  chromaPath?: string
  colors?: string[]
  disabled?: boolean
  ownership?: { owned?: boolean }
}

interface RawSkin {
  id: number
  name: string
  isBase?: boolean
  tilePath?: string
  splashPath?: string
  uncenteredSplashPath?: string
  chromas?: RawChroma[]
}

interface RawChampion {
  id: number
  name: string
  skins?: RawSkin[]
}

interface RawInventoryChampion {
  id: number
  skins?: Array<{
    id: number
    ownership?: { owned?: boolean }
    chromas?: Array<{ id: number; ownership?: { owned?: boolean } }>
  }>
}

// ==================== 缓存 ====================

const cache = new Map<number, ChampionSkinData>()
const inflight = new Map<number, Promise<ChampionSkinData>>()

// ==================== 加载 ====================

/** 加载英雄皮肤数据（带缓存与并发合并） */
export function loadChampionSkinData(championId: number): Promise<ChampionSkinData> {
  if (championId <= 0) {
    return Promise.reject(new Error('无效的英雄 ID'))
  }

  const cached = cache.get(championId)
  if (cached) return Promise.resolve(cached)

  const pending = inflight.get(championId)
  if (pending) return pending

  const task = fetchChampionSkinData(championId)
    .then((data) => {
      cache.set(championId, data)
      return data
    })
    .finally(() => {
      inflight.delete(championId)
    })

  inflight.set(championId, task)
  return task
}

async function fetchChampionSkinData(championId: number): Promise<ChampionSkinData> {
  const raw = await fetchJson<RawChampion>(`/lol-game-data/assets/v1/champions/${championId}.json`)
  if (!raw || !Array.isArray(raw.skins) || raw.skins.length === 0) {
    throw new Error(`未能获取英雄 ${championId} 的皮肤数据`)
  }

  const ownership = await loadOwnership(championId)
  const rawIds = new Set(raw.skins.map((skin) => skin.id))
  const skins = raw.skins
    .filter((skin) => skin.id > 0)
    .map((skin) => toChampionSkin(skin, championId, rawIds, ownership))
    .sort((a, b) => Number(b.isBase) - Number(a.isBase) || a.id - b.id)

  return {
    championId,
    championName: raw.name || `英雄 ${championId}`,
    skins,
    ownershipKnown: ownership.known,
  }
}

/** 拥有状态表 */
interface OwnershipIndex {
  known: boolean
  skins: Set<number>
  chromas: Set<number>
}

const EMPTY_OWNERSHIP: OwnershipIndex = { known: false, skins: new Set(), chromas: new Set() }

async function loadOwnership(championId: number): Promise<OwnershipIndex> {
  try {
    const summonerId = await getSummonerId()
    if (!summonerId) return EMPTY_OWNERSHIP
    const inventory = await fetchJson<RawInventoryChampion>(
      `/lol-champions/v1/inventories/${summonerId}/champions/${championId}`,
    )
    if (!inventory) return EMPTY_OWNERSHIP

    const skins = new Set<number>()
    const chromas = new Set<number>()
    for (const skin of inventory.skins ?? []) {
      if (skin.ownership?.owned) skins.add(skin.id)
      for (const chroma of skin.chromas ?? []) {
        if (chroma.ownership?.owned) chromas.add(chroma.id)
      }
    }
    return { known: true, skins, chromas }
  } catch {
    // 拥有状态只影响展示标记，失败时降级即可，不阻断皮肤选择
    return EMPTY_OWNERSHIP
  }
}

let cachedSummonerId = 0

async function getSummonerId(): Promise<number> {
  if (cachedSummonerId > 0) return cachedSummonerId
  try {
    const summoner = await lcu.getSummonerInfo()
    cachedSummonerId = summoner.summonerId
    return cachedSummonerId
  } catch {
    return 0
  }
}

function toChampionSkin(
  raw: RawSkin,
  championId: number,
  presentIds: Set<number>,
  ownership: OwnershipIndex,
): ChampionSkin {
  const chromas: SkinChroma[] = (raw.chromas ?? [])
    .filter((chroma) => chroma.id > 0 && !chroma.disabled)
    .map((chroma) => ({
      id: chroma.id,
      name: chroma.name || `炫彩 ${chroma.id}`,
      colors: normalizeColors(chroma.colors),
      imagePath: chroma.chromaPath
        || `/lol-game-data/assets/v1/champion-chroma-images/${championId}/${chroma.id}.png`,
      owned: ownership.chromas.has(chroma.id),
    }))

  const formGroup = findSkinFormGroup(raw.id)
  const formIds = formGroup && formGroup.baseSkinId === raw.id ? formGroup.formIds : []
  const forms: SkinForm[] = formIds
    .map((formId, i) => ({ id: formId, index: i + 1 }))
    // 真实存在的形态 ID 会作为独立皮肤卡片展示，这里不重复
    .filter((form) => !presentIds.has(form.id))

  return {
    id: raw.id,
    name: raw.name || `皮肤 ${raw.id}`,
    isBase: Boolean(raw.isBase),
    owned: ownership.skins.has(raw.id),
    imagePath: raw.tilePath
      || raw.uncenteredSplashPath
      || raw.splashPath
      || `/lol-game-data/assets/v1/champion-tiles/${championId}/${raw.id}.jpg`,
    splashPath: raw.splashPath
      || raw.uncenteredSplashPath
      || `/lol-game-data/assets/v1/champion-splashes/${championId}/${raw.id}.jpg`,
    chromas,
    forms,
  }
}

/** 仅接受十六进制色值，避免把 LCU 返回的任意字符串拼进 CSS */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function normalizeColors(colors: string[] | undefined): string[] {
  if (!Array.isArray(colors)) return []
  return colors.filter((color) => typeof color === 'string' && HEX_COLOR.test(color))
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path)
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}
