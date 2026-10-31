import type { DetailPlayer } from './types'

/** 游戏内毫秒时间戳 → mm:ss */
export function formatGameTime(timestamp: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestamp / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** 数字千分位；用于总金币等大数值 */
export function formatNumber(value: number): string {
  return value.toLocaleString()
}

export function buildPlayerMap(players: DetailPlayer[]): Map<number, DetailPlayer> {
  return new Map(players.map((player) => [player.participantId, player]))
}
