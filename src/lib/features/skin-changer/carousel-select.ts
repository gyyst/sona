/**
 * 原生皮肤轮盘点击接管
 *
 * 客户端 16.23 实测结论：
 * - 未拥有皮肤卡片为 `.skin-selection-item.disabled`，点击不会写入 LCU；
 * - 手动 PATCH 未拥有皮肤返回 204，但 LCU 不回显；
 * - 卡片缩略图背景路径含 `Skins/SkinNN/` 或 `Skins/Base/`，可映射回 skinId。
 *
 * 因此未拥有卡片由 Sona 接管点击、走既有选择链路并自行维护选中态；
 * 已拥有卡片不阻止原生逻辑，只补发一次通知（LCU 值可能没有变化）。
 */

import { logger } from '@/index'
import { injector } from '@/lib/InjectorManager'
import { markManualSelection } from './auto-apply'
import { resetCarouselResolver, resolveItemSkinId } from './carousel-skin-resolver'
import { applySkinSelection, markAppliedSkin, notifySkinSelection } from './skin-apply'
import { findSkinBySelectionId, getSkinChangerState, type SkinChangerState } from './state'

// 客户端不同版本使用过不同的轮盘类名，按「容器优先」的顺序匹配
const CAROUSEL_SELECTOR = '.skin-selection-carousel-container, .skin-selection-carousel, .skin-carousel'
const CHAMP_SELECT_SCOPE = '.champion-select'
const ITEM_SELECTOR = '.skin-selection-item'
const DISABLED_CLASS = 'disabled'
const ARIA_DISABLED_ATTR = 'aria-disabled'
const SELECTED_CLASS = 'skin-selection-item-selected'
const SELECTED_ATTR = 'data-sona-skin-selected'

// ==================== 模块状态 ====================

let registered = false
let carousel: HTMLElement | null = null
let clickHandler: ((event: MouseEvent) => void) | null = null

// ==================== 对外：注册 / 注销 ====================

/** 注册轮盘接管（幂等） */
export function registerCarouselSelect() {
  if (registered) return
  injector.register(syncCarouselSelect)
  registered = true
  logger.info('[SkinChanger] 原生轮盘接管已启用')
}

/** 注销轮盘接管，清理监听与 Sona 标记 */
export function removeCarouselSelect() {
  if (!registered) return
  injector.unregister(syncCarouselSelect)
  registered = false
  detachListener()
  clearSelectionMarks()
  resetCarouselResolver()
  logger.info('[SkinChanger] 原生轮盘接管已停用')
}

// ==================== injector 任务 ====================

/** 每帧执行：挂载监听、同步选中态（幂等） */
function syncCarouselSelect(): boolean {
  attachListener()
  syncSelectionMarks(getSkinChangerState())
  return true
}

// ==================== 点击接管 ====================

function attachListener() {
  const element = document.querySelector<HTMLElement>(CAROUSEL_SELECTOR)
  if (!element) return
  if (element === carousel && clickHandler) return

  detachListener()
  carousel = element
  clickHandler = onCarouselClick
  carousel.addEventListener('click', clickHandler, true)
}

function detachListener() {
  if (carousel && clickHandler) {
    carousel.removeEventListener('click', clickHandler, true)
  }
  carousel = null
  clickHandler = null
}

/** 未拥有卡片：优先看 `disabled`，旧版客户端用 `aria-disabled` */
function isLockedItem(item: HTMLElement): boolean {
  return item.classList.contains(DISABLED_CLASS)
    || item.getAttribute(ARIA_DISABLED_ATTR) === 'true'
}

function onCarouselClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const item = target.closest<HTMLElement>(ITEM_SELECTOR)
  if (!item) return

  const locked = isLockedItem(item)
  if (locked) {
    // 未拥有卡片：先阻止原生购买弹窗，再由 Sona 接管选择
    event.preventDefault()
    event.stopPropagation()
  }

  const state = getSkinChangerState()
  if (state.championId <= 0 || state.skins.length === 0) return

  const skinId = resolveItemSkinId(item, state.championId, true)
  if (!skinId) {
    if (locked) logger.warn('[SkinChanger] 无法从轮盘卡片解析 skinId')
    return
  }

  if (locked) {
    // 手动选择后本局不再被随机/记忆覆盖；不等异步写入完成，避免竞态
    markManualSelection(state.championId)
    void applySkinSelection({
      championId: state.championId,
      skinId,
      skinName: findSkinBySelectionId(state.skins, skinId)?.name,
      owned: false,
      source: 'manual',
    }).catch((error) => {
      logger.warn('[SkinChanger] 轮盘选择皮肤失败: %o', error)
    })
    return
  }

  // 已拥有皮肤：交给客户端原生写 LCU，同时主动补发一次通知。
  // 否则「从未拥有皮肤切回当前已拥有皮肤」时 LCU 值没有变化，状态会停留在旧皮肤。
  const skin = findSkinBySelectionId(state.skins, skinId)
  if (!skin) return
  markAppliedSkin(skinId)
  notifySkinSelection({
    championId: state.championId,
    skinId,
    baseSkinId: skin.id,
    skinName: skin.name,
    owned: skin.owned,
    source: 'manual',
    timestamp: Date.now(),
  })
}

// ==================== 选中态同步 ====================

/** 把 Sona 的选中皮肤映射到轮盘卡片；只标记未拥有皮肤，已拥有交给客户端 */
function syncSelectionMarks(state: SkinChangerState) {
  const items = document.querySelectorAll<HTMLElement>(`${CHAMP_SELECT_SCOPE} ${ITEM_SELECTOR}`)
  if (items.length === 0) return

  const targetSkin = findSkinBySelectionId(state.skins, state.selectedSkinId)
  let target: HTMLElement | null = null
  if (targetSkin) {
    for (const item of items) {
      if (resolveItemSkinId(item, state.championId) === targetSkin.id) {
        target = item
        break
      }
    }
  }

  // 拥有状态未知时，改用客户端卡片自身的锁定标记判断是否未拥有
  const shouldMark = Boolean(
    targetSkin
    && target
    && (state.ownershipKnown ? !targetSkin.owned : isLockedItem(target)),
  )
  if (!shouldMark) target = null

  for (const item of items) {
    if (item === target) {
      item.classList.add(SELECTED_CLASS)
      item.setAttribute(SELECTED_ATTR, 'true')
      continue
    }

    // 只清理 Sona 自己加过的标记，不动客户端原生选中态
    if (item.hasAttribute(SELECTED_ATTR)) {
      item.removeAttribute(SELECTED_ATTR)
      item.classList.remove(SELECTED_CLASS)
    }
  }
}

function clearSelectionMarks() {
  document.querySelectorAll<HTMLElement>(`[${SELECTED_ATTR}]`).forEach((item) => {
    item.classList.remove(SELECTED_CLASS)
    item.removeAttribute(SELECTED_ATTR)
  })
}
