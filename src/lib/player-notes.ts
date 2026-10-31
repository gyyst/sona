/**
 * 玩家备注 / 黑名单的本地数据模块
 *
 * 纯数据操作：只读写 store，不碰 DOM、不发请求。
 *
 * key 规则（按优先级）：
 *   1. 真实 PUUID（跨对局、跨模式稳定）
 *   2. 匿名选人且无法还原时，使用 `obfuscated:<obfuscatedPuuid>` 临时记录
 *   3. 其余情况返回 null，不记录
 *
 * 禁止使用显示名 / summonerId 作为持久 key。
 */

import { store } from '@/lib/store'
import { deobfuscateChampSelectPuuid } from '@/lib/champ-select-puuid'

/** 匿名临时记录的 key 前缀 */
export const PLAYER_NOTE_OBFUSCATED_PREFIX = 'obfuscated:'

/** 备注文本上限（字符） */
export const MAX_PLAYER_NOTE_LENGTH = 200

export interface PlayerNote {
  /** 真实 PUUID；匿名临时记录时为空字符串 */
  puuid: string
  /** 记录时的显示名，仅用于展示，不参与匹配 */
  displayName: string
  note: string
  blacklisted: boolean
  /** 使用 obfuscated key 时为 true，UI 需标注标识可能不稳定 */
  anonymous: boolean
  updatedAt: number
}

/** 可用于解析备注 key 的玩家身份字段 */
export interface PlayerNoteIdentity {
  puuid?: string
  obfuscatedPuuid?: string
  nameVisibilityType?: string
}

/** 备注记录列表项 */
export interface PlayerNoteEntry {
  key: string
  note: PlayerNote
}

/**
 * 解析玩家备注 key。
 *
 * 匿名（HIDDEN）模式下先尝试用现有去混淆逻辑还原真实 PUUID；
 * 还原失败才退回 `obfuscated:<id>` 临时 key，避免把会话内混淆值
 * 当成长期标识。
 */
export function getPlayerNoteKey(player: PlayerNoteIdentity): string | null {
  const puuid = (player.puuid ?? '').trim()
  if (puuid) return puuid

  const obfuscatedPuuid = (player.obfuscatedPuuid ?? '').trim()
  if (player.nameVisibilityType === 'HIDDEN' && obfuscatedPuuid) {
    const restored = deobfuscateChampSelectPuuid(obfuscatedPuuid)
    if (restored) return restored
    return `${PLAYER_NOTE_OBFUSCATED_PREFIX}${obfuscatedPuuid.toLowerCase()}`
  }

  return null
}

/** key 是否来自无法还原的匿名标识 */
export function isObfuscatedPlayerNoteKey(key: string): boolean {
  return key.startsWith(PLAYER_NOTE_OBFUSCATED_PREFIX)
}

/** 读取单条备注 */
export function getPlayerNote(key: string | null | undefined): PlayerNote | undefined {
  if (!key) return undefined
  return store.get('playerNotes')[key]
}

/** 全部备注记录（按更新时间倒序） */
export function listPlayerNotes(): PlayerNoteEntry[] {
  return Object.entries(store.get('playerNotes'))
    .map(([key, note]) => ({ key, note }))
    .sort((a, b) => b.note.updatedAt - a.note.updatedAt)
}

/** 按显示名与备注文本搜索（仅用于管理界面，不参与运行时匹配） */
export function searchPlayerNotes(query: string): PlayerNoteEntry[] {
  const keyword = query.trim().toLowerCase()
  const entries = listPlayerNotes()
  if (!keyword) return entries
  return entries.filter(({ note }) => {
    return note.displayName.toLowerCase().includes(keyword)
      || note.note.toLowerCase().includes(keyword)
  })
}

export interface UpsertPlayerNoteInput {
  /** 由 getPlayerNoteKey 得到的稳定 key */
  key: string
  /** 真实 PUUID（key 本身为真实 PUUID 时可省略） */
  puuid?: string
  displayName?: string
  note: string
  blacklisted: boolean
  anonymous?: boolean
}

/**
 * 新增 / 更新备注。
 *
 * - 备注空白且未拉黑时删除记录，避免空记录堆积
 * - 备注超长时截断到 MAX_PLAYER_NOTE_LENGTH
 */
export function upsertPlayerNote(input: UpsertPlayerNoteInput): PlayerNote | null {
  const key = input.key.trim()
  if (!key) return null

  const current = store.get('playerNotes')
  const existing = current[key]
  const note = input.note.trim().slice(0, MAX_PLAYER_NOTE_LENGTH)
  const blacklisted = Boolean(input.blacklisted)

  if (!note && !blacklisted) {
    if (existing) {
      const next = { ...current }
      delete next[key]
      store.set('playerNotes', next)
    }
    return null
  }

  const anonymous = input.anonymous ?? isObfuscatedPlayerNoteKey(key)
  const record: PlayerNote = {
    puuid: input.puuid?.trim() || existing?.puuid || (isObfuscatedPlayerNoteKey(key) ? '' : key),
    displayName: input.displayName?.trim() || existing?.displayName || '',
    note,
    blacklisted,
    anonymous,
    updatedAt: Date.now(),
  }

  store.set('playerNotes', { ...current, [key]: record })
  return record
}

/** 删除一条备注 */
export function removePlayerNote(key: string): void {
  const current = store.get('playerNotes')
  if (!current[key]) return
  const next = { ...current }
  delete next[key]
  store.set('playerNotes', next)
}

/** 切换黑名单状态；取消拉黑且备注为空时删除记录 */
export function togglePlayerBlacklist(key: string): void {
  const current = store.get('playerNotes')
  const existing = current[key]
  if (!existing) return

  const blacklisted = !existing.blacklisted
  if (!blacklisted && !existing.note.trim()) {
    removePlayerNote(key)
    return
  }

  store.set('playerNotes', {
    ...current,
    [key]: {
      ...existing,
      blacklisted,
      updatedAt: Date.now(),
    },
  })
}
