/**
 * 皮肤轮播预览解锁
 *
 * 与 Rose 的 ROSE-UI 同源：客户端把未拥有的皮肤渲染成灰色 + 锁标 + disabled，
 * 这里通过两层手段解除：
 *   1. body[data-sona-skin-unlock] 下的 CSS 覆盖（去灰、去锁、恢复 pointer-events）
 *   2. 把 `.unowned` / `.purchase-available` / `.purchase-disabled` 等状态类改写成已拥有
 *
 * 只改客户端本地渲染，不修改账号数据。
 */

export const SKIN_UNLOCK_ATTR = 'data-sona-skin-unlock'

/** 开关预览解锁（通过 body 属性控制 CSS 作用域） */
export function setSkinPreviewUnlock(enabled: boolean) {
  if (enabled) {
    document.body.setAttribute(SKIN_UNLOCK_ATTR, 'true')
  } else {
    document.body.removeAttribute(SKIN_UNLOCK_ATTR)
  }
}

/**
 * 扫描并改写皮肤轮播中的状态类。
 *
 * 作为 InjectorManager 任务运行：客户端重建 DOM 后会自动补回。
 * 只在选人界面容器内操作，避免影响商店、藏品等其他页面的购买状态。
 */
export function scanSkinPreviewUnlock(): boolean {
  if (!document.body.hasAttribute(SKIN_UNLOCK_ATTR)) return true

  const root = document.querySelector('.champion-select')
  if (!root) return true

  root.querySelectorAll('.thumbnail-wrapper.unowned').forEach((element) => {
    element.classList.remove('unowned')
    element.classList.add('owned')
  })

  root.querySelectorAll('.purchase-available').forEach((element) => {
    element.classList.remove('purchase-available')
    element.classList.add('active')
  })

  root.querySelectorAll('.purchase-disabled').forEach((element) => {
    element.classList.remove('purchase-disabled')
  })

  return true
}
