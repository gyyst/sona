/**
 * 选人界面队友 DOM 辅助
 *
 * 选人界面由 Ember 管理，节点会随时重建。这里集中维护选择器，
 * 供玩家备注、玩家标签等注入任务共用，避免各模块复制同一套选择器。
 */

const PLAYER_WRAPPER_SELECTOR = '.party.visible .summoner-wrapper.visible.left'
const PLAYER_NAME_SELECTOR = '.player-name-wrapper'

export interface ChampSelectPlayerNode {
  wrapper: Element
  /** 名字节点；Ember 重建过程中可能暂时缺失 */
  nameAnchor: HTMLElement | null
}

/**
 * 当前可见的队友节点（按 DOM 顺序）。
 *
 * 顺序与 `ChampSelectSession.myTeam` 过滤空位后的顺序一致，
 * 调用方可以按索引与 session 数据对齐。
 */
export function getChampSelectPlayerNodes(): ChampSelectPlayerNode[] {
  if (typeof document === 'undefined') return []

  return Array.from(document.querySelectorAll(PLAYER_WRAPPER_SELECTOR)).map((wrapper) => ({
    wrapper,
    nameAnchor: wrapper.querySelector(PLAYER_NAME_SELECTOR) as HTMLElement | null,
  }))
}

/**
 * 读取节点上的展示名。
 *
 * 仅用于展示 / 无障碍标签，不能作为持久化 key（改名、重名、匿名模式都会失效）。
 */
export function getPlayerIdentity(node: Element): string {
  const nameAnchor = node.matches(PLAYER_NAME_SELECTOR)
    ? node
    : node.querySelector(PLAYER_NAME_SELECTOR)
  return (nameAnchor?.textContent ?? '').trim()
}
