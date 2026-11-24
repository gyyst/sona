"""LCU 最小数据模型。"""

from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .base import LcuModel


class GameflowPhase(StrEnum):
  NONE = "None"
  LOBBY = "Lobby"
  MATCHMAKING = "Matchmaking"
  READY_CHECK = "ReadyCheck"
  CHAMP_SELECT = "ChampSelect"
  GAME_START = "GameStart"
  IN_PROGRESS = "InProgress"
  RECONNECT = "Reconnect"
  PRE_END_GAME = "PreEndGame"
  END_GAME = "EndGame"
  POST_GAME = "PostGame"

  @classmethod
  def from_api(cls, value: str) -> GameflowPhase:
    """未知阶段安全降级为 NONE。"""

    try:
      return cls(value)
    except ValueError:
      return cls.NONE


class LockfileData(LcuModel):
  name: str
  # 进程命令行回退时可能缺少 --app-pid，此时 pid 为 0
  pid: int = Field(ge=0)
  port: int = Field(gt=0, le=65535)
  password: str
  protocol: str


class ChampSelectPlayer(LcuModel):
  cell_id: int
  champion_id: int = 0
  selected_skin_id: int = 0


class ChampSelectAction(LcuModel):
  actor_cell_id: int = 0
  type: str = ""
  completed: bool = False


class ChampSelectSession(LcuModel):
  local_player_cell_id: int
  my_team: list[ChampSelectPlayer]
  actions: list[list[list[ChampSelectAction]]] = Field(default_factory=list)

  def local_player(self) -> ChampSelectPlayer | None:
    return next(
      (player for player in self.my_team if player.cell_id == self.local_player_cell_id),
      None,
    )

  def local_player_locked(self) -> bool:
    """本地玩家的选人动作是否已完成（英雄已锁定）。"""

    return any(
      action.actor_cell_id == self.local_player_cell_id
      and action.type == "pick"
      and action.completed
      for group in self.actions
      for round_ in group
      for action in round_
    )
