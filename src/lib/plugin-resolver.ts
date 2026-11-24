const FALLBACK_PLUGIN_FOLDER = 'sona'
const PLUGINS_MARKER = '/plugins/'

let pluginBaseUrl = `//plugins/${FALLBACK_PLUGIN_FOLDER}/`
let pluginFolderPath = FALLBACK_PLUGIN_FOLDER

function logResolver(reason: string, details: Record<string, unknown> = {}) {
  console.info('[Sona][PluginResolver] %s', reason, {
    ...details,
    pluginBaseUrl,
    pluginFolderPath,
  })
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function trimQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value
}

function decodeFolderPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function encodePathSegment(segment: string): string {
  // @author/sona 这类目录：@ 是合法路径字符，不能编码成 %40
  return encodeURIComponent(segment).replace(/%40/g, '@')
}

/** 从脚本路径 / 模块 URL / 插件基址中提取插件目录（支持 @author/sona 这类多级目录） */
function extractFolderPath(value: string, stripFileName: boolean): string | null {
  const normalized = trimQueryAndHash(normalizePath(value))
  const markerIndex = normalized.toLowerCase().lastIndexOf(PLUGINS_MARKER)
  if (markerIndex < 0) return null

  let rest = normalized.slice(markerIndex + PLUGINS_MARKER.length)
  if (stripFileName) rest = rest.replace(/[^/]+$/, '')
  rest = rest.replace(/\/+$/, '')
  return rest ? decodeFolderPath(rest) : null
}

function buildPluginBaseUrl(folderPath: string): string {
  const encoded = folderPath.split('/').filter(Boolean).map(encodePathSegment).join('/')
  return `//plugins/${encoded}/`
}

function applyFolderPath(folderPath: string) {
  pluginFolderPath = folderPath
  pluginBaseUrl = buildPluginBaseUrl(folderPath)
}

function applyExplicitBaseUrl(baseUrl: string, folderPath: string) {
  const normalized = trimQueryAndHash(normalizePath(baseUrl))
  pluginFolderPath = folderPath
  pluginBaseUrl = normalized.endsWith('/') ? normalized : `${normalized}/`
}

function getContextPluginName(context?: PenguContext): string | null {
  const metaName = context?.meta?.name
  return typeof metaName === 'string' && metaName ? metaName : null
}

function safeGetScriptPath(): string {
  try {
    return typeof window.getScriptPath === 'function' ? window.getScriptPath() : ''
  } catch {
    return ''
  }
}

export function initPluginResolver(metaUrl?: string, context?: PenguContext) {
  // 1. 引导器显式基址（缓存/远程运行应用包时 import.meta.url 已不在插件目录）
  const explicitBaseUrl = typeof window.__SONA_PLUGIN_BASE_URL__ === 'string'
    ? window.__SONA_PLUGIN_BASE_URL__.trim()
    : ''
  const explicitFolderPath = explicitBaseUrl ? extractFolderPath(explicitBaseUrl, false) : null
  if (explicitBaseUrl && explicitFolderPath) {
    applyExplicitBaseUrl(explicitBaseUrl, explicitFolderPath)
    logResolver('initialized from __SONA_PLUGIN_BASE_URL__', { metaUrl, explicitBaseUrl })
    return
  }

  // 2. Pengu 提供的脚本路径（最可靠的本地目录来源）
  const scriptPath = safeGetScriptPath()
  const scriptFolderPath = scriptPath ? extractFolderPath(scriptPath, true) : null
  if (scriptFolderPath) {
    applyFolderPath(scriptFolderPath)
    logResolver('initialized from window.getScriptPath() plugin folder', { metaUrl, scriptPath })
    return
  }

  // 3. 当前模块 URL
  const metaFolderPath = metaUrl ? extractFolderPath(metaUrl, true) : null
  if (metaFolderPath) {
    applyFolderPath(metaFolderPath)
    logResolver('initialized from import.meta.url plugin folder', { metaUrl })
    return
  }

  // 4. 兜底：Pengu context 中的插件名
  const contextName = getContextPluginName(context)
  if (contextName) pluginFolderPath = contextName
  pluginBaseUrl = buildPluginBaseUrl(pluginFolderPath)
  logResolver('initialized from context fallback', {
    metaUrl,
    contextPluginName: contextName,
    scriptPath,
  })
}

export function resolvePluginAssetUrl(assetPath: string): string {
  const normalizedPath = normalizePath(assetPath)
    .replace(/^\.\/+/, '')
    .replace(/^assets\/+/i, '')
    .replace(/^\/+/, '')

  return `${pluginBaseUrl}assets/${normalizedPath.split('/').map(encodeURIComponent).join('/')}`
}

export function getPluginAssetsFolderPath(): string {
  return `${pluginFolderPath}/assets`
}
