/**
 * Sona 自动更新核心类型与共享契约
 *
 * 冻结契约（引导器 src/bootstrap/index.ts 只认这些字段，不能随意修改）：
 * - DataStore 指针键 sona:updatePointer，字段见 SonaUpdatePointer
 * - IndexedDB sona-updates / bundles / pending，字段见 SonaCachedBundle
 * - 清单 update.json：{ version, files: { 'app.js': { sha256, size }, 'app.css': { sha256, size } } }
 */

/** 更新状态机的 7 个状态 */
export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'

/** 错误来源：更新页据此展示不同的可操作提示 */
export type UpdateErrorKind = 'none' | 'check' | 'download' | 'bootstrap'

export interface UpdateInfo {
  /** 当前实际运行版本（来自引导器，而不是本地版本） */
  currentVersion: string
  latestVersion: string
  releaseName: string
  releaseUrl: string
  releaseBody: string
  publishedAt: string
}

/** 应用侧读取到的本次运行信息（由冻结引导器写入） */
export interface UpdateRuntimeInfo {
  source: SonaBootstrapInfo['source']
  runningVersion: string
  localVersion: string
  /** 本次启动尝试加载的待更新版本；未尝试时为空 */
  attemptedVersion: string
  /** 引导器回退本地时的原因 */
  error: string
}

export interface UpdateState {
  status: UpdateStatus
  /** available 之后可用；ready 时保留，便于展示更新说明 */
  info: UpdateInfo | null
  error: string
  errorKind: UpdateErrorKind
  runtime: UpdateRuntimeInfo
  /** DataStore 待更新指针指向的版本；无指针时为空 */
  pendingVersion: string
  /** 待更新包是否已成功写入 IndexedDB（写入失败时依赖远程 URL） */
  cached: boolean
}

/** update.json 中的单文件条目 */
export interface UpdateManifestFile {
  sha256: string
  size: number
}

/** dist-v<version> 标签中的 update.json */
export interface UpdateManifest {
  version: string
  files: Record<'app.js' | 'app.css', UpdateManifestFile>
}

/** 下载并校验通过、尚未写入存储的更新包 */
export interface PreparedUpdate {
  pointer: SonaUpdatePointer
  appSource: string
  cssSource: string
}

/** 唯一更新源仓库 */
export const UPDATE_REPO = 'gyyst/sona'

/** 允许的更新产物主机（HTTPS），与冻结引导器保持一致 */
export const ALLOWED_UPDATE_HOSTS: ReadonlySet<string> = new Set([
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
])

/** 需要侧边栏更新入口、入口徽标保持可见的状态集合 */
const UPDATE_FLOW_STATUSES: ReadonlySet<UpdateStatus> = new Set(['available', 'downloading', 'ready'])

export function isUpdateFlowActive(status: UpdateStatus): boolean {
  return UPDATE_FLOW_STATUSES.has(status)
}

/**
 * 需要用户关注/处理的状态：更新流程进行中，或出现可操作的错误。
 * 常规检查失败（errorKind === 'check'）不占用侧边栏入口，避免网络波动长期打扰。
 */
export function isUpdateAttentionRequired(
  state: Pick<UpdateState, 'status' | 'errorKind' | 'pendingVersion'>,
): boolean {
  if (isUpdateFlowActive(state.status)) return true
  if (state.status === 'error' && state.errorKind !== 'check') return true
  // 手动复查已就绪版本时状态短暂变为 checking，但仍应保留更新入口与重启操作
  return state.status === 'checking' && Boolean(state.pendingVersion)
}

/** 指针中的产物 URL 是否可信：HTTPS + 白名单主机 + 预期文件名 */
export function isTrustedArtifactUrl(value: string, fileName: 'app.js' | 'app.css'): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && ALLOWED_UPDATE_HOSTS.has(url.hostname)
      && url.pathname.endsWith(`/${fileName}`)
  } catch {
    return false
  }
}
