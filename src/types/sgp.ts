/**
 * SGP (Service Gateway Proxy) 类型声明
 *
 * SGP 是 Riot 的外部战绩/召唤师/排位查询 API，
 * 相比 LCU 内部接口，SGP 支持跨区查询、按队列 tag 过滤、突破 100 场上限等。
 *
 * 类型定义参考自 LeagueAkari 项目 (https://github.com/LeagueAkari/LeagueAkari)
 * 的 src/shared/data-sources/sgp/types.ts，根据实际返回数据补充了部分字段。
 */

// ==================== 战绩列表 ====================

export interface SgpMatchHistoryLol {
  games: SgpGameSummaryLol[]
}

export interface SgpGameSummaryLol {
  metadata: SgpGameMetadataLol
  json: SgpGameSummaryJsonLol
}

export interface SgpGameMetadataLol {
  product: string
  tags: string[]
  participants: string[]
  timestamp: string
  data_version: string
  info_type: string
  match_id: string
  private: boolean
}

export interface SgpGameSummaryJsonLol {
  endOfGameResult: string
  gameCreation: number
  gameDuration: number
  gameEndTimestamp: number
  gameId: number
  gameMode: string
  /** 模式变体，如 ARAM 的 "mapskin_ha_bilgewater" */
  gameModeMutators: string[]
  gameName: string
  gameStartTimestamp: number
  gameType: string
  gameVersion: string
  mapId: number
  participants: SgpParticipantLol[]
  platformId: string
  queueId: number
  seasonId: number
  teams: SgpTeam[]
  tournamentCode: string
}

// ==================== 队伍 ====================

export interface SgpTeam {
  bans: SgpBan[]
  objectives: SgpObjectives
  teamId: number
  win: boolean
}

export interface SgpBan {
  championId: number
  pickTurn: number
}

export interface SgpObjectives {
  baron: SgpObjectiveStat
  champion: SgpObjectiveStat
  dragon: SgpObjectiveStat
  horde: SgpObjectiveStat
  inhibitor: SgpObjectiveStat
  riftHerald: SgpObjectiveStat
  tower: SgpObjectiveStat
}

export interface SgpObjectiveStat {
  first: boolean
  kills: number
}

// ==================== 参与者 ====================

export interface SgpParticipantLol {
  /** 行为标记（如英雄是否在战斗中） */
  PlayerBehavior: {
    PlayerBehavior_IsHeroInCombat: number
  }
  /** 评分字段 0-11，游戏内置计分板数据 */
  PlayerScore0: number
  PlayerScore1: number
  PlayerScore2: number
  PlayerScore3: number
  PlayerScore4: number
  PlayerScore5: number
  PlayerScore6: number
  PlayerScore7: number
  PlayerScore8: number
  PlayerScore9: number
  PlayerScore10: number
  PlayerScore11: number
  allInPings: number
  assistMePings: number
  assists: number
  baronKills: number
  basicPings: number
  bountyLevel?: number
  challenges: SgpChallenges
  champExperience: number
  champLevel: number
  championId: number
  championName: string
  championTransform: number
  commandPings: number
  consumablesPurchased: number
  damageDealtToBuildings: number
  damageDealtToEpicMonsters: number
  damageDealtToObjectives: number
  damageDealtToTurrets: number
  damageSelfMitigated: number
  dangerPings: number
  deaths: number
  detectorWardsPlaced: number
  doubleKills: number
  dragonKills: number
  eligibleForProgression: boolean
  enemyMissingPings: number
  enemyVisionPings: number
  firstBloodAssist: boolean
  firstBloodKill: boolean
  firstTowerAssist: boolean
  firstTowerKill: boolean
  gameEndedInEarlySurrender: boolean
  gameEndedInSurrender: boolean
  getBackPings: number
  goldEarned: number
  goldSpent: number
  holdPings: number
  individualPosition: string
  inhibitorKills: number
  inhibitorTakedowns: number
  inhibitorsLost: number
  item0: number
  item1: number
  item2: number
  item3: number
  item4: number
  item5: number
  item6: number
  itemsPurchased: number
  killingSprees: number
  kills: number
  lane: string
  largestCriticalStrike: number
  largestKillingSpree: number
  largestMultiKill: number
  longestTimeSpentLiving: number
  magicDamageDealt: number
  magicDamageDealtToChampions: number
  magicDamageTaken: number
  /** 任务进度数据，键名不固定，随活动/版本变化 */
  missions: Record<string, number>
  needVisionPings: number
  neutralMinionsKilled: number
  nexusKills: number
  nexusLost: number
  nexusTakedowns: number
  objectivesStolen: number
  objectivesStolenAssists: number
  onMyWayPings: number
  participantId: number
  pentaKills: number
  perks: SgpPerks
  physicalDamageDealt: number
  physicalDamageDealtToChampions: number
  physicalDamageTaken: number
  placement: number
  playerAugment1: number
  playerAugment2: number
  playerAugment3: number
  playerAugment4: number
  playerAugment5: number
  playerAugment6: number
  playerSubteamId: number
  profileIcon: number
  pushPings: number
  puuid: string
  quadraKills: number
  retreatPings: number
  riotIdGameName: string
  riotIdTagline: string
  role: string
  roleBoundItem: number
  sightWardsBoughtInGame: number
  spell1Casts: number
  spell1Id: number
  spell2Casts: number
  spell2Id: number
  spell3Casts: number
  spell4Casts: number
  subteamPlacement: number
  summoner1Casts: number
  summoner2Casts: number
  summonerId: number
  summonerLevel: number
  summonerName: string
  teamEarlySurrendered: boolean
  teamId: number
  teamPosition: string
  timeCCingOthers: number
  timePlayed: number
  totalAllyJungleMinionsKilled: number
  totalDamageDealt: number
  totalDamageDealtToChampions: number
  totalDamageShieldedOnTeammates: number
  totalDamageTaken: number
  totalEnemyJungleMinionsKilled: number
  totalHeal: number
  totalHealsOnTeammates: number
  totalMinionsKilled: number
  totalTimeCCDealt: number
  totalTimeSpentDead: number
  totalUnitsHealed: number
  tripleKills: number
  trueDamageDealt: number
  trueDamageDealtToChampions: number
  trueDamageTaken: number
  turretKills: number
  turretTakedowns: number
  turretsLost: number
  unrealKills: number
  visionClearedPings: number
  visionScore: number
  visionWardsBoughtInGame: number
  wardsKilled: number
  wardsPlaced: number
  win: boolean
}

// ==================== 符文 ====================

export interface SgpPerks {
  statPerks: SgpStatPerks
  styles: SgpPerkStyle[]
}

export interface SgpPerkStyle {
  description: string
  selections: SgpPerkSelection[]
  style: number
}

export interface SgpPerkSelection {
  perk: number
  var1: number
  var2: number
  var3: number
}

export interface SgpStatPerks {
  defense: number
  flex: number
  offense: number
}

// ==================== 挑战数据 ====================

/**
 * challenges 字段包含大量游戏内挑战/成就统计。
 * 键名随版本和活动变化，因此用 Record 表示核心数值字段，
 * 同时列出已知的常用字段以便 IDE 提示。
 */
export interface SgpChallenges extends Record<string, number | number[]> {
  abilityUses: number
  acesBefore15Minutes: number
  baronTakedowns: number
  damagePerMinute: number
  damageTakenOnTeamPercentage: number
  deathsByEnemyChamps: number
  dragonTakedowns: number
  effectiveHealAndShielding: number
  goldPerMinute: number
  kda: number
  killParticipation: number
  killingSprees: number
  killsNearEnemyTurret: number
  legendaryCount: number
  legendaryItemUsed: number[]
  multikills: number
  outnumberedKills: number
  skillshotsDodged: number
  skillshotsHit: number
  soloKills: number
  takedowns: number
  teamDamagePercentage: number
  turretTakedowns: number
  visionScorePerMinute: number
  wardTakedowns: number
  wardsGuarded: number
}

// ==================== Entitlements Token ====================

export interface SgpEntitlementsToken {
  /** JWT access token，用于 Authorization: Bearer {accessToken} 请求 SGP 战绩接口 */
  accessToken: string
  /** Entitlements JWT（格式不同，部分 SGP 接口可能需要） */
  token: string
  /** 权限列表（通常为空数组） */
  entitlements: unknown[]
  /**
   * 签发者 URL，如 `http://hn1-k8s-bcs-internal.lol.qq.com:28088`
   * 可从中解析当前区服（hn1 = 艾欧尼亚、hn10 = 黑色玫瑰 等）
   */
  issuer: string
  /** 玩家 PUUID */
  subject: string
}

// ==================== SGP 服务器配置 ====================

/**
 * SGP 服务器地址映射
 *
 * 数据来源：LeagueAkari 项目 (https://github.com/LeagueAkari/LeagueAkari)
 * 文件路径：resources/builtin-config/sgp/league-servers.json
 *
 * 国服所有大区共享同一个 JWT Token，可跨区查询战绩（tencentServerMatchHistoryInteroperability）
 */
export const SGP_SERVERS: Record<string, { matchHistory: string | null; common: string | null }> = {
  // ===== 国服 (Tencent) =====
  TENCENT_HN1:   { matchHistory: 'https://hn1-k8s-sgp.lol.qq.com:21019',   common: 'https://hn1-k8s-sgp.lol.qq.com:21019' },
  TENCENT_HN10:  { matchHistory: 'https://hn10-k8s-sgp.lol.qq.com:21019',  common: 'https://hn10-k8s-sgp.lol.qq.com:21019' },
  TENCENT_TJ100: { matchHistory: 'https://tj100-sgp.lol.qq.com:21019',     common: 'https://tj100-sgp.lol.qq.com:21019' },
  TENCENT_TJ101: { matchHistory: 'https://tj101-sgp.lol.qq.com:21019',     common: 'https://tj101-sgp.lol.qq.com:21019' },
  TENCENT_NJ100: { matchHistory: 'https://nj100-sgp.lol.qq.com:21019',     common: 'https://nj100-sgp.lol.qq.com:21019' },
  TENCENT_GZ100: { matchHistory: 'https://gz100-sgp.lol.qq.com:21019',     common: 'https://gz100-sgp.lol.qq.com:21019' },
  TENCENT_CQ100: { matchHistory: 'https://cq100-sgp.lol.qq.com:21019',     common: 'https://cq100-sgp.lol.qq.com:21019' },
  TENCENT_BGP2:  { matchHistory: 'https://bgp2-k8s-sgp.lol.qq.com:21019',  common: 'https://bgp2-k8s-sgp.lol.qq.com:21019' },
  TENCENT_PBE:   { matchHistory: 'https://pbe-sgp.lol.qq.com:21019',       common: 'https://pbe-sgp.lol.qq.com:21019' },
  TENCENT_PREPBE:{ matchHistory: 'https://prepbe-sgp.lol.qq.com:21019',    common: 'https://prepbe-sgp.lol.qq.com:21019' },

  // ===== 外服 =====
  TW2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://tw2-red.lol.sgp.pvp.net' },
  SG2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://sg2-red.lol.sgp.pvp.net' },
  PH2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://ph2-red.lol.sgp.pvp.net' },
  VN2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://vn2-red.lol.sgp.pvp.net' },
  TH2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://th2-red.lol.sgp.pvp.net' },
  JP1:  { matchHistory: 'https://apne1-red.pp.sgp.pvp.net',  common: 'https://jp-red.lol.sgp.pvp.net' },
  KR:   { matchHistory: 'https://apne1-red.pp.sgp.pvp.net',  common: 'https://kr-red.lol.sgp.pvp.net' },
  NA1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: 'https://na-red.lol.sgp.pvp.net' },
  BR1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: 'https://br-red.lol.sgp.pvp.net' },
  LA1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: 'https://lan-red.lol.sgp.pvp.net' },
  LA2:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: 'https://las-red.lol.sgp.pvp.net' },
  OC1:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: 'https://oce-red.lol.sgp.pvp.net' },
  EUW:  { matchHistory: 'https://euc1-red.pp.sgp.pvp.net',   common: 'https://euw-red.lol.sgp.pvp.net' },
  EUN1: { matchHistory: 'https://euc1-red.pp.sgp.pvp.net',   common: 'https://eun1-red.lol.sgp.pvp.net' },
  TR1:  { matchHistory: 'https://euc1-red.pp.sgp.pvp.net',   common: 'https://tr-red.lol.sgp.pvp.net' },
  RU:   { matchHistory: 'https://euc1-red.pp.sgp.pvp.net',   common: 'https://ru-red.lol.sgp.pvp.net' },
  PBE:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: 'https://pbe-red.lol.sgp.pvp.net' },

  // issuer fallback 有时只能解析到 regional PP 集群，保留 match-history 能力即可。
  EUC1:  { matchHistory: 'https://euc1-red.pp.sgp.pvp.net',   common: null },
  USW2:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net',   common: null },
  APSE1: { matchHistory: 'https://apse1-red.pp.sgp.pvp.net',  common: null },
  APNE1: { matchHistory: 'https://apne1-red.pp.sgp.pvp.net',  common: null },
}

/** 国服大区互通列表 —— 同一个 JWT Token 可查询以下所有大区的战绩 */
export const TENCENT_MATCH_HISTORY_INTEROP = [
  'TENCENT_HN1',
  'TENCENT_HN10',
  'TENCENT_NJ100',
  'TENCENT_GZ100',
  'TENCENT_CQ100',
  'TENCENT_TJ100',
  'TENCENT_TJ101',
  'TENCENT_BGP2',
  'TENCENT_PBE',
  'TENCENT_PREPBE',
] as const

// ==================== SGP Tag 过滤 ====================

/**
 * 将 queueId 转换为 SGP tag
 *
 * 直接拼 `q_` 前缀，不做白名单校验。
 */
export function queueIdToTag(queueId: number): string {
  return queueId > 0 ? `q_${queueId}` : ''
}

// ==================== 单局详情（DETAILS） ====================

/**
 * SGP 单局详情响应（match-history-query/.../DETAILS）
 *
 * 字段参考 LeagueAkari，全部按可选处理：旧对局、跨区对局或接口变更时
 * 可能缺少 frames / events，消费方必须防御式读取。
 */
export interface SgpGameDetailsLol {
  metadata?: Partial<SgpGameMetadataLol>
  json?: SgpGameDetailsJsonLol
}

export interface SgpGameDetailsJsonLol {
  endOfGameResult?: string
  /** 帧间隔（通常 60000ms）；渲染时应以 frames[].timestamp 为准 */
  frameInterval?: number
  frames?: SgpTimelineFrameLol[]
  gameId?: number
  participants?: SgpDetailsParticipantLol[]
}

export interface SgpDetailsParticipantLol {
  participantId?: number
  puuid?: string
  teamId?: number
}

export interface SgpPositionLol {
  x?: number
  y?: number
}

export interface SgpTimelineFrameLol {
  timestamp?: number
  events?: SgpTimelineEventLol[]
  participantFrames?: Record<string, SgpDetailedParticipantFrameLol>
}

/** DETAILS 帧内的逐人经济/等级/坐标快照 */
export interface SgpDetailedParticipantFrameLol {
  participantId?: number
  currentGold?: number
  totalGold?: number
  goldPerSecond?: number
  level?: number
  xp?: number
  minionsKilled?: number
  jungleMinionsKilled?: number
  timeEnemySpentControlled?: number
  position?: SgpPositionLol
  championStats?: Record<string, number>
  damageStats?: Record<string, number>
}

/** DETAILS 事件类型（保留 string 兜底，避免新版本新增类型时类型报错） */
export type SgpTimelineEventType =
  | 'PAUSE_END'
  | 'LEVEL_UP'
  | 'SKILL_LEVEL_UP'
  | 'ITEM_PURCHASED'
  | 'ITEM_SOLD'
  | 'ITEM_DESTROYED'
  | 'ITEM_UNDO'
  | 'WARD_PLACED'
  | 'WARD_KILL'
  | 'CHAMPION_KILL'
  | 'CHAMPION_SPECIAL_KILL'
  | 'BUILDING_KILL'
  | 'ELITE_MONSTER_KILL'
  | 'DRAGON_SOUL_GIVEN'
  | 'OBJECTIVE_BOUNTY_PRESTART'
  | 'GAME_END'
  | 'TURRET_PLATE_DESTROYED'

export interface SgpTimelineEventLol {
  type?: SgpTimelineEventType | string
  timestamp?: number
  participantId?: number
  killerId?: number
  victimId?: number
  creatorId?: number
  assistingParticipantIds?: number[]
  itemId?: number
  beforeId?: number
  afterId?: number
  /** 1-4 对应 Q/W/E/R */
  skillSlot?: number
  levelUpType?: string
  level?: number
  monsterType?: string
  monsterSubType?: string
  buildingType?: string
  towerType?: string
  laneType?: string
  teamId?: number
  killType?: string
  wardType?: string
  bounty?: number
  shutdownBounty?: number
  killStreakLength?: number
  goldGain?: number
  winningTeam?: number
  realTimestamp?: number
  position?: SgpPositionLol
}

/** 国服大区中文名映射 */
export const TENCENT_SERVER_NAMES: Record<string, string> = {
  TENCENT_HN1: '艾欧尼亚',
  TENCENT_HN10: '黑色玫瑰',
  TENCENT_TJ100: '联盟四区',
  TENCENT_TJ101: '联盟五区',
  TENCENT_NJ100: '联盟一区',
  TENCENT_GZ100: '联盟二区',
  TENCENT_CQ100: '联盟三区',
  TENCENT_BGP2: '峡谷之巅',
  TENCENT_PBE: 'PBE (腾讯)',
  TENCENT_PREPBE: 'PREPBE (腾讯)',
}
