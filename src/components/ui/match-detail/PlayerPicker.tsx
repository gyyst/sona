import { getChampIcon } from '@/lib/assets'
import type { DetailPlayer } from './types'

export interface PlayerPickerProps {
  players: DetailPlayer[]
  activeId: number | null
  onSelect: (participantId: number) => void
}

/** 出装 / 技能加点共用的玩家选择列表 */
export function PlayerPicker({ players, activeId, onSelect }: PlayerPickerProps) {
  return (
    <div className="smd-path-players">
      {players.map((player) => (
        <button
          key={player.participantId}
          type="button"
          className={`smd-path-player${player.teamId === 200 ? ' smd-path-player--red' : ''}${activeId === player.participantId ? ' smd-path-player--active' : ''}`}
          onClick={() => onSelect(player.participantId)}
        >
          <img src={getChampIcon(player.championId)} alt="" />
          <span className="smd-path-player-name">{player.name}</span>
        </button>
      ))}
    </div>
  )
}
