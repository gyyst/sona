/**
 * LTK Manager 本地桥接客户端
 *
 * 通过 `ws://127.0.0.1:{port}` 连接 ltk-bridge 后台：
 * - 首条消息发送 token 认证
 * - 认证成功后补发最近一次皮肤选择
 * - 断线自动重连（3s / 6s / 12s / 24s / 30s 上限）
 *
 * 仅负责传递选择与展示后台状态；实际的资源下载、LTK 导入与 patcher 由后台完成。
 */

import { store } from '@/lib/store'
import type { SkinSelectionEventDetail } from './state'

export type LtkConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'applying'
  | 'applied'
  | 'skipped-owned'
  | 'error'

export interface LtkBridgeStatus {
  state: LtkConnectionState
  message: string
  phase: string
  skinName: string | null
  patcherRunning: boolean
}

interface LtkStatusMessage {
  type: 'status'
  phase: string
  injectionStatus: string
  message: string
  skinName: string | null
  patcherRunning: boolean
}

const INITIAL_STATUS: LtkBridgeStatus = {
  state: 'disabled',
  message: '',
  phase: '',
  skinName: null,
  patcherRunning: false,
}

const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30000

class LtkBridgeClient {
  private enabled = false
  private port = 50010
  private token = ''
  private socket: WebSocket | null = null
  private authenticated = false
  private pending: SkinSelectionEventDetail | null = null
  private reconnectTimer: number | null = null
  private reconnectAttempt = 0
  private status: LtkBridgeStatus = INITIAL_STATUS
  private listeners = new Set<() => void>()

  getStatus = (): LtkBridgeStatus => this.status

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 从 store 重读配置（开关、端口、token） */
  syncFromStore() {
    const enabled = store.get('ltkBridgeEnabled')
    const port = store.get('ltkBridgePort')
    const token = store.get('ltkBridgeToken')

    if (!enabled) {
      this.enabled = false
      this.disconnect()
      this.setStatus({ state: 'disabled', message: '', phase: '', skinName: null, patcherRunning: false })
      return
    }

    const changed = !this.enabled || port !== this.port || token !== this.token
    this.enabled = true
    this.port = port
    this.token = token
    if (changed) {
      this.disconnect()
      this.connect()
    }
  }

  /** 发送皮肤选择；未连接时保留最近一次，认证后补发 */
  sendSelection(detail: SkinSelectionEventDetail) {
    if (!this.enabled) return
    this.pending = detail
    this.flushPending()
  }

  private connect() {
    if (!this.enabled || this.socket) return
    this.setStatus({ state: 'connecting', message: '正在连接 LTK Manager 桥接…', phase: '', skinName: null, patcherRunning: false })

    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.port}`)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.socket = socket
    socket.onopen = () => {
      this.authenticated = false
      socket.send(JSON.stringify({ type: 'auth', token: this.token }))
    }
    socket.onmessage = (event) => this.handleMessage(event.data)
    socket.onerror = () => {
      // 具体原因由 onclose 统一处理
    }
    socket.onclose = () => {
      this.socket = null
      this.authenticated = false
      if (this.enabled) {
        this.setStatus({ state: 'error', message: 'LTK Manager 桥接未连接', phase: '', skinName: null, patcherRunning: false })
        this.scheduleReconnect()
      }
    }
  }

  private disconnect() {
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    this.authenticated = false
    if (this.socket) {
      this.socket.onclose = null
      this.socket.close()
      this.socket = null
    }
  }

  private scheduleReconnect() {
    if (!this.enabled || this.reconnectTimer != null) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private flushPending() {
    if (!this.authenticated || !this.pending || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const detail = this.pending
    this.pending = null
    this.socket.send(JSON.stringify({
      type: 'skin-selection',
      championId: detail.championId,
      skinId: detail.skinId,
      baseSkinId: detail.baseSkinId,
      chromaId: detail.chromaId ?? null,
      formId: detail.formId ?? null,
      skinName: detail.skinName,
      owned: detail.owned,
      source: detail.source,
      timestampMs: detail.timestamp,
    }))
  }

  private handleMessage(raw: unknown) {
    const message = parseStatusMessage(raw)
    if (!message) return
    if (!this.authenticated) {
      this.authenticated = true
      this.reconnectAttempt = 0
      this.flushPending()
    }
    this.setStatus({
      state: mapInjectionState(message.injectionStatus),
      message: message.message,
      phase: message.phase,
      skinName: message.skinName,
      patcherRunning: message.patcherRunning,
    })
  }

  private setStatus(next: LtkBridgeStatus) {
    const changed = Object.keys(next).some((key) => {
      const typedKey = key as keyof LtkBridgeStatus
      return this.status[typedKey] !== next[typedKey]
    })
    if (!changed) return
    this.status = next
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // ignore
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStatusMessage(raw: unknown): LtkStatusMessage | null {
  let data: unknown = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!isRecord(data) || data.type !== 'status') return null
  return {
    type: 'status',
    phase: typeof data.phase === 'string' ? data.phase : '',
    injectionStatus: typeof data.injectionStatus === 'string' ? data.injectionStatus : 'idle',
    message: typeof data.message === 'string' ? data.message : '',
    skinName: typeof data.skinName === 'string' ? data.skinName : null,
    patcherRunning: data.patcherRunning === true,
  }
}

function mapInjectionState(value: string): LtkConnectionState {
  switch (value) {
    case 'applying':
      return 'applying'
    case 'applied':
      return 'applied'
    case 'skipped-owned':
      return 'skipped-owned'
    case 'error':
      return 'error'
    default:
      return 'connected'
  }
}

/** 后台桥接客户端单例 */
export const ltkBridgeClient = new LtkBridgeClient()

/** 从 store 同步连接配置（由 features.ts 在开关变化时调用） */
export function syncLtkBridge() {
  ltkBridgeClient.syncFromStore()
}
