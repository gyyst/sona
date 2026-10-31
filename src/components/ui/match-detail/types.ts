/** 战绩详情子页签共用的玩家展示信息 */
export interface DetailPlayer {
  participantId: number
  /** 完整 Riot ID，例如 Name#TAG */
  name: string
  championId: number
  teamId: number
}
