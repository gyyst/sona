/**
 * 临时探测脚本：记录 KIWI（海克斯大乱斗）对局中客户端 LCU 的 WebSocket / HTTP 数据，
 * 用于确认客户端是否收到海克斯三选一的候选数据。
 *
 * 用法：
 *   1. 先启动英雄联盟客户端并登录到大堂（lockfile 才会有内容）
 *   2. node scripts/probe-kiwi-ws.mjs --all
 *   3. 进一局 KIWI；海克斯三选一出现时留意时间，选完后继续 30 秒
 *   4. Ctrl+C 结束，日志路径会打印出来
 *
 * 说明：
 *   - lockfile 位于 <LeagueClient>/lockfile，格式为 name:pid:port:password:protocol
 *   - 脚本只在本机读取 lockfile，不会上传任何内容
 *   - --all 会额外记录完整 WS 事件流（上限 50MB），用于排查未知字段名
 *   - 可用 LOL_PROBE_OUT 指定输出目录
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, Agent, fetch as undiciFetch } from 'undici'

const CLIENT_DIR = process.env.LOL_CLIENT_DIR || 'D:/WeGameApps/英雄联盟/LeagueClient'
const LOCKFILE = path.join(CLIENT_DIR, 'lockfile')
const OUT_DIR = process.env.LOL_PROBE_OUT || path.join(os.tmpdir(), 'sona-kiwi-probe')
const MATCH_LOG = path.join(OUT_DIR, 'kiwi-ws-probe.log')
const ALL_LOG = path.join(OUT_DIR, 'kiwi-ws-all.log')
const URI_LOG = path.join(OUT_DIR, 'kiwi-ws-uris.log')
const HTTP_LOG = path.join(OUT_DIR, 'kiwi-http-probe.log')
const OPENAPI_LOG = path.join(OUT_DIR, 'kiwi-openapi-paths.txt')
const LOG_ALL = process.argv.includes('--all')
const SECONDS_ARG = process.argv.find((arg) => arg.startsWith('--seconds='))
const CAPTURE_SECONDS = SECONDS_ARG ? Number(SECONDS_ARG.split('=')[1]) : 0
const MAX_ALL_BYTES = 50 * 1024 * 1024

fs.mkdirSync(OUT_DIR, { recursive: true })

function readLockfileCredentials() {
  try {
    const raw = fs.readFileSync(LOCKFILE, 'utf8').trim()
    const [name, pid, port, password, protocol] = raw.split(':')
    if (!port || !password) return null
    return { source: 'lockfile', name, pid, port, password, protocol: protocol || 'https' }
  } catch {
    return null
  }
}

/**
 * 腾讯/WeGame 客户端可能不写 lockfile，但启动日志会记录完整命令行：
 *   --app-port=56623 --remoting-auth-token=xxxxx
 * 这里从最新的 LeagueClientUx.log 中解析，token 只用于本地连接，不打印。
 */
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
      return { name, filePath, mtime: fs.statSync(filePath).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)

  for (const log of logs) {
    const text = fs.readFileSync(log.filePath, 'utf8')
    const portMatch = text.match(/--app-port=(\d+)/)
    const tokenMatch = text.match(/--remoting-auth-token=([^\s"]+)/)
    if (portMatch && tokenMatch) {
      return {
        source: `log:${log.name}`,
        name: 'LeagueClient',
        pid: '',
        port: portMatch[1],
        password: tokenMatch[1],
        protocol: 'https',
      }
    }
  }

  return null
}

const credentials = readLockfileCredentials() || readLogCredentials()
if (!credentials) {
  throw new Error(
    `无法获取 LCU 端口和 token。\nlockfile：${LOCKFILE}\n客户端目录：${CLIENT_DIR}\n请先启动英雄联盟客户端并登录，或用 LOL_CLIENT_DIR 指定正确目录。`,
  )
}

const { name, pid, port, password, protocol, source } = credentials
const isHttp = protocol === 'http'
const wsUrl = `${isHttp ? 'ws' : 'wss'}://127.0.0.1:${port}/`
const httpBase = `${isHttp ? 'http' : 'https'}://127.0.0.1:${port}`
const auth = `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`
const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })

console.log('[probe] credentials:', { source, name, pid, port, protocol })
console.log('[probe] output:', OUT_DIR)
console.log('[probe] mode:', LOG_ALL ? 'WS all + matches' : 'WS matches only')

// 可选：列出 LCU OpenAPI 中与 augment/kiwi 相关的端点
undiciFetch(`${httpBase}/swagger/v3/openapi.json`, {
  headers: { Authorization: auth },
  dispatcher,
}).then(async (response) => {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const spec = await response.json()
  const paths = Object.keys(spec?.paths || {})
  const hits = paths.filter((item) => /augment|kiwi|cherry/i.test(item))
  fs.writeFileSync(OPENAPI_LOG, paths.join('\n'))
  console.log('[probe] OpenAPI augment/kiwi paths:', hits.length ? hits : '(none)')
}).catch((error) => {
  console.warn('[probe] OpenAPI 不可用:', error.message)
})

const ws = new WebSocket(wsUrl, { headers: { Authorization: auth }, dispatcher })
const uriCounts = new Map()
let totalEvents = 0
let allBytes = 0

ws.addEventListener('open', () => {
  console.log('[probe] connected:', wsUrl)
  ws.send(JSON.stringify([5, 'OnJsonApiEvent']))
})

ws.addEventListener('error', (event) => {
  console.error('[probe] ws error:', event.message || event)
})

ws.addEventListener('close', (event) => {
  console.log('[probe] ws closed:', event.code, event.reason)
})

ws.addEventListener('message', (event) => {
  const text = typeof event.data === 'string' ? event.data : ''
  if (!text) return
  let message
  try { message = JSON.parse(text) } catch { return }
  if (!Array.isArray(message) || message[0] !== 8) return

  totalEvents += 1
  const uri = String(message[2]?.uri || '(none)')
  uriCounts.set(uri, (uriCounts.get(uri) || 0) + 1)

  const payloadText = JSON.stringify(message[2]?.data ?? '')
  const timestamp = new Date().toISOString()
  const line = `${timestamp}\t${uri}\t${payloadText}\n`

  if (LOG_ALL && allBytes < MAX_ALL_BYTES) {
    fs.appendFileSync(ALL_LOG, line)
    allBytes += Buffer.byteLength(line)
  }

  if (/augment|kiwi|cherry|selection|offer/i.test(uri) || /augment|kiwi|cherry/i.test(payloadText)) {
    fs.appendFileSync(MATCH_LOG, line)
    console.log('[match]', line.slice(0, 1200))
  }
})

// 轮询常见 HTTP 会话接口，补充 WS 可能缺失的数据
const POLL_ENDPOINTS = ['/lol-gameflow/v1/session', '/lol-champ-select/v1/session']
setInterval(async () => {
  for (const endpoint of POLL_ENDPOINTS) {
    try {
      const response = await undiciFetch(`${httpBase}${endpoint}`, {
        headers: { Authorization: auth },
        dispatcher,
      })
      const text = await response.text()
      if (/augment|cherry|augmentId|augments/i.test(text)) {
        const line = `${new Date().toISOString()}\t${endpoint}\t${text}\n`
        fs.appendFileSync(HTTP_LOG, line)
        console.log('[http-match]', endpoint, text.slice(0, 300))
      }
    } catch {
      // 接口暂不可用时忽略
    }
  }
}, 2000)

setInterval(() => {
  const top = [...uriCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uri, count]) => `${count} ${uri}`)
    .join(' | ')
  console.log(`[probe] events=${totalEvents}, uris=${uriCounts.size}${top ? ` | ${top}` : ''}`)
}, 15000)

function shutdown() {
  const summary = [...uriCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uri, count]) => `${count}\t${uri}`)
    .join('\n')
  fs.writeFileSync(URI_LOG, summary)
  console.log(`[probe] wrote:\n  ${MATCH_LOG}\n  ${URI_LOG}${LOG_ALL ? `\n  ${ALL_LOG}` : ''}\n  ${HTTP_LOG}`)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (Number.isFinite(CAPTURE_SECONDS) && CAPTURE_SECONDS > 0) {
  setTimeout(shutdown, CAPTURE_SECONDS * 1000)
  console.log(`[probe] will stop after ${CAPTURE_SECONDS}s`)
}
