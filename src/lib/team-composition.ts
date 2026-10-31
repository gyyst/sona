/**
 * 阵容结构分析与参考胜率（纯函数）
 *
 * 只消费 `assets.getChampionDetail()` 归一化后的英雄详情，
 * 不发起请求、不读写 store，便于 UI 与预测复用。
 */

import type { ChampionDetail } from '@/lib/assets'

export interface TeamComposition {
  /** 物理伤害英雄数（混合伤害按 0.5 计入） */
  ad: number
  /** 魔法伤害英雄数（混合伤害按 0.5 计入） */
  ap: number
  /** 混合伤害英雄数 */
  mixed: number
  melee: number
  ranged: number
  /** 前排：durability >= 2，或定位包含 tank / fighter */
  frontline: number
  /** 控制：crowdControl >= 2 */
  crowdControl: number
  /** 开团：标签包含 Initiator / Dive */
  engage: number
  /** 保护：标签包含 Ally Protection，或 utility >= 2 */
  protection: number
  /** 伤害结构评分 0-100 */
  damageScore: number
  /** 前排评分 0-100 */
  frontlineScore: number
  /** 团队功能评分 0-100 */
  utilityScore: number
  /** 综合阵容评分 0-100，用于参考胜率 */
  overallScore: number
  /** 成功读取到详情的英雄数 */
  resolved: number
  /** 参与统计的英雄总数 */
  total: number
  /** 所有英雄详情都可用 */
  complete: boolean
}

export type PredictionBasis = 'winRate' | 'composition' | 'matchups'

export interface TeamPredictionInput {
  /** 队伍平均胜率 0-100，无数据为 null */
  averageWinRate: number | null
  /** 阵容综合评分 0-100，数据不完整时为 null */
  compositionScore: number | null
  /** 对位平均胜率 0-100，无对位数据时为 null */
  matchupWinRate: number | null
}

export interface WinRatePrediction {
  /** 蓝方参考胜率（整数，1-99） */
  blue: number
  /** 红方参考胜率（整数，1-99），与蓝方相加为 100 */
  red: number
  /** 实际参与计算的依据 */
  basis: PredictionBasis[]
}

/** 固定权重；只使用双方都有数据的维度，并按可用权重重新归一化 */
const PREDICTION_WEIGHTS: Record<PredictionBasis, number> = {
  winRate: 0.4,
  composition: 0.35,
  matchups: 0.25,
}

/** 评分曲线斜率：双方评分差 10 分时约为 62% / 38% */
const PREDICTION_CURVE = 50

function roundScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)))
}

function clampRate(value: number): number {
  return Math.min(99, Math.max(1, Math.round(value)))
}

/**
 * 分析一支队伍的阵容结构。
 *
 * 详情缺失的英雄按 0 计，并通过 `complete` / `resolved` 提示数据不完整。
 */
export function analyzeTeamComposition(details: Array<ChampionDetail | null>): TeamComposition {
  const total = details.length
  const available = details.filter((detail): detail is ChampionDetail => detail != null)

  let ad = 0
  let ap = 0
  let mixed = 0
  let melee = 0
  let ranged = 0
  let frontline = 0
  let crowdControl = 0
  let engage = 0
  let protection = 0

  for (const detail of available) {
    switch (detail.tacticalInfo.damageType) {
      case 'kPhysical':
        ad += 1
        break
      case 'kMagic':
        ap += 1
        break
      case 'kMixed':
        ad += 0.5
        ap += 0.5
        mixed += 1
        break
      default:
        break
    }

    if (detail.tacticalInfo.attackType === 'melee') melee += 1
    else if (detail.tacticalInfo.attackType === 'ranged') ranged += 1

    const roles = detail.roles
    if (detail.playstyleInfo.durability >= 2 || roles.includes('tank') || roles.includes('fighter')) {
      frontline += 1
    }
    if (detail.playstyleInfo.crowdControl >= 2) crowdControl += 1

    const tags = [detail.championTagInfo.championTagPrimary, detail.championTagInfo.championTagSecondary]
    if (tags.includes('Initiator') || tags.includes('Dive')) engage += 1
    if (tags.includes('Ally Protection') || detail.playstyleInfo.utility >= 2) protection += 1
  }

  const resolved = available.length
  const hasData = resolved > 0
  const damageTotal = ad + ap
  const hasDamageData = damageTotal > 0
  const physicalShare = hasDamageData ? ad / damageTotal : 0
  // 物理/魔法越接近 50/50，对手越难针对出装；没有伤害数据时不计分
  const damageBalance = hasDamageData ? 1 - Math.abs(physicalShare * 2 - 1) : 0

  const damageScore = hasData && hasDamageData ? roundScore(50 + damageBalance * 50) : 0
  const frontlineScore = hasData ? roundScore(50 + Math.min(1, frontline / 3) * 50) : 0
  const utilityScore = hasData
    ? roundScore(50 + Math.min(1, (crowdControl + engage + protection) / 5) * 50)
    : 0
  const overallScore = hasData
    ? roundScore(damageScore * 0.4 + frontlineScore * 0.35 + utilityScore * 0.25)
    : 0

  return {
    ad,
    ap,
    mixed,
    melee,
    ranged,
    frontline,
    crowdControl,
    engage,
    protection,
    damageScore,
    frontlineScore,
    utilityScore,
    overallScore,
    resolved,
    total,
    complete: total > 0 && resolved === total,
  }
}

/** 只使用双方都有数据的维度，避免单边缺失导致评分口径不一致 */
function collectBasis(blue: TeamPredictionInput, red: TeamPredictionInput): PredictionBasis[] {
  const basis: PredictionBasis[] = []
  if (blue.averageWinRate != null && red.averageWinRate != null) basis.push('winRate')
  if (blue.compositionScore != null && red.compositionScore != null) basis.push('composition')
  if (blue.matchupWinRate != null && red.matchupWinRate != null) basis.push('matchups')
  return basis
}

function getWeightedScore(input: TeamPredictionInput, basis: PredictionBasis[]): number {
  let weighted = 0
  let totalWeight = 0
  for (const item of basis) {
    const value = item === 'winRate'
      ? input.averageWinRate
      : item === 'composition'
        ? input.compositionScore
        : input.matchupWinRate
    if (value == null) continue
    weighted += value * PREDICTION_WEIGHTS[item]
    totalWeight += PREDICTION_WEIGHTS[item]
  }
  return totalWeight > 0 ? weighted / totalWeight : 0
}

/**
 * 计算双方参考胜率。
 *
 * 数据不足（双方没有任何共同可用维度）时返回 null，由 UI 隐藏预测区块；
 * 结果只是可观测量级的粗略参考，不承诺准确率。
 */
export function predictWinRate(
  blue: TeamPredictionInput,
  red: TeamPredictionInput,
): WinRatePrediction | null {
  const basis = collectBasis(blue, red)
  if (basis.length === 0) return null

  const blueScore = getWeightedScore(blue, basis)
  const redScore = getWeightedScore(red, basis)
  const blueRate = 100 / (1 + Math.pow(10, (redScore - blueScore) / PREDICTION_CURVE))
  const blueRounded = clampRate(blueRate)

  return {
    blue: blueRounded,
    red: 100 - blueRounded,
    basis,
  }
}
