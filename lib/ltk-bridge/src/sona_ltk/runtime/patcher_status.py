"""patcher 就绪判定：只有进入 patching 阶段才算本次启动完成。"""

from __future__ import annotations

import logging
import time

from ..models.bridge import PatcherStatusValue, parse_patcher_status
from ..services.bridge_client import BridgeCommandError, BridgeUnavailable, LtkBridge
from .hints import failure_hint, patcher_failure_message

log = logging.getLogger(__name__)

# 轮询间隔：UAC 与 overlay 构建期间保持 applying，不阻塞状态查询线程
PATCHER_POLL_INTERVAL_S = 0.25

# 已知的 patcher phase（与 LTK Manager 的 PatcherPhase 对齐）
_KNOWN_PHASES = frozenset({"idle", "building", "patching"})

NOT_READY_HINT = (
  "patcher 未进入注入阶段（可能取消了 UAC、overlay 构建失败或 host 已退出），"
  "请重新选择皮肤并在弹窗中允许"
)
TIMEOUT_HINT = "等待 patcher 进入注入阶段超时（{seconds:g} 秒）；请检查 UAC 弹窗是否被遮挡后重试"
BRIDGE_LOST_HINT = "与 LTK Manager 的连接中断，无法确认 patcher 状态；请重新选择皮肤"


def read_patcher_status(bridge: LtkBridge) -> PatcherStatusValue | None:
  """读取一次 patcher 状态；ok=false 或连接中断时抛出，结构不可解析时返回 None。"""

  try:
    response = bridge.patcher_status()
  except BridgeUnavailable as exc:
    raise BridgeCommandError(BRIDGE_LOST_HINT) from exc
  if not response.ok:
    raise BridgeCommandError(patcher_failure_message(response))
  return parse_patcher_status(response)


def patcher_is_running(bridge: LtkBridge) -> bool:
  """按 running 或旧版 status 字段判断 patcher 是否已启动。"""

  try:
    status = read_patcher_status(bridge)
  except BridgeCommandError:
    return False
  if status is None:
    return False
  return status.running is True or (status.status or "").lower() in {"running", "active"}


def wait_for_patcher_ready(bridge: LtkBridge, timeout_s: float) -> None:
  """等待 patcher 进入 patching 阶段，超时或提前退出时抛出。

  旧版 LTK Manager 不返回 phase 时无法确认就绪：记录警告后按已启动处理，保持原有行为。
  未知的非空 phase 视为未就绪，继续等待直到超时。
  """

  deadline = time.monotonic() + timeout_s
  unknown_phase_logged = False
  while True:
    status = read_patcher_status(bridge)
    if status is None:
      log.warning("patcher_status 不含可解析状态，跳过就绪等待（旧版 LTK Manager）")
      return

    phase = status.phase_name
    if phase == "patching":
      return
    if phase == "idle":
      # start_patcher 成功但会话已回到 idle：UAC 取消、构建失败或 host 提前退出
      hint = failure_hint(status.error) if status.error is not None else None
      raise BridgeCommandError(hint or NOT_READY_HINT)
    if not phase:
      log.warning("patcher_status 不含 phase，跳过就绪等待（旧版 LTK Manager）")
      return
    if phase not in _KNOWN_PHASES and not unknown_phase_logged:
      # 未来版本新增的中间阶段不能当成已就绪；继续等待，直到 patching 或超时
      log.warning("未知 patcher phase %s，继续等待", phase)
      unknown_phase_logged = True

    if time.monotonic() >= deadline:
      raise BridgeCommandError(TIMEOUT_HINT.format(seconds=timeout_s))
    time.sleep(PATCHER_POLL_INTERVAL_S)
