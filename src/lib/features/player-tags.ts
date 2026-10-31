/**
 * 选人界面玩家标签注入
 *
 * 标签数据由 features.ts 在复用 SGP 战绩查询后推入，本模块不发起任何请求。
 * 注入任务只读取缓存并渲染 pill；找不到位置时返回 false，等待下一帧重试。
 */

import { logger } from '@/index'
import { lcu, LcuEventUri } from '@/lib/lcu'
import { injector } from '@/lib/InjectorManager'
import { getCurrentLocale, translate } from '@/i18n'
import { formatPlayerTag, type PlayerTag } from '@/lib/player-tags'
import { getChampSelectPlayerNodes, getPlayerIdentity } from '@/lib/features/champ-select-player-dom'

const TAG_ATTR = 'data-sona-player-tag'
const TAG_VERSION_ATTR = 'data-sona-player-tag-version'
const TAG_STRIP_CLASS = 'sona-player-tag-strip'
const NOTE_BADGE_ATTR = 'data-sona-player-note'
const MAX_VISIBLE_TAGS = 3

export interface ChampSelectPlayerTagEntry {
  /** 与 features.ts 中 TeammateStats 的稳定 key 一致 */
  key: string
  tags: PlayerTag[]
}

let unsubGameflow: (() => void) | null = null
let taskRegistered = false
let tagEntries: ChampSelectPlayerTagEntry[] = []
let hasInjectedTags = false

function cleanupPlayerTags() {
  document.querySelectorAll(`[${TAG_ATTR}]`).forEach((node) => node.remove())
  hasInjectedTags = false
}

function getTagVersion(tags: PlayerTag[]): string {
  // 以最终展示文本作为签名：语言切换或英雄资源就绪后会自动重建节点。
  const signature = tags
    .slice(0, MAX_VISIBLE_TAGS)
    .map((tag) => `${tag.tone}:${formatPlayerTag(tag, translate)}`)
    .join(',')
  return `${getCurrentLocale()}|${signature}`
}

function createTagStrip(entry: ChampSelectPlayerTagEntry, version: string, identity: string): HTMLSpanElement {
  const strip = document.createElement('span')
  strip.className = TAG_STRIP_CLASS
  strip.setAttribute(TAG_ATTR, entry.key)
  strip.setAttribute(TAG_VERSION_ATTR, version)

  const labels = entry.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => {
    const pill = document.createElement('span')
    pill.className = `sona-player-tag sona-player-tag--${tag.tone}`
    pill.textContent = formatPlayerTag(tag, translate)
    strip.appendChild(pill)
    return pill.textContent ?? ''
  })

  if (identity) {
    strip.title = `${identity}: ${labels.join(' · ')}`
    strip.setAttribute('aria-label', `${identity}: ${labels.join(' · ')}`)
  }

  return strip
}

/**
 * 注入任务：在队友名字（或备注徽标）后插入标签组。
 *
 * 幂等、轻量：仅做 DOM 比对，不计算标签、不查询网络。
 */
function tryInjectPlayerTags(): boolean {
  if (tagEntries.length === 0) {
    if (hasInjectedTags) cleanupPlayerTags()
    return true
  }

  const nodes = getChampSelectPlayerNodes()
  if (nodes.length === 0) return false

  nodes.forEach(({ wrapper, nameAnchor }, index) => {
    const entry = tagEntries[index]
    const existing = wrapper.querySelector(`[${TAG_ATTR}]`) as HTMLElement | null

    if (!entry || !nameAnchor || entry.tags.length === 0) {
      existing?.remove()
      return
    }

    const version = getTagVersion(entry.tags)
    const noteBadge = wrapper.querySelector(`[${NOTE_BADGE_ATTR}]`) as HTMLElement | null
    // 备注 / 黑名单优先展示，标签始终排在它后面
    const anchor = noteBadge ?? nameAnchor

    if (
      existing
      && existing.getAttribute(TAG_ATTR) === entry.key
      && existing.getAttribute(TAG_VERSION_ATTR) === version
    ) {
      if (existing.previousElementSibling !== anchor) anchor.after(existing)
      return
    }

    existing?.remove()
    anchor.after(createTagStrip(entry, version, getPlayerIdentity(wrapper)))
    hasInjectedTags = true
  })

  return true
}

/** 由 features.ts 在完成一轮队友战绩查询 / 换楼重建后调用 */
export function setChampSelectPlayerTags(entries: ChampSelectPlayerTagEntry[]) {
  tagEntries = Array.isArray(entries) ? entries : []
  if (!taskRegistered) return
  try {
    tryInjectPlayerTags()
  } catch (err) {
    logger.error('[PlayerTags] 刷新玩家标签失败:', err)
  }
}

/** 清空缓存与 DOM（离开选人阶段 / 关闭功能时） */
export function clearChampSelectPlayerTags() {
  tagEntries = []
  cleanupPlayerTags()
}

/** 启用 / 停用玩家标签功能（幂等） */
export function updatePlayerTags(enabled: boolean) {
  if (enabled && !unsubGameflow) {
    unsubGameflow = lcu.observe(LcuEventUri.GAMEFLOW_PHASE_CHANGE, () => {
      // 进入新选人阶段或离开选人阶段时都先清空上一轮缓存，
      // 避免本轮查询失败时展示过期标签。
      clearChampSelectPlayerTags()
    })

    if (!taskRegistered) {
      injector.register(tryInjectPlayerTags)
      taskRegistered = true
    }

    // 启动时可能已经在选人阶段；缓存为空时注入任务会安全跳过
    clearChampSelectPlayerTags()
    logger.info('Player tagging enabled ✓')
  } else if (!enabled && unsubGameflow) {
    unsubGameflow()
    unsubGameflow = null

    if (taskRegistered) {
      injector.unregister(tryInjectPlayerTags)
      taskRegistered = false
    }

    clearChampSelectPlayerTags()
    logger.info('Player tagging disabled')
  }
}
