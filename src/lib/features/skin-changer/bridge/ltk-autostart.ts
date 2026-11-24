/**
 * 尝试随 Sona 启动 LTK 后台
 *
 * Pengu 插件运行在客户端渲染进程，官方 API 没有启动外部进程的接口。
 * 如果运行环境恰好暴露了 Node 的 `require`（部分 Pengu 版本/环境可能提供），
 * 就从中加载 child_process 拉起随包分发的 `ltk/sona-ltk.exe`；
 * 否则返回 unsupported，由用户使用 `start-sona-ltk.bat` 或开机自启。
 */

import { logger } from '@/index'
import { store } from '@/lib/store'

export type LtkAutoStartResult = 'started' | 'unsupported' | 'missing' | 'error'

interface ChildProcessLike {
  unref?: () => void
}

interface NodePath {
  dirname: (value: string) => string
  join: (...parts: string[]) => string
}

interface NodeRequire {
  (id: 'child_process'): {
    spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcessLike
  }
  (id: 'path'): NodePath
  (id: 'fs'): {
    existsSync: (value: string) => boolean
  }
}

type NodeWindow = Window & { require?: NodeRequire }

let attempted = false

/** 把 getScriptPath() 的结果转成文件系统路径；URL 形式无法用于 spawn */
function toFileSystemPath(value: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(value)) return value
  if (!value.startsWith('file://')) return null
  try {
    const url = new URL(value)
    const decoded = decodeURIComponent(url.pathname)
    return decoded.replace(/^\//, '').replace(/\//g, '\\')
  } catch {
    return null
  }
}

/** 从脚本路径向上找到包含 ltk/sona-ltk.exe 的插件目录 */
function locateBackend(
  scriptPath: string,
  path: NodePath,
  fs: { existsSync: (v: string) => boolean },
): string | null {
  let directory = path.dirname(scriptPath)
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(directory, 'ltk', 'sona-ltk.exe')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

/** 启动随包分发的后台；force=true 允许在切换开关后重试 */
export function tryAutoStartLtkBackend(force = false): LtkAutoStartResult {
  if (attempted && !force) return 'started'
  if (!store.get('ltkBridgeEnabled') || !store.get('ltkAutoStart')) return 'unsupported'

  const nodeWindow = window as NodeWindow
  if (typeof nodeWindow.require !== 'function') {
    logger.info('[SkinChanger] 当前环境不支持自动启动 LTK 后台，请运行 ltk/start-sona-ltk.bat 或安装开机自启')
    return 'unsupported'
  }

  try {
    const path = nodeWindow.require('path')
    const fs = nodeWindow.require('fs')
    const scriptPath = toFileSystemPath(window.getScriptPath())
    if (!scriptPath) return 'unsupported'

    const executable = locateBackend(scriptPath, path, fs)
    if (!executable) {
      logger.warn('[SkinChanger] 未找到 ltk/sona-ltk.exe，自动启动跳过')
      return 'missing'
    }

    const { spawn } = nodeWindow.require('child_process')
    const child = spawn(executable, [
      '--port', String(store.get('ltkBridgePort')),
      '--token', store.get('ltkBridgeToken'),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref?.()
    attempted = true
    logger.info('[SkinChanger] 已自动启动 LTK 后台：%s', executable)
    return 'started'
  } catch (error) {
    logger.warn('[SkinChanger] 自动启动 LTK 后台失败：%s', String(error))
    return 'error'
  }
}
