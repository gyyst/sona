/**
 * OP.GG 分路与对位映射（纯函数）
 *
 * 单独成模块，避免 UI 与数据模块为了两个纯映射函数依赖整个配装推荐功能
 * （后者会引入 `@/index`、React 面板等无关依赖）。
 */

import type { OpggCounter, OpggPosition } from '@/lib/opgg-api'

export interface OpggMatchup {
  championId: number
  play: number
  win: number
  winRate: number
}

/** 把客户端分路字符串归一化为 OP.GG 位置 */
export function mapAssignedPosition(position: string | undefined): OpggPosition {
  switch (position?.trim().toLowerCase()) {
    case 'top':
      return 'top'
    case 'jungle':
      return 'jungle'
    case 'middle':
    case 'mid':
      return 'mid'
    case 'bottom':
    case 'bot':
    case 'adc':
      return 'adc'
    case 'utility':
    case 'support':
      return 'support'
    default:
      return 'none'
  }
}

/** 把 OP.GG counters 归一化为带胜率的对位列表 */
export function mapOpggMatchups(counters: OpggCounter[]): OpggMatchup[] {
  return counters
    .map((counter) => ({
      championId: counter.champion_id,
      play: counter.play,
      win: counter.win,
      winRate: counter.play > 0 ? counter.win / counter.play : 0,
    }))
    .filter((counter) => counter.championId > 0 && counter.play > 0)
}
