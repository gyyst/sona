/**
 * LTK 桥接状态类型与后台消息解析
 */

export type LtkConnectionState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'applying'
  | 'applied'
  | 'skipped-owned'
  | 'error'

export type LtkManagerInstallState =
  | 'unknown'
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'installed'
  | 'error'

export interface LtkBridgeStatus {
  state: LtkConnectionState
  connected: boolean
  message: string
  phase: string
  skinName: string | null
  patcherRunning: boolean
  managerStatus: LtkManagerInstallState
  managerProgress: number
  managerMessage: string
  capabilities: string[]
}

export interface LtkStatusMessage {
  type: 'status'
  phase: string
  injectionStatus: string
  message: string
  skinName: string | null
  patcherRunning: boolean
  ltkManagerStatus: LtkManagerInstallState
  ltkManagerProgress: number
  ltkManagerMessage: string
  capabilities: string[]
}

export const INITIAL_STATUS: LtkBridgeStatus = {
  state: 'disabled',
  connected: false,
  message: '',
  phase: '',
  skinName: null,
  patcherRunning: false,
  managerStatus: 'unknown',
  managerProgress: 0,
  managerMessage: '',
  capabilities: [],
}

export function parseStatusMessage(raw: unknown): LtkStatusMessage | null {
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
    ltkManagerStatus: parseManagerStatus(data.ltkManagerStatus),
    ltkManagerProgress: parseProgress(data.ltkManagerProgress),
    ltkManagerMessage: typeof data.ltkManagerMessage === 'string' ? data.ltkManagerMessage : '',
    capabilities: parseCapabilities(data.capabilities),
  }
}

export function mapInjectionState(value: string): LtkConnectionState {
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

export function sameStrings(a: string[], b: string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}

function parseManagerStatus(value: unknown): LtkManagerInstallState {
  switch (value) {
    case 'not-installed':
    case 'downloading':
    case 'verifying':
    case 'installing':
    case 'installed':
    case 'error':
      return value
    default:
      return 'unknown'
  }
}

function parseProgress(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function parseCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
