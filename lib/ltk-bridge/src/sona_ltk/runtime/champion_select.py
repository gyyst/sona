"""选人阶段的等待与基础皮肤改写：注入状态机的 LCU 边界。"""

from __future__ import annotations

import logging
import time
from enum import StrEnum

from ..models.lcu import INJECTABLE_PHASES, GameflowPhase
from ..services.lcu_client import LcuClient, LcuUnavailable

log = logging.getLogger(__name__)

# 等待本地玩家锁定英雄的总时长与阶段轮询间隔
CHAMPION_LOCK_TIMEOUT_S = 90.0
CHAMPION_LOCK_POLL_INTERVAL_S = 0.25


class ChampionSelectWait(StrEnum):
  """等待英雄锁定的结果；决定是否可以调用 my-selection。"""

  LOCKED = "locked"
  NOT_IN_CHAMP_SELECT = "not-in-champ-select"
  TIMEOUT = "timeout"
  ENDED = "ended"


class InjectionCancelled(RuntimeError):
  """对局阶段已结束或不可注入，本次注入取消。"""


def read_phase(lcu: LcuClient) -> GameflowPhase | None:
  """读取 LCU 阶段；短暂不可读时返回 None，由调用方决定降级策略。"""

  try:
    return lcu.get_phase()
  except Exception as exc:  # noqa: BLE001 - LCU 不可用不能中断注入状态机
    log.debug("读取 LCU 阶段失败：%s", exc)
    return None


def wait_for_champion_locked(
  lcu: LcuClient,
  champion_id: int,
  timeout_s: float | None = None,
) -> ChampionSelectWait:
  """阶段感知地等待本地玩家锁定英雄。

  每轮先检查 gameflow phase：离开 ChampSelect 立即返回，不再等满固定超时，
  避免选人结束后继续轮询会话、随后对 my-selection 发 404。
  """

  timeout = CHAMPION_LOCK_TIMEOUT_S if timeout_s is None else timeout_s
  deadline = time.monotonic() + timeout
  observed_champ_select = False
  logged_error = False

  while True:
    phase = read_phase(lcu)
    if phase is None:
      if not observed_champ_select:
        # LCU 一开始就不可读：保持原行为，不等待直接进入注入
        log.info("无法读取 LCU 阶段，跳过等待英雄锁定 champion=%s", champion_id)
        return ChampionSelectWait.NOT_IN_CHAMP_SELECT
    elif phase is not GameflowPhase.CHAMP_SELECT:
      log.info("LCU 阶段已离开选人（phase=%s），停止等待英雄锁定 champion=%s", phase, champion_id)
      if phase in INJECTABLE_PHASES:
        return ChampionSelectWait.NOT_IN_CHAMP_SELECT
      return ChampionSelectWait.ENDED
    else:
      observed_champ_select = True
      try:
        if lcu.get_champ_select_session().local_player_locked():
          return ChampionSelectWait.LOCKED
      except Exception as exc:  # noqa: BLE001 - 选人会话短暂不可读时继续轮询
        if not logged_error:
          log.debug("选人会话暂不可读，继续等待锁定：%s", exc)
          logged_error = True

    if time.monotonic() >= deadline:
      log.warning("等待英雄锁定超时，继续尝试注入 champion=%s", champion_id)
      return ChampionSelectWait.TIMEOUT
    time.sleep(CHAMPION_LOCK_POLL_INTERVAL_S)


def prepare_base_skin(
  lcu: LcuClient,
  champion_id: int,
  wait: ChampionSelectWait,
  phase: GameflowPhase | None,
) -> None:
  """只在「ChampSelect 且本地玩家已锁定」时改写基础皮肤。

  InProgress / GameStart / Reconnect 的迟到选择跳过改写但继续注入；
  Lobby / None / PostGame 等阶段直接取消，避免为已结束的对局残留 mod。
  """

  if wait is ChampionSelectWait.ENDED:
    raise InjectionCancelled(_ended_message(phase))

  if wait is ChampionSelectWait.LOCKED:
    if phase is GameflowPhase.CHAMP_SELECT:
      _force_base_skin(lcu, champion_id)
    else:
      log.info("英雄已锁定但阶段已离开选人（phase=%s），跳过强制基础皮肤", phase)
    return

  if phase is not None and phase not in INJECTABLE_PHASES:
    raise InjectionCancelled(_ended_message(phase))

  log.warning(
    "未确认英雄锁定（wait=%s, phase=%s），跳过强制基础皮肤并继续注入 champion=%s",
    wait,
    phase,
    champion_id,
  )


def _force_base_skin(lcu: LcuClient, champion_id: int) -> None:
  """改写基础皮肤；只吞掉「选人已结束」导致的 my-selection 404。

  其余 LCU 错误（连接失败、5xx、响应异常）照常抛出，避免掩盖真实故障。
  """

  try:
    lcu.force_base_skin(champion_id)
  except LcuUnavailable as exc:
    if exc.status_code != 404:
      raise
    phase = read_phase(lcu)
    if phase is GameflowPhase.CHAMP_SELECT:
      raise
    log.info("my-selection 已不可用（HTTP 404，phase=%s），跳过强制基础皮肤", phase)


def _ended_message(phase: GameflowPhase | None) -> str:
  if phase is None:
    return "对局阶段已结束（无法读取当前 LCU 阶段），已取消本次注入"
  return f"对局阶段已结束（当前阶段：{phase.value}），已取消本次注入"
