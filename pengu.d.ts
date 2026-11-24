/**
 * PenguLoader Runtime API Type Declarations
 * @see https://pengu.lol/runtime-api
 */

import type { Root } from 'react-dom/client'

declare global {
  interface PenguContext {
    meta: {
      name: string
      version?: string
      [key: string]: unknown
    }
    rcp: {
      preInit: (name: string, callback: (api: unknown) => void) => void
      /**
       * 当指定 RCP 模块初始化后触发回调。
       *
       * @param name 目标 RCP 模块名（如 'rcp-fe-ember-libs'）
       * @param callback 收到该模块 api 对象的回调
       * @param blocking 关键参数：
       *   - false（默认）：仅对"未来的初始化事件"生效；若目标模块已经初始化过，回调不会补跑。
       *                    这意味着 Pengu HMR / 页面 reload 后注册的回调可能错过时机。
       *   - true：即使目标模块已初始化，也会用缓存 api 立即补跑一次回调；
       *           且目标模块会等回调 Promise 完成才继续后续初始化——
       *           hook 类用法（如劫持 getEmber）必须传 true，否则可能漏过劫持窗口。
       */
      postInit: (name: string, callback: (api: unknown) => unknown, blocking?: boolean) => void
      /**
       * 像 postInit 一样等待 RCP 就绪，但以 Promise 方式返回，**即使目标插件已经加载完也能拿到**。
       * 是比 postInit 更健壮的选择——不受插件加载时机影响。
       *
       * @example
       *   const chat = await context.rcp.whenReady('rcp-be-lol-chat')
       *   const [a, b] = await context.rcp.whenReady(['rcp-a', 'rcp-b'])
       */
      whenReady: {
        (name: string): Promise<unknown>
        (names: string[]): Promise<unknown[]>
      }
      /** 同步获取已注册到 callbacks map 的 RCP 插件（需先通过 whenReady/postInit 注册） */
      get: (name: string) => unknown
    }
    socket: {
      observe: (uri: string, callback: (data: unknown) => void) => void
      disconnect: () => void
    }
  }

  interface Window {
    /** Opens Chrome DevTools window */
    openDevTools(remote?: boolean): void
    /** Opens the plugins folder */
    openPluginsFolder(path?: string): void
    /** Reloads the client (ignores cache) */
    reloadClient(): void
    /** Restarts the client (all UX processes) */
    restartClient(): void
    /** Gets the current script path */
    getScriptPath(): string
    /** Sona plugin runtime state */
    __SONA_RUNTIME__?: SonaRuntime
    /** Sona 冻结引导器写入的本次运行信息 */
    __SONA_BOOTSTRAP__?: SonaBootstrapInfo
    /**
     * Sona 插件目录的显式基址（以 / 结尾）。
     * 缓存/远程加载应用包时 import.meta.url 不再指向插件目录，资源解析必须依赖它。
     */
    __SONA_PLUGIN_BASE_URL__?: string
  }

  /** Pengu Loader namespace */
  const Pengu: {
    /** Current Pengu Loader version */
    version: string
    /** Pengu 设置中的“自动检查插件更新”；false 时插件不得发起自动更新请求 */
    autoUpdateCheck?: boolean
  }

  /** Toast notification API @since v1.1.0 */
  const Toast: {
    /** Push a notification with a success checkmark icon */
    success(message: string): void
    /** Push a notification with a failure icon */
    error(message: string): void
    /** Push a progress notification that awaits a promise */
    promise<T>(promise: Promise<T>, msg: { loading: string; success: string; error: string }): Promise<T>
  }

  /**
   * DataStore - 持久化存储 API
   * 数据以 JSON 格式存储在磁盘上
   * @see https://pengu.lol/runtime-api/data-store
   */
  const DataStore: {
    /** 存储数据，返回是否成功 */
    set(key: string | number, value: unknown): boolean
    /** 读取数据，不存在时返回 fallback 或 undefined */
    get<T = unknown>(key: string | number, fallback?: T): T | undefined
    /** 检查键是否存在 */
    has(key: string | number): boolean
    /** 移除数据，返回是否成功 */
    remove(key: string | number): boolean
  }

  /**
   * Effect - 窗口视觉效果 API
   * @see https://pengu.dev/runtime-api/effect
   */
  const Effect: {
    /** 应用窗口视觉效果 */
    apply(name: 'transparent' | 'blurbehind' | 'acrylic' | 'unified' | 'mica' | 'vibrancy', options?: { color?: string; material?: string; alwaysOn?: boolean }): void
    /** 清除当前效果 */
    clear(): void
    /** 设置主题 */
    setTheme(theme: 'light' | 'dark'): void
  }

  /** DataStore 中的待更新指针（键：sona:updatePointer） */
  interface SonaUpdatePointer {
    /** 目标版本，如 1.13.1 */
    version: string
    /** Release tag，如 v1.13.1 */
    tag: string
    /** app.js 的 HTTPS 下载地址 */
    appUrl: string
    /** app.css 的 HTTPS 下载地址 */
    cssUrl: string
    /** app.js 的 SHA-256（64 位小写十六进制） */
    appSha256: string
    /** app.css 的 SHA-256（64 位小写十六进制） */
    cssSha256: string
    /** 写入时间戳 */
    savedAt: number
  }

  /** IndexedDB（sona-updates/bundles）中的缓存应用包 */
  interface SonaCachedBundle {
    /** 固定为 pending */
    id: string
    version: string
    /** app.js 全文 */
    appSource: string
    /** app.css 全文 */
    cssSource: string
    savedAt: number
  }

  /** 冻结引导器写入 window.__SONA_BOOTSTRAP__ 的本次运行信息 */
  interface SonaBootstrapInfo {
    /** 运行来源：本地 app.js / IndexedDB 缓存 / 远程 CDN */
    source: 'local' | 'cache' | 'remote'
    /** 实际运行的版本 */
    runningVersion: string
    /** 本地 version.json 中的版本（读取失败时为 0.0.0） */
    localVersion: string
    /** 本次尝试加载的待更新版本 */
    attemptedVersion?: string
    /** 缓存/远程加载失败并回退本地时的原因 */
    error?: string
  }

  type SonaRuntime = {
    container: HTMLDivElement | null
    root: Root | null
    hasShownStartupToast: boolean
    hasShownSpecialDayToast: boolean
  }
}

export {}
