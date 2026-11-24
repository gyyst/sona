/**
 * 换肤入口按钮的注入与清理
 *
 * 优先挂到选人界面右下角按钮区（与原生按钮并列，不遮挡皮肤轮播）；
 * 该容器不存在时回退到皮肤轮播容器右上角。
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { logger } from '@/index'
import { injector } from '@/lib/InjectorManager'
import { SkinChangerLauncher } from '@/components/ui/skin-changer/SkinChangerLauncher'

const LAUNCHER_ATTR = 'data-sona-skin-launcher'
const BUTTONS_SELECTOR = '.bottom-right-buttons'
const CAROUSEL_SELECTOR = '.skin-selection-carousel-container'

let launcherRoot: Root | null = null
let launcherMount: HTMLDivElement | null = null
let launcherContainer: HTMLElement | null = null
let launcherPositionBackup: string | null = null
let registered = false

/** 注册入口注入任务（幂等） */
export function registerSkinLauncher() {
  if (registered) return
  injector.register(tryInjectLauncher)
  registered = true
}

/** 移除入口按钮与注入任务 */
export function removeSkinLauncher() {
  if (registered) {
    injector.unregister(tryInjectLauncher)
    registered = false
  }

  try {
    launcherRoot?.unmount()
  } catch {
    // React 卸载失败不应阻断清理
  }
  launcherRoot = null
  launcherMount?.remove()
  launcherMount = null

  if (launcherContainer && launcherPositionBackup != null) {
    launcherContainer.style.position = launcherPositionBackup
  }
  launcherContainer = null
  launcherPositionBackup = null
}

function tryInjectLauncher(): boolean {
  if (launcherMount?.isConnected) return true

  // 客户端重建轮播后，旧的 root 已脱离 DOM：先卸载，避免 React root 泄漏
  if (launcherMount) {
    try {
      launcherRoot?.unmount()
    } catch {
      // ignore
    }
    launcherRoot = null
    launcherMount = null
  }

  const container = document.querySelector<HTMLElement>(BUTTONS_SELECTOR)
    ?? document.querySelector<HTMLElement>(CAROUSEL_SELECTOR)
  if (!container) return false

  const floating = container.matches(CAROUSEL_SELECTOR)
  if (floating) {
    launcherPositionBackup = container.style.position
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative'
    }
  }

  const mount = document.createElement('div')
  mount.setAttribute(LAUNCHER_ATTR, 'true')
  mount.className = floating
    ? 'sona-skin-launcher-mount'
    : 'sona-skin-launcher-mount sona-skin-launcher-mount--inline'
  container.appendChild(mount)

  launcherContainer = container
  launcherMount = mount
  launcherRoot = createRoot(mount)
  launcherRoot.render(createElement(SkinChangerLauncher))
  logger.info('[SkinChanger] 换肤入口已注入 ✓')
  return true
}
