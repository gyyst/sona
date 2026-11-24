/**
 * 探测脚本：观察英雄选择界面 selectedSkinId 的变化（Gate 0 实测）
 *
 * 目的：
 *   1. 客户端原生皮肤轮盘点击未拥有皮肤时，是否真的把 selectedSkinId 写入 LCU？
 *   2. 点击炫彩时写入的是皮肤 ID 还是炫彩 ID？
 *   3. 客户端是否会在响应返回后把选中态回滚？
 *   4. 进入选人时 selectedSkinId 的初始值是什么？
 *
 * 用法：
 *   1. 启动英雄联盟客户端并进入英雄选择（匹配/征召/自定义均可）
 *   2. 运行 ./scripts/probe-champ-select-skin.sh
 *   3. 在原生轮盘依次点击：已拥有皮肤 → 未拥有皮肤（先开启 Sona「解锁皮肤预览」）→ 炫彩
 *   4. 每次点击后停留 2 秒，观察 [change] 行
 *   5. Ctrl+C 结束，或 --seconds=120 自动结束
 *
 * 只在本机读取 LCU 凭据，不上传任何数据；凭据不写入日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket, Agent, fetch as undiciFetch } from 'undici'

const CLIENT_DIR = process.env.LOL_CLIENT_DIR || 'D:/WeGameApps/英雄联盟/LeagueClient'
const LOCKFILE = path.join(CLIENT_DIR, 'lockfile')
const OUT_DIR = process.env.LOL_PROBE_OUT || path.join(process.cwd(), 'logs')
const CHANGE_LOG = path.join(OUT_DIR, 'probe-champ-select-skin.log')
const RAW_LOG = path.join(OUT_DIR, 'probe-champ-select-skin-raw.log')
const SECONDS_ARG = process.argv.find((arg) => arg.startsWith('--seconds='))
const CAPTURE_SECONDS = SECONDS_ARG ? Number(SECONDS_ARG.split('=')[1]) : 0
const POLL_MS = 500

fs.mkdirSync(OUT_DIR, { recursive: true })

function append(file, line) {
  try {
    fs.appendFileSync(file, line)
  } catch {
    // 日志写入失败不应中断探测
  }
}

function log(line) {
  const stamped = `${new Date().toISOString()}\t${line}`
  console.log(line)
  append(CHANGE_LOG, `${stamped}\n`)
}

// ==================== LCU 凭据 ====================

function readLockfileCredentials() {
  try {
    const raw = fs.readFileSync(LOCKFILE, 'utf8').trim()
    const [name, pid, port, token, protocol] = raw.split(':')
    if (!port || !token) return null
    return { source: 'lockfile', name, pid, port, token, protocol: protocol || 'https' }
  } catch {
    return null
  }
}

/** 腾讯/WeGame 客户端可能不写 lockfile，从最新 LeagueClientUx 日志解析 --app-port / --remoting-auth-token */
function readLogCredentials() {
  let entries
  try {
    entries = fs.readdirSync(CLIENT_DIR)
  } catch {
    return null
  }

  const logs = entries
    .filter((name) => /_LeagueClientUx\.log$/i.test(name))
    .map((name) => {
      const filePath = path.join(CLIENT_DIR, name)
      return { filePath, mtime: fs.statSync(filePath).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)

  for (const item of logs) {
    const text = fs.readFileSync(item.filePath, 'utf8')
    const port = text.match(/--app-port=(\d+)/)
    const token = text.match(/--remoting-auth-token=([^\s"]+)/)
    if (port && token) {
      return { source: `log:${path.basename(item.filePath)}`, name: 'LeagueClient', pid: '', port: port[1], token: token[1], protocol: 'https' }
    }
  }

  return null
}

const credentials = readLockfileCredentials() || readLogCredentials()
if (!credentials) {
  throw new Error(
    `无法获取 LCU 端口和 token。\nlockfile：${LOCKFILE}\n客户端目录：${CLIENT_DIR}\n请先启动英雄联盟客户端并登录，或用 LOL_CLIENT_DIR 指定目录。`,
  )
}

const { source, name, pid, port, token, protocol } = credentials
const isHttp = protocol === 'http'
const wsUrl = `${isHttp ? 'ws' : 'wss'}://127.0.0.1:${port}/`
const httpBase = `${isHttp ? 'http' : 'https'}://127.0.0.1:${port}`
const auth = `Basic ${Buffer.from(`riot:${token}`).toString('base64')}`
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

log(`[probe] credentials source=${source} client=${name} pid=${pid} protocol=${protocol}`)
log(`[probe] output=${OUT_DIR}`)

async function lcuGet(pathname) {
  const response = await undiciFetch(`${httpBase}${pathname}`, { headers: { Authorization: auth }, dispatcher })
  if (!response.ok) throw new Error(`${response.status} ${pathname}`)
  return response.json()
}

// ==================== 皮肤数据反查 ====================

const championInfoCache = new Map()
const championInfoInflight = new Map()
let cachedSummonerId = 0

async function getSummonerId() {
  if (cachedSummonerId > 0) return cachedSummonerId
  try {
    const summoner = await lcuGet('/lol-summoner/v1/current-summoner')
    cachedSummonerId = summoner?.summonerId ?? 0
  } catch {
    cachedSummonerId = 0
  }
  return cachedSummonerId
}

/** @returns {Promise<{ skins: Map<number, {name: string, isBase: boolean}>, chromas: Map<number, {name: string, skinId: number}>, ownedSkins: Set<number>, ownedChromas: Set<number> } | null>} */
function getChampionInfo(championId) {
  if (championInfoCache.has(championId)) return Promise.resolve(championInfoCache.get(championId))
  if (championInfoInflight.has(championId)) return championInfoInflight.get(championId)

  const task = (async () => {
    try {
      const raw = await lcuGet(`/lol-game-data/assets/v1/champions/${championId}.json`)
      const skins = new Map()
      const chromas = new Map()
      for (const skin of raw.skins || []) {
        skins.set(skin.id, { name: skin.name || `皮肤 ${skin.id}`, isBase: Boolean(skin.isBase) })
        for (const chroma of skin.chromas || []) {
          chromas.set(chroma.id, { name: chroma.name || `炫彩 ${chroma.id}`, skinId: skin.id })
        }
      }

      const ownedSkins = new Set()
      const ownedChromas = new Set()
      const summonerId = await getSummonerId()
      if (summonerId > 0) {
        try {
          const inventory = await lcuGet(`/lol-champions/v1/inventories/${summonerId}/champions/${championId}`)
          for (const skin of inventory.skins || []) {
            if (skin.ownership?.owned) ownedSkins.add(skin.id)
            for (const chroma of skin.chromas || []) {
              if (chroma.ownership?.owned) ownedChromas.add(chroma.id)
            }
          }
        } catch {
          // 拥有状态只用于日志标注
        }
      }

      return { skins, chromas, ownedSkins, ownedChromas }
    } catch {
      return null
    }
  })().finally(() => championInfoInflight.delete(championId))

  championInfoInflight.set(championId, task)
  task.then((info) => championInfoCache.set(championId, info))
  return task
}

async function describeSkinId(championId, skinId) {
  if (!skinId) return '未选择'
  const info = await getChampionInfo(championId)
  if (!info) return `skinId=${skinId}（皮肤数据不可用）`

  if (info.skins.has(skinId)) {
    const skin = info.skins.get(skinId)
    return `skinId=${skinId}「${skin.name}」皮肤 owned=${info.ownedSkins.has(skinId)}`
  }
  if (info.chromas.has(skinId)) {
    const chroma = info.chromas.get(skinId)
    const skin = info.skins.get(chroma.skinId)
    return `skinId=${skinId}「${chroma.name}」炫彩 归属皮肤=${chroma.skinId}「${skin?.name ?? '?'}」owned=${info.ownedChromas.has(skinId)}`
  }
  return `skinId=${skinId}（未在皮肤数据中找到）`
}

async function printChampionSkins(championId) {
  const info = await getChampionInfo(championId)
  if (!info) {
    log(`[skins] champion=${championId} 皮肤数据不可用`)
    return
  }
  const lines = [...info.skins.entries()].map(([id, skin]) => {
    const owned = info.ownedSkins.has(id) ? 'owned' : 'UNOWNED'
    const chromaText = [...info.chromas.entries()]
      .filter(([, chroma]) => chroma.skinId === id)
      .map(([chromaId, chroma]) => `${chromaId}:${chroma.name}${info.ownedChromas.has(chromaId) ? '' : '(未拥有)'}`)
      .join(', ')
    return `  ${id} ${skin.name} [${owned}]${chromaText ? ` chromas=[${chromaText}]` : ''}`
  })
  log(`[skins] champion=${championId} 皮肤清单：\n${lines.join('\n')}`)
}

// ==================== 会话观察 ====================

let lastPhase = ''
let lastSelectionKey = ''
let lastChampionId = 0
let lastSelectedSkinId = 0

function readLocalSelection(session) {
  const cellId = session?.localPlayerCellId
  const me = (session?.myTeam || []).find((player) => player.cellId === cellId)
  if (!me) return null
  return { championId: me.championId || 0, selectedSkinId: me.selectedSkinId || 0 }
}

async function handleSession(sourceLabel, session, phaseHint) {
  const phase = phaseHint || lastPhase
  if (phase && phase !== lastPhase) {
    lastPhase = phase
    log(`[phase] ${phase}`)
  }

  const selection = readLocalSelection(session)
  if (!selection) {
    if (lastSelectionKey !== 'none') {
      lastSelectionKey = 'none'
      log('[session] 当前无本人队伍成员数据')
    }
    return
  }

  const { championId, selectedSkinId } = selection
  const key = `${championId}:${selectedSkinId}`
  if (championId !== lastChampionId) {
    lastChampionId = championId
    if (championId > 0) void printChampionSkins(championId)
  }

  if (key === lastSelectionKey) return
  const previous = lastSelectedSkinId
  lastSelectionKey = key
  lastSelectedSkinId = selectedSkinId

  const description = await describeSkinId(championId, selectedSkinId)
  log(
    `[change] src=${sourceLabel} champion=${championId} ${previous} -> ${selectedSkinId} | ${description}`
    + (previous === 0 ? ' | 首次快照' : ''),
  )
}

// ==================== WS ====================

const ws = new WebSocket(wsUrl, { headers: { Authorization: auth }, dispatcher })
let eventCount = 0

ws.addEventListener('open', () => {
  log(`[ws] connected ${wsUrl}`)
  ws.send(JSON.stringify([5, 'OnJsonApiEvent']))
})

ws.addEventListener('error', (event) => {
  log(`[ws] error ${event.message || String(event)}`)
})

ws.addEventListener('close', (event) => {
  log(`[ws] closed ${event.code} ${event.reason || ''}`)
})

ws.addEventListener('message', (event) => {
  const text = typeof event.data === 'string' ? event.data : ''
  if (!text) return
  let message
  try { message = JSON.parse(text) } catch { return }
  if (!Array.isArray(message) || message[0] !== 8) return

  eventCount += 1
  const uri = String(message[2]?.uri || '')
  const data = message[2]?.data

  if (/champ-select|gameflow/i.test(uri)) {
    append(RAW_LOG, `${new Date().toISOString()}\t${uri}\t${JSON.stringify(data).slice(0, 20000)}\n`)
  }

  if (uri === '/lol-champ-select/v1/session') {
    void handleSession('ws', data)
  } else if (uri === '/lol-gameflow/v1/session') {
    const phase = data?.phase || ''
    if (phase && phase !== lastPhase) {
      lastPhase = phase
      log(`[phase] ${phase}`)
    }
  }
})

// ==================== HTTP 兜底轮询 ====================

setInterval(async () => {
  try {
    const session = await lcuGet('/lol-champ-select/v1/session')
    await handleSession('poll', session)
  } catch {
    // 不在选人阶段时接口返回 404
  }
}, POLL_MS)

setInterval(() => {
  log(`[stats] wsEvents=${eventCount} phase=${lastPhase || '?'} champion=${lastChampionId} selectedSkinId=${lastSelectedSkinId}`)
}, 15000)

function shutdown() {
  log(`[probe] 结束，日志：${CHANGE_LOG}\n  原始事件：${RAW_LOG}`)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (Number.isFinite(CAPTURE_SECONDS) && CAPTURE_SECONDS > 0) {
  log(`[probe] ${CAPTURE_SECONDS}s 后自动结束`)
  setTimeout(shutdown, CAPTURE_SECONDS * 1000)
}
