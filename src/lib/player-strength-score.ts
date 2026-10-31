import type { SgpGameSummaryLol, SgpParticipantLol } from '@/types/sgp'
import { translate, type TranslationKey } from '@/i18n'

export type SonaStrengthRole =
  | 'TOP'
  | 'JUNGLE'
  | 'MIDDLE'
  | 'BOTTOM'
  | 'UTILITY'
  | 'ARAM'
  | 'SPECIAL'
  | 'UNKNOWN'

export type SonaStrengthGrade =
  | 'legendary'
  | 'carry'
  | 'strong'
  | 'reliable'
  | 'balanced'
  | 'unstable'
  | 'risky'
  | 'critical'

export type BreakdownKey =
  | 'combat'
  | 'win'
  | 'damage'
  | 'economy'
  | 'objectives'
  | 'vision'
  | 'durability'
  | 'farming'
  | 'lanePressure'
  | 'clutch'
  | 'teamUtility'

export interface SonaScoreBreakdown {
  combat: number
  win: number
  damage: number
  economy: number
  objectives: number
  vision: number
  durability: number
  farming: number
  /** 对位压制；无对线模式或找不到同位置对手时缺省 */
  lanePressure?: number
  /** 关键击杀/终结能力；字段缺失时缺省 */
  clutch?: number
  /** 团队功能：控制、治疗、护盾；字段缺失时缺省 */
  teamUtility?: number
}

/** 牛马称号的绝对档位 i18n key。 */
export type SonaTeamPowerTitleKey =
  | 'strength.teamTier.ace'
  | 'strength.teamTier.high'
  | 'strength.teamTier.mid'
  | 'strength.teamTier.low'
  | 'strength.teamTier.burden'
  | 'strength.teamTier.insufficient'

export interface SonaGameStrengthScore {
  gameId: number
  championId: number
  role: SonaStrengthRole
  win: boolean
  placement: number
  /** WeGame 风格展示分，范围 3.0 - 16.0。 */
  score: number
  breakdown: SonaScoreBreakdown
  metrics: {
    kills: number
    deaths: number
    assists: number
    kda: number
    killParticipation: number
    damageShare: number
    goldShare: number
    csPerMinute: number
    visionPerMinute: number
  }
}

export interface SonaPlayerStrengthScore {
  puuid: string
  /** WeGame 风格综合展示分，范围 3.0 - 16.0。 */
  score: number
  /** 未经过样本置信度、稳定性和趋势修正的原始展示分。 */
  rawScore: number
  confidence: number
  validGames: number
  /** 0-1 的加权胜率；展示层需要自行乘以 100。 */
  winRate: number
  averageKda: number
  averageKillParticipation: number
  averageDamageShare: number
  consistencyScore: number
  trendScore: number
  grade: SonaStrengthGrade
  gradeLabel: string
  verdict: string
  breakdown: SonaScoreBreakdown
  /** breakdown 中最高两项（只比较实际存在的维度）。 */
  strengths?: BreakdownKey[]
  /** breakdown 中最低两项；整体均衡时为空数组。 */
  weaknesses?: BreakdownKey[]
  /** 绝对档位称号；样本不足时为 strength.teamTier.insufficient。 */
  titleKey?: SonaTeamPowerTitleKey
  /** 可直接展示的样本量与置信度说明。 */
  sampleLabel?: string
  games: SonaGameStrengthScore[]
}

export interface SonaTeamStrengthScore {
  score: number
  averageScore: number
  balancePenalty: number
  confidence: number
  grade: SonaStrengthGrade
  gradeLabel: string
  players: SonaPlayerStrengthScore[]
}

export interface SonaStrengthScoreOptions {
  /** 最近战绩权重半衰期。SGP 通常按新到旧返回，越靠前权重越高。 */
  recencyHalfLife: number
  /** 低于该样本数时仍计算，但会明显向中性分收缩。 */
  minConfidenceGames: number
  /** 达到该样本数后视为满置信度。 */
  fullConfidenceGames: number
  /** 样本足够时削弱极端局，避免一两场超神/爆炸扭曲评分。 */
  trimOutliers: boolean
  /** 早期投降局数据不完整，默认跳过。 */
  skipEarlySurrender: boolean
  /** 有挂机队友的对局会明显污染表现数据，默认跳过。 */
  skipAfkTeammate: boolean
}

type ScoreWeights = Partial<Record<BreakdownKey, number>>

const INTERNAL_MIN_SCORE = 0
const INTERNAL_MAX_SCORE = 100
const INTERNAL_NEUTRAL_SCORE = 50
const DISPLAY_MIN_SCORE = 3.0
const DISPLAY_MAX_SCORE = 16.0
/** 放大中段表现差距，让差/好玩家更容易落在个位数/两位数两侧。 */
const DISPLAY_CONTRAST = 1.22
const DISPLAY_NEUTRAL_SCORE = toDisplayScore(INTERNAL_NEUTRAL_SCORE)

const DEFAULT_OPTIONS: SonaStrengthScoreOptions = {
  recencyHalfLife: 18,
  minConfidenceGames: 3,
  fullConfidenceGames: 16,
  trimOutliers: true,
  skipEarlySurrender: true,
  skipAfkTeammate: true,
}

const BASE_WEIGHTS: ScoreWeights = {
  combat: 0.2,
  win: 0.11,
  damage: 0.15,
  economy: 0.08,
  objectives: 0.08,
  vision: 0.06,
  durability: 0.07,
  farming: 0.05,
  lanePressure: 0.08,
  clutch: 0.07,
  teamUtility: 0.05,
}

const BREAKDOWN_KEYS: BreakdownKey[] = [
  'combat',
  'win',
  'damage',
  'economy',
  'objectives',
  'vision',
  'durability',
  'farming',
  'lanePressure',
  'clutch',
  'teamUtility',
]

/** 强项与短板分差低于该值时视为均衡，不强行给短板。 */
const HIGHLIGHT_BALANCE_THRESHOLD = 8

/**
 * 位置乘数只放大/缩小维度分，不改变权重总和。
 * 大乱斗/斗魂的对位压制本身缺省，权重会自动重新归一化。
 */
const ROLE_DIMENSION_MULTIPLIERS: Record<SonaStrengthRole, Partial<Record<BreakdownKey, number>>> = {
  TOP: { durability: 1.15, economy: 1.1, teamUtility: 1.05 },
  JUNGLE: { objectives: 1.2, combat: 1.1, lanePressure: 1.15 },
  MIDDLE: { damage: 1.15, combat: 1.05, lanePressure: 1.1 },
  BOTTOM: { damage: 1.15, farming: 1.1, durability: 1.05 },
  UTILITY: { vision: 1.25, teamUtility: 1.3, damage: 0.75, farming: 0.6 },
  ARAM: { farming: 0.5, vision: 0.6, teamUtility: 1.2, damage: 1.1 },
  SPECIAL: { farming: 0.6, vision: 0.7, teamUtility: 1.1 },
  UNKNOWN: {},
}

function getGradeLabel(grade: SonaStrengthGrade): string {
  return translate(`strength.grade.${grade}` as Parameters<typeof translate>[0])
}

export function calculateSonaPlayerStrengthScore(
  games: SgpGameSummaryLol[],
  puuid: string,
  options: Partial<SonaStrengthScoreOptions> = {},
): SonaPlayerStrengthScore | null {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options }
  const gameScores = games
    .map((game) => calculateSonaGameStrengthScore(game, puuid, resolvedOptions))
    .filter((score): score is SonaGameStrengthScore => score !== null)

  if (gameScores.length === 0) {
    return null
  }

  const scoreSamples = resolvedOptions.trimOutliers
    ? winsorizeScores(gameScores.map((game) => game.score))
    : gameScores.map((game) => game.score)

  const recencyWeights = gameScores.map((_, index) => getRecencyWeight(index, resolvedOptions.recencyHalfLife))
  const rawScore = weightedAverage(scoreSamples, recencyWeights)
  const consistencyScore = calculateConsistencyScore(scoreSamples)
  const trendScore = calculateTrendScore(scoreSamples)
  const confidence = calculateSampleConfidence(gameScores.length, resolvedOptions)

  const consistencyAdjustment = clamp((consistencyScore - 50) * 0.012, -0.6, 0.6)
  const trendAdjustment = clamp((trendScore - 50) * 0.01, -0.5, 0.5)
  // 置信度仍用于抑制小样本噪声，但最低保留 72% 的真实差距，避免所有人都挤在中性分附近。
  const confidenceScale = 0.57 + confidence * 0.43
  const score = clamp(
    DISPLAY_NEUTRAL_SCORE + (rawScore - DISPLAY_NEUTRAL_SCORE) * confidenceScale + consistencyAdjustment + trendAdjustment,
    DISPLAY_MIN_SCORE,
    DISPLAY_MAX_SCORE,
  )
  const grade = getSonaStrengthGrade(score)
  const breakdown = averageBreakdown(gameScores, recencyWeights)
  const highlights = getScoreHighlights(breakdown)

  warnIfInvalidBreakdown(breakdown, '玩家聚合')

  return {
    puuid,
    score,
    rawScore,
    confidence,
    validGames: gameScores.length,
    winRate: weightedAverage(gameScores.map((game) => game.win ? 1 : 0), recencyWeights),
    averageKda: weightedAverage(gameScores.map((game) => game.metrics.kda), recencyWeights),
    averageKillParticipation: weightedAverage(
      gameScores.map((game) => game.metrics.killParticipation),
      recencyWeights,
    ),
    averageDamageShare: weightedAverage(gameScores.map((game) => game.metrics.damageShare), recencyWeights),
    consistencyScore,
    trendScore,
    grade,
    gradeLabel: getGradeLabel(grade),
    verdict: getSonaStrengthVerdict(score, confidence),
    breakdown,
    strengths: highlights.strengths,
    weaknesses: highlights.weaknesses,
    titleKey: getTeamPowerTitleKey(score, confidence, gameScores.length),
    sampleLabel: translate('strength.sample', {
      games: gameScores.length,
      confidence: Math.round(confidence * 100),
    }),
    games: gameScores,
  }
}

export function calculateSonaGameStrengthScore(
  game: SgpGameSummaryLol,
  puuid: string,
  options: Partial<SonaStrengthScoreOptions> = {},
): SonaGameStrengthScore | null {
  const resolvedOptions = { ...DEFAULT_OPTIONS, ...options }
  const participant = game.json.participants.find((item) => item.puuid === puuid)

  if (!participant) {
    return null
  }

  if (shouldSkipSonaGameForParticipant(game, participant, resolvedOptions)) {
    return null
  }

  const teamParticipants = game.json.participants.filter((item) => item.teamId === participant.teamId)
  if (teamParticipants.length === 0) {
    return null
  }

  const role = inferStrengthRole(game, participant)
  const weights = normalizeWeights(BASE_WEIGHTS)
  const minutes = Math.max((participant.timePlayed || game.json.gameDuration || 1) / 60, 1)
  const teamKills = sum(teamParticipants, (item) => item.kills)
  const teamDamage = sum(teamParticipants, (item) => item.totalDamageDealtToChampions)
  const teamGold = sum(teamParticipants, (item) => item.goldEarned)
  const teamObjectiveDamage = sum(teamParticipants, (item) => item.damageDealtToObjectives)
  const teamDamageTaken = sum(teamParticipants, (item) => item.totalDamageTaken)

  const kills = safeNumber(participant.kills)
  const deaths = safeNumber(participant.deaths)
  const assists = safeNumber(participant.assists)
  const takedowns = kills + assists
  const kda = getChallengeNumber(participant, 'kda') || (kills + assists) / Math.max(deaths, 1)
  const killParticipation = clamp(
    getChallengeNumber(participant, 'killParticipation') || safeDivide(takedowns, teamKills),
    0,
    1,
  )
  const damageShare = clamp(
    getChallengeNumber(participant, 'teamDamagePercentage') ||
      safeDivide(participant.totalDamageDealtToChampions, teamDamage),
    0,
    1,
  )
  const goldShare = clamp(safeDivide(participant.goldEarned, teamGold), 0, 1)
  const damageTakenShare = clamp(
    getChallengeNumber(participant, 'damageTakenOnTeamPercentage') ||
      safeDivide(participant.totalDamageTaken, teamDamageTaken),
    0,
    1,
  )
  const csPerMinute = safeDivide(participant.totalMinionsKilled + participant.neutralMinionsKilled, minutes)
  const visionPerMinute = getChallengeNumber(participant, 'visionScorePerMinute') ||
    safeDivide(participant.visionScore, minutes)
  const laneOpponent = findLaneOpponent(game, participant)

  const breakdown = applyRoleMultipliers({
    combat: calculateCombatScore({ kda, killParticipation, deaths, minutes }),
    win: calculateWinScore(game, participant),
    damage: calculateDamageScore(role, participant, minutes, damageShare),
    economy: calculateEconomyScore(role, participant, minutes, damageShare, goldShare),
    objectives: calculateObjectiveScore(role, participant, minutes, teamObjectiveDamage),
    vision: calculateVisionScore(role, participant, minutes, visionPerMinute),
    durability: calculateDurabilityScore(role, participant, minutes, damageTakenShare),
    farming: calculateFarmingScore(role, csPerMinute),
    lanePressure: calculateLanePressureScore(role, participant, laneOpponent, minutes) ?? undefined,
    clutch: calculateClutchScore(participant, minutes) ?? undefined,
    teamUtility: calculateTeamUtilityScore(role, participant, minutes) ?? undefined,
  }, role)

  warnIfInvalidBreakdown(breakdown, `对局 ${game.json.gameId}`)

  return {
    gameId: game.json.gameId,
    championId: participant.championId,
    role,
    win: participant.win,
    placement: participant.placement || participant.subteamPlacement || 0,
    score: toDisplayScore(calculateWeightedBreakdownScore(breakdown, weights)),
    breakdown,
    metrics: {
      kills,
      deaths,
      assists,
      kda,
      killParticipation,
      damageShare,
      goldShare,
      csPerMinute,
      visionPerMinute,
    },
  }
}

export function shouldSkipSonaStrengthGame(
  game: SgpGameSummaryLol,
  puuid: string,
  options: Partial<SonaStrengthScoreOptions> = {},
): boolean {
  const participant = game.json.participants.find((item) => item.puuid === puuid)
  if (!participant) return true

  return shouldSkipSonaGameForParticipant(game, participant, { ...DEFAULT_OPTIONS, ...options })
}

/**
 * 对 SGP 返回结果做当前队列的本地二次校验。
 *
 * 正常情况下服务端会依据 `q_<queueId>` tag 过滤；这里额外兜住部分大区忽略 tag、
 * 以及 SGP 降级到原生 LCU 历史接口时返回混合模式数据的情况。
 */
export function filterSonaStrengthGamesByQueue(
  games: SgpGameSummaryLol[],
  queueId: number,
): SgpGameSummaryLol[] {
  if (!Number.isFinite(queueId) || queueId <= 0) return games

  const queueTag = `q_${queueId}`
  return games.filter((game) => {
    return game.json.queueId === queueId || game.metadata.tags?.includes(queueTag)
  })
}

export function calculateSonaTeamStrengthScore(
  players: Array<SonaPlayerStrengthScore | null | undefined>,
): SonaTeamStrengthScore | null {
  const validPlayers = players.filter((player): player is SonaPlayerStrengthScore => Boolean(player))
  if (validPlayers.length === 0) {
    return null
  }

  const averageScore = average(validPlayers.map((player) => player.score))
  const confidence = average(validPlayers.map((player) => player.confidence))
  const cv = coefficientOfVariation(validPlayers.map((player) => player.score))
  const balancePenalty = clamp(cv * 6, 0, 1.8)
  const score = clamp(averageScore - balancePenalty, DISPLAY_MIN_SCORE, DISPLAY_MAX_SCORE)
  const grade = getSonaStrengthGrade(score)

  return {
    score,
    averageScore,
    balancePenalty,
    confidence,
    grade,
    gradeLabel: getGradeLabel(grade),
    players: validPlayers,
  }
}

export function getSonaStrengthGrade(score: number): SonaStrengthGrade {
  if (score >= 15.0) return 'legendary'
  if (score >= 13.5) return 'carry'
  if (score >= 12.0) return 'strong'
  if (score >= 10.8) return 'reliable'
  if (score >= 9.5) return 'balanced'
  if (score >= 8.0) return 'unstable'
  if (score >= 6.3) return 'risky'
  return 'critical'
}

export function getSonaStrengthVerdict(score: number, confidence = 1): string {
  const prefix = confidence < 0.55 ? translate('strength.lowConfidence') : ''
  const grade = getGradeLabel(getSonaStrengthGrade(score))
  return `${prefix}${grade}`
}

export function formatSonaStrengthScoreLine(score: SonaPlayerStrengthScore): string {
  return translate('strength.line', {
    grade: score.gradeLabel,
    score: score.score.toFixed(1),
    winRate: formatPercent(score.winRate),
    kda: score.averageKda.toFixed(2),
  })
}

/**
 * 称号改为绝对分数档位，不再按队内排名强制分配。
 * 样本不足或置信度过低时统一返回「数据不足」。
 *
 * 档位与 grade 语义对齐：
 *   15.0+ legendary -> ace
 *   13.5+ carry     -> high
 *   10.8+ reliable  -> mid
 *   8.0+  balanced/unstable -> low
 *   <8.0  risky/critical    -> burden
 */
export function getTeamPowerTitleKey(
  score: number,
  confidence: number,
  validGames: number,
): SonaTeamPowerTitleKey {
  if (validGames < 5 || confidence < 0.5) return 'strength.teamTier.insufficient'
  if (score >= 15.0) return 'strength.teamTier.ace'
  if (score >= 13.5) return 'strength.teamTier.high'
  if (score >= 10.8) return 'strength.teamTier.mid'
  if (score >= 8.0) return 'strength.teamTier.low'
  return 'strength.teamTier.burden'
}

/**
 * 取 breakdown 中实际存在的维度：最高两项为强项，最低两项为短板。
 * 最高与最低分差小于 8 分时视为均衡，短板为空。
 */
export function getScoreHighlights(breakdown: SonaScoreBreakdown): {
  strengths: BreakdownKey[]
  weaknesses: BreakdownKey[]
} {
  const entries = BREAKDOWN_KEYS
    .map((key) => [key, breakdown[key]] as const)
    .filter((entry): entry is readonly [BreakdownKey, number] => isFiniteScore(entry[1]))
    .sort((a, b) => b[1] - a[1])

  if (entries.length < 4) {
    return { strengths: entries.slice(0, 2).map((entry) => entry[0]), weaknesses: [] }
  }

  const spread = entries[0][1] - entries[entries.length - 1][1]
  return {
    strengths: entries.slice(0, 2).map((entry) => entry[0]),
    weaknesses: spread < HIGHLIGHT_BALANCE_THRESHOLD
      ? []
      : entries.slice(-2).map((entry) => entry[0]),
  }
}

export function getSonaStrengthDimensionLabel(key: BreakdownKey): string {
  return translate(`strength.dimension.${key}` as TranslationKey)
}

function inferStrengthRole(game: SgpGameSummaryLol, participant: SgpParticipantLol): SonaStrengthRole {
  const mode = game.json.gameMode
  // KIWI（海克斯大乱斗）没有稳定对线关系，按 ARAM 处理，避免误算对位压制。
  if (mode === 'ARAM' || mode === 'KIWI') return 'ARAM'
  if (mode === 'CHERRY' || mode === 'STRAWBERRY') return 'SPECIAL'

  const position = (participant.teamPosition || participant.individualPosition || participant.lane || '').toUpperCase()
  if (position === 'TOP') return 'TOP'
  if (position === 'JUNGLE') return 'JUNGLE'
  if (position === 'MIDDLE' || position === 'MID') return 'MIDDLE'
  if (position === 'BOTTOM' || position === 'BOT') return 'BOTTOM'
  if (position === 'UTILITY' || position === 'SUPPORT') return 'UTILITY'
  return 'UNKNOWN'
}

function calculateCombatScore(input: {
  kda: number
  killParticipation: number
  deaths: number
  minutes: number
}): number {
  const kdaScore = scoreRange(Math.log1p(input.kda), Math.log1p(1.1), Math.log1p(6.2))
  const participationScore = scoreRange(input.killParticipation, 0.32, 0.72)
  const deathSafetyScore = 1 - scoreRange(safeDivide(input.deaths, input.minutes), 0.18, 0.72)
  return toPercent(kdaScore * 0.38 + participationScore * 0.42 + deathSafetyScore * 0.2)
}

function calculateWinScore(game: SgpGameSummaryLol, participant: SgpParticipantLol): number {
  const mode = game.json.gameMode
  const placement = participant.placement || participant.subteamPlacement || 0

  if ((mode === 'CHERRY' || mode === 'STRAWBERRY') && placement > 0) {
    if (placement <= 1) return 100
    if (placement <= 2) return 86
    if (placement <= 4) return 64
    return 18
  }

  return participant.win ? 100 : 18
}

function calculateDamageScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
  damageShare: number,
): number {
  const excellentShare = role === 'UTILITY' ? 0.2 : role === 'ARAM' ? 0.26 : 0.29
  const shareScore = scoreRange(damageShare, role === 'UTILITY' ? 0.06 : 0.1, excellentShare)
  const damagePerMinute = getChallengeNumber(participant, 'damagePerMinute') ||
    safeDivide(participant.totalDamageDealtToChampions, minutes)
  const dpmTarget = getRoleTarget(role, {
    TOP: 650,
    JUNGLE: 560,
    MIDDLE: 730,
    BOTTOM: 760,
    UTILITY: 360,
    ARAM: 950,
    SPECIAL: 720,
    UNKNOWN: 620,
  })
  const dpmScore = scoreRange(damagePerMinute, dpmTarget * 0.42, dpmTarget)

  return toPercent(shareScore * 0.68 + dpmScore * 0.32)
}

function calculateEconomyScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
  damageShare: number,
  goldShare: number,
): number {
  const goldPerMinute = getChallengeNumber(participant, 'goldPerMinute') ||
    safeDivide(participant.goldEarned, minutes)
  const gpmTarget = getRoleTarget(role, {
    TOP: 420,
    JUNGLE: 390,
    MIDDLE: 430,
    BOTTOM: 455,
    UTILITY: 285,
    ARAM: 470,
    SPECIAL: 430,
    UNKNOWN: 395,
  })
  const gpmScore = scoreRange(goldPerMinute, gpmTarget * 0.58, gpmTarget)
  const efficiency = goldShare > 0 ? damageShare / goldShare : 0
  const efficiencyScore = scoreRange(efficiency, 0.55, role === 'UTILITY' ? 1.05 : 1.28)

  return toPercent(efficiencyScore * 0.56 + gpmScore * 0.44)
}

function calculateObjectiveScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
  teamObjectiveDamage: number,
): number {
  const objectiveShare = safeDivide(participant.damageDealtToObjectives, teamObjectiveDamage)
  const objectiveDamagePerMinute = safeDivide(participant.damageDealtToObjectives, minutes)
  const epicTakedowns =
    getChallengeNumber(participant, 'dragonTakedowns') +
    getChallengeNumber(participant, 'baronTakedowns')
  const turretTakedowns = getChallengeNumber(participant, 'turretTakedowns') || safeNumber(participant.turretTakedowns)
  const objectiveTarget = role === 'JUNGLE' ? 360 : role === 'BOTTOM' ? 290 : 230

  const objectiveDamageScore = scoreRange(objectiveDamagePerMinute, 20, objectiveTarget)
  const objectiveShareScore = scoreRange(objectiveShare, 0.08, role === 'JUNGLE' ? 0.45 : 0.32)
  const takedownScore = scoreRange(epicTakedowns * 0.9 + turretTakedowns * 0.45, 0, 2.2)

  return toPercent(objectiveDamageScore * 0.38 + objectiveShareScore * 0.32 + takedownScore * 0.3)
}

function calculateVisionScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
  visionPerMinute: number,
): number {
  const target = getRoleTarget(role, {
    TOP: 0.75,
    JUNGLE: 0.95,
    MIDDLE: 0.75,
    BOTTOM: 0.65,
    UTILITY: 1.65,
    ARAM: 0.28,
    SPECIAL: 0.25,
    UNKNOWN: 0.75,
  })
  const visionScore = scoreRange(visionPerMinute, target * 0.28, target)
  const wardWorkPerMinute = safeDivide(
    participant.wardsPlaced +
      participant.wardsKilled +
      participant.detectorWardsPlaced * 1.5 +
      getChallengeNumber(participant, 'wardTakedowns') * 0.6 +
      getChallengeNumber(participant, 'wardsGuarded') * 0.4,
    minutes,
  )
  const wardWorkScore = scoreRange(wardWorkPerMinute, 0.05, role === 'UTILITY' ? 0.75 : 0.35)

  return toPercent(visionScore * 0.72 + wardWorkScore * 0.28)
}

function calculateDurabilityScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
  damageTakenShare: number,
): number {
  const deathsPerMinute = safeDivide(participant.deaths, minutes)
  const survivalScore = 1 - scoreRange(deathsPerMinute, 0.16, 0.7)
  const pressureTarget = role === 'TOP' || role === 'UTILITY' ? 0.32 : 0.24
  const pressureScore = scoreRange(damageTakenShare, 0.08, pressureTarget)
  // 团队治疗/护盾已移到 teamUtility，避免重复计分；这里只保留自我减伤与自我回复。
  // totalHeal 包含对队友的治疗，需扣掉 totalHealsOnTeammates 后再计入生存维度。
  const selfHeal = Math.max(
    0,
    safeNumber(participant.totalHeal) - safeNumber(participant.totalHealsOnTeammates),
  )
  const sustainPerMinute = safeDivide(
    safeNumber(participant.damageSelfMitigated) + selfHeal * 0.35,
    minutes,
  )
  const utilityTarget = role === 'UTILITY' || role === 'TOP' ? 820 : 560
  const sustainedScore = scoreRange(sustainPerMinute, utilityTarget * 0.18, utilityTarget)

  return toPercent(survivalScore * 0.46 + pressureScore * 0.32 + sustainedScore * 0.22)
}

function calculateFarmingScore(role: SonaStrengthRole, csPerMinute: number): number {
  const target = getRoleTarget(role, {
    TOP: 7.2,
    JUNGLE: 5.8,
    MIDDLE: 7.4,
    BOTTOM: 7.8,
    UTILITY: 1.3,
    ARAM: 4.2,
    SPECIAL: 4.5,
    UNKNOWN: 6.2,
  })
  return toPercent(scoreRange(csPerMinute, target * 0.35, target))
}

type LanePressureMetric = 'gold' | 'experience' | 'cs' | 'damage' | 'vision' | 'killParticipation'

const LANE_PRESSURE_WEIGHTS: Record<SonaStrengthRole, Record<LanePressureMetric, number>> = {
  TOP: { gold: 0.22, experience: 0.18, cs: 0.2, damage: 0.18, vision: 0.1, killParticipation: 0.12 },
  JUNGLE: { gold: 0.18, experience: 0.15, cs: 0.1, damage: 0.17, vision: 0.2, killParticipation: 0.2 },
  MIDDLE: { gold: 0.2, experience: 0.16, cs: 0.18, damage: 0.22, vision: 0.1, killParticipation: 0.14 },
  BOTTOM: { gold: 0.22, experience: 0.12, cs: 0.22, damage: 0.24, vision: 0.06, killParticipation: 0.14 },
  UTILITY: { gold: 0.12, experience: 0.08, cs: 0.06, damage: 0.16, vision: 0.3, killParticipation: 0.28 },
  ARAM: { gold: 0.2, experience: 0.14, cs: 0.16, damage: 0.22, vision: 0.1, killParticipation: 0.18 },
  SPECIAL: { gold: 0.2, experience: 0.14, cs: 0.16, damage: 0.22, vision: 0.1, killParticipation: 0.18 },
  UNKNOWN: { gold: 0.2, experience: 0.14, cs: 0.16, damage: 0.2, vision: 0.12, killParticipation: 0.18 },
}

/** 找到敌方同位置玩家；优先 teamPosition，其次 individualPosition / lane。 */
function findLaneOpponent(game: SgpGameSummaryLol, participant: SgpParticipantLol): SgpParticipantLol | null {
  const position = getComparablePosition(participant)
  if (!position) return null

  return game.json.participants.find((item) => {
    return item.teamId !== participant.teamId && getComparablePosition(item) === position
  }) ?? null
}

function getComparablePosition(participant: SgpParticipantLol): string {
  return normalizePosition(participant.teamPosition)
    || normalizePosition(participant.individualPosition)
    || normalizePosition(participant.lane)
}

function normalizePosition(value: string | undefined): string {
  const normalized = (value ?? '').toUpperCase()
  if (normalized === 'TOP') return 'TOP'
  if (normalized === 'JUNGLE') return 'JUNGLE'
  if (normalized === 'MIDDLE' || normalized === 'MID') return 'MIDDLE'
  if (normalized === 'BOTTOM' || normalized === 'BOT') return 'BOTTOM'
  if (normalized === 'UTILITY' || normalized === 'SUPPORT') return 'UTILITY'
  return ''
}

/**
 * 对位压制：跨队同位置比较经济、经验、补刀、伤害、视野和参团率。
 * 大乱斗/斗魂没有稳定对线关系，直接缺省。
 */
function calculateLanePressureScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  opponent: SgpParticipantLol | null,
  minutes: number,
): number | null {
  if (role === 'ARAM' || role === 'SPECIAL' || !opponent) return null

  const participantExperience = safeNumber(participant.champExperience)
  const opponentExperience = safeNumber(opponent.champExperience)
  const participantCs = safeNumber(participant.totalMinionsKilled) + safeNumber(participant.neutralMinionsKilled)
  const opponentCs = safeNumber(opponent.totalMinionsKilled) + safeNumber(opponent.neutralMinionsKilled)
  const participantKp = getChallengeNumberOrNull(participant, 'killParticipation')
  const opponentKp = getChallengeNumberOrNull(opponent, 'killParticipation')
  const weights = LANE_PRESSURE_WEIGHTS[role] ?? LANE_PRESSURE_WEIGHTS.UNKNOWN

  const samples: Array<{ metric: LanePressureMetric; diff: number; range: number }> = [
    {
      metric: 'gold',
      diff: safeDivide(participant.goldEarned - opponent.goldEarned, minutes),
      range: role === 'UTILITY' ? 90 : 130,
    },
    {
      metric: 'cs',
      diff: safeDivide(participantCs - opponentCs, minutes),
      range: 1.8,
    },
  ]

  if (participantExperience > 0 || opponentExperience > 0) {
    samples.push({
      metric: 'experience',
      diff: safeDivide(participantExperience - opponentExperience, minutes),
      range: 100,
    })
  }

  if (safeNumber(participant.totalDamageDealtToChampions) > 0 || safeNumber(opponent.totalDamageDealtToChampions) > 0) {
    samples.push({
      metric: 'damage',
      diff: safeDivide(participant.totalDamageDealtToChampions - opponent.totalDamageDealtToChampions, minutes),
      range: role === 'UTILITY' ? 120 : 200,
    })
  }

  if (safeNumber(participant.visionScore) > 0 || safeNumber(opponent.visionScore) > 0) {
    samples.push({
      metric: 'vision',
      diff: safeDivide(participant.visionScore - opponent.visionScore, minutes),
      range: role === 'UTILITY' ? 0.7 : 0.45,
    })
  }

  if (participantKp !== null && opponentKp !== null) {
    samples.push({ metric: 'killParticipation', diff: participantKp - opponentKp, range: 0.18 })
  }

  let weightedTotal = 0
  let weightTotal = 0
  for (const sample of samples) {
    const weight = weights[sample.metric] ?? 0
    if (weight <= 0) continue
    weightedTotal += centeredScore(sample.diff, sample.range) * weight
    weightTotal += weight
  }

  if (weightTotal <= 0) return null
  return clamp(weightedTotal / weightTotal, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE)
}

/** 关键击杀：多杀、单杀、以少打多、传奇和连杀，按分钟归一化。 */
function calculateClutchScore(participant: SgpParticipantLol, minutes: number): number | null {
  const doubleKills = safeNumber(participant.doubleKills)
  const tripleKills = safeNumber(participant.tripleKills)
  const quadraKills = safeNumber(participant.quadraKills)
  const pentaKills = safeNumber(participant.pentaKills)
  const unrealKills = safeNumber(participant.unrealKills)
  const largestMultiKill = safeNumber(participant.largestMultiKill)
  const largestKillingSpree = safeNumber(participant.largestKillingSpree)
  const challengeKeys = ['legendaryCount', 'soloKills', 'outnumberedKills', 'killingSprees'] as const
  const hasChallengeData = challengeKeys.some((key) => getChallengeNumberOrNull(participant, key) !== null)
  const hasMultiKillData = [
    doubleKills,
    tripleKills,
    quadraKills,
    pentaKills,
    unrealKills,
    largestMultiKill,
    largestKillingSpree,
  ].some((value) => value > 0)

  // LCU 回退数据缺少 challenges 时不应把「缺失」当成 0 分。
  if (!hasChallengeData && !hasMultiKillData) return null

  const sprees = getChallengeNumberOrNull(participant, 'killingSprees') ?? safeNumber(participant.killingSprees)
  const multiKillPoints = doubleKills + tripleKills * 1.6 + quadraKills * 2.4 + pentaKills * 4 + unrealKills * 6
  const largestMultiKillBonus = Math.max(0, largestMultiKill - 1) * 0.8
  const clutchKills =
    getChallengeNumber(participant, 'legendaryCount') * 2.2 +
    getChallengeNumber(participant, 'soloKills') * 1.1 +
    getChallengeNumber(participant, 'outnumberedKills') * 1.4 +
    sprees * 0.5 +
    largestKillingSpree * 0.4
  const perMinute = safeDivide(multiKillPoints + largestMultiKillBonus + clutchKills, minutes)

  return toPercent(scoreRange(perMinute, 0.01, 0.26))
}

/** 团队功能：控制时长与团队治疗/护盾，按位置调整目标。 */
function calculateTeamUtilityScore(
  role: SonaStrengthRole,
  participant: SgpParticipantLol,
  minutes: number,
): number | null {
  const ccSeconds = Math.max(safeNumber(participant.timeCCingOthers), safeNumber(participant.totalTimeCCDealt))
  const teamHealShield = safeNumber(participant.totalHealsOnTeammates) +
    safeNumber(participant.totalDamageShieldedOnTeammates)
  const challengeValue = getChallengeNumberOrNull(participant, 'effectiveHealAndShielding')

  // SGP 正常返回时 challenges 字段存在（即使为 0 也是有效数据）；
  // LCU 回退数据所有来源都为 0 时视为缺失，返回 null。
  if (challengeValue === null && teamHealShield <= 0 && ccSeconds <= 0) return null

  // 优先使用只统计队友的治疗/护盾，避免把自我回复算进团队功能。
  const healShield = teamHealShield > 0 ? teamHealShield : (challengeValue ?? 0)
  const ccTarget = getRoleTarget(role, {
    TOP: 5.5,
    JUNGLE: 5,
    MIDDLE: 4,
    BOTTOM: 3,
    UTILITY: 5,
    ARAM: 4.5,
    SPECIAL: 4,
    UNKNOWN: 4.5,
  })
  const healTarget = getRoleTarget(role, {
    TOP: 180,
    JUNGLE: 160,
    MIDDLE: 130,
    BOTTOM: 120,
    UTILITY: 320,
    ARAM: 200,
    SPECIAL: 140,
    UNKNOWN: 160,
  })
  const ccScore = scoreRange(safeDivide(ccSeconds, minutes), 0.2, ccTarget)
  const healScore = scoreRange(safeDivide(healShield, minutes), 8, healTarget)
  const healWeight = role === 'UTILITY' ? 0.65 : role === 'BOTTOM' ? 0.55 : 0.45

  return toPercent(ccScore * (1 - healWeight) + healScore * healWeight)
}

function applyRoleMultipliers(
  breakdown: SonaScoreBreakdown,
  role: SonaStrengthRole,
): SonaScoreBreakdown {
  const multipliers = ROLE_DIMENSION_MULTIPLIERS[role] ?? ROLE_DIMENSION_MULTIPLIERS.UNKNOWN
  const result: Partial<Record<BreakdownKey, number>> = { ...breakdown }

  for (const key of BREAKDOWN_KEYS) {
    const multiplier = multipliers[key]
    const value = result[key]
    if (multiplier == null || value == null) continue
    result[key] = clamp(value * multiplier, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE)
  }

  return result as SonaScoreBreakdown
}

function calculateWeightedBreakdownScore(breakdown: SonaScoreBreakdown, weights: ScoreWeights): number {
  let weightedTotal = 0
  let weightTotal = 0

  for (const [key, weight] of Object.entries(weights)) {
    if (weight == null || weight <= 0) continue
    const value = breakdown[key as BreakdownKey]
    if (value == null || !Number.isFinite(value)) continue
    weightedTotal += value * weight
    weightTotal += weight
  }

  // 缺失维度（大乱斗对位压制、回退数据缺少 challenges）按实际参与维度重新归一化。
  if (weightTotal <= 0) return INTERNAL_NEUTRAL_SCORE
  return clamp(weightedTotal / weightTotal, 0, 100)
}

function averageBreakdown(games: SonaGameStrengthScore[], weights: number[]): SonaScoreBreakdown {
  const result: Partial<Record<BreakdownKey, number>> = {}

  for (const key of BREAKDOWN_KEYS) {
    const values: number[] = []
    const sampleWeights: number[] = []

    games.forEach((game, index) => {
      const value = game.breakdown[key]
      if (!isFiniteScore(value)) return
      values.push(value)
      sampleWeights.push(weights[index] ?? 1)
    })

    // 全部缺失时省略该字段，绝不把 undefined 当 0 参与加权。
    if (values.length > 0) {
      result[key] = weightedAverage(values, sampleWeights)
    }
  }

  return result as SonaScoreBreakdown
}

function normalizeWeights(weights: ScoreWeights): ScoreWeights {
  const total = Object.values(weights).reduce<number>((sumValue, value) => sumValue + (value ?? 0), 0)
  if (total <= 0) return BASE_WEIGHTS

  return Object.entries(weights).reduce((obj, [key, value]) => {
    obj[key as BreakdownKey] = (value ?? 0) / total
    return obj
  }, {} as ScoreWeights)
}

function getRoleTarget<T>(role: SonaStrengthRole, targets: Record<SonaStrengthRole, T>): T {
  return targets[role] ?? targets.UNKNOWN
}

function calculateSampleConfidence(validGames: number, options: SonaStrengthScoreOptions): number {
  const confidenceRange = Math.max(options.fullConfidenceGames - options.minConfidenceGames, 1)
  const normalized = clamp((validGames - options.minConfidenceGames) / confidenceRange, 0, 1)
  return 0.35 + normalized * 0.65
}

function calculateConsistencyScore(scores: number[]): number {
  if (scores.length <= 1) return INTERNAL_NEUTRAL_SCORE

  const deviation = standardDeviation(scores)
  return clamp(100 - deviation * 14, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE)
}

function calculateTrendScore(scores: number[]): number {
  if (scores.length < 8) return INTERNAL_NEUTRAL_SCORE

  const recent = average(scores.slice(0, 5))
  const older = average(scores.slice(5))
  return clamp(INTERNAL_NEUTRAL_SCORE + (recent - older) * 6.5, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE)
}

function winsorizeScores(scores: number[]): number[] {
  if (scores.length < 8) return scores

  const sorted = [...scores].sort((a, b) => a - b)
  const low = percentile(sorted, 0.05)
  const high = percentile(sorted, 0.95)
  return scores.map((score) => clamp(score, low, high))
}

function getRecencyWeight(index: number, halfLife: number): number {
  return Math.pow(0.5, index / Math.max(halfLife, 1))
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0

  const index = p * (sortedValues.length - 1)
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sortedValues[lower]

  const fraction = index - lower
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * fraction
}

function coefficientOfVariation(values: number[]): number {
  const avg = average(values)
  if (avg <= 0) return 0
  return standardDeviation(values) / avg
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0

  const avg = average(values)
  const variance = average(values.map((value) => Math.pow(value - avg, 2)))
  return Math.sqrt(variance)
}

function weightedAverage(values: number[], weights: number[]): number {
  const totalWeight = sum(weights, (value) => value)
  if (values.length === 0 || totalWeight <= 0) return 0

  return values.reduce((total, value, index) => total + value * (weights[index] ?? 1), 0) / totalWeight
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return sum(values, (value) => value) / values.length
}

function sum<T>(values: T[], mapper: (value: T) => number): number {
  return values.reduce((total, value) => total + safeNumber(mapper(value)), 0)
}

function getChallengeNumber(participant: SgpParticipantLol, key: string): number {
  return getChallengeNumberOrNull(participant, key) ?? 0
}

/** 区分「字段缺失」与「字段值为 0」。 */
function getChallengeNumberOrNull(participant: SgpParticipantLol, key: string): number | null {
  const value = participant.challenges?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isFiniteScore(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 开发模式下捕获 NaN/Infinity，避免脏数据进入 UI。 */
function warnIfInvalidBreakdown(breakdown: SonaScoreBreakdown, context: string): void {
  if (!isDevEnvironment()) return

  const invalidKeys = BREAKDOWN_KEYS.filter((key) => {
    const value = breakdown[key]
    return value != null && !Number.isFinite(value)
  })
  if (invalidKeys.length > 0) {
    console.warn(`[StrengthScore] ${context} breakdown 出现非法维度分数:`, invalidKeys)
  }
}

function isDevEnvironment(): boolean {
  const env = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env
  return Boolean(env?.DEV)
}

function getChallengeFlag(participant: SgpParticipantLol, key: string): boolean {
  const value = participant.challenges?.[key] as unknown
  return value === true || (typeof value === 'number' && value > 0)
}

function shouldSkipSonaGameForParticipant(
  game: SgpGameSummaryLol,
  participant: SgpParticipantLol,
  options: SonaStrengthScoreOptions,
): boolean {
  if (options.skipEarlySurrender && (participant.gameEndedInEarlySurrender || participant.teamEarlySurrendered)) {
    return true
  }

  return options.skipAfkTeammate && hasAfkTeammate(game, participant)
}

function hasAfkTeammate(game: SgpGameSummaryLol, participant: SgpParticipantLol): boolean {
  if (getChallengeFlag(participant, 'hadAfkTeammate')) {
    return true
  }

  return game.json.participants.some((item) => {
    return item.teamId === participant.teamId
      && item.puuid !== participant.puuid
      && getChallengeFlag(item, 'hadAfkTeammate')
  })
}

function scoreRange(value: number, zeroAt: number, fullAt: number): number {
  if (fullAt === zeroAt) return value >= fullAt ? 1 : 0
  return clamp((value - zeroAt) / (fullAt - zeroAt), 0, 1)
}

/** 把「我方 - 敌方」差值映射到 0-100，0 差值等于中性分 50。 */
function centeredScore(diff: number, range: number): number {
  if (range <= 0) return INTERNAL_NEUTRAL_SCORE
  return clamp(
    INTERNAL_NEUTRAL_SCORE + (diff / range) * INTERNAL_NEUTRAL_SCORE,
    INTERNAL_MIN_SCORE,
    INTERNAL_MAX_SCORE,
  )
}

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : 0
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function toPercent(value: number): number {
  return clamp(value * 100, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE)
}

function toDisplayScore(internalScore: number): number {
  const normalized = clamp(internalScore, INTERNAL_MIN_SCORE, INTERNAL_MAX_SCORE) / INTERNAL_MAX_SCORE
  const contrasted = clamp(0.5 + (normalized - 0.5) * DISPLAY_CONTRAST, 0, 1)
  return DISPLAY_MIN_SCORE + contrasted * (DISPLAY_MAX_SCORE - DISPLAY_MIN_SCORE)
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
