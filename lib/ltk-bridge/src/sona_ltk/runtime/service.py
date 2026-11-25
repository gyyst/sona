"""后台服务：LCU phase 监控、注入调度与状态广播。"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

from ..models.config import BridgeConfig
from ..models.events import ServerStatus, SkinSelection
from ..models.lcu import INJECTABLE_PHASES, GameflowPhase
from ..runtime.injection import InjectionManager, InjectionSnapshot, InjectionStatus
from ..services.lcu_client import LcuClient, LcuUnavailable
from ..services.manager import ManagerInstaller
from ..services.skin_library import SkinLibrary
from ..services.update.script import (
  STARTUP_CLEANUP_DELAY_S,
  UpdatePlan,
  cleanup_stale_update_files,
)
from .self_update import SelfUpdater
from .websocket_server import WebSocketServer

log = logging.getLogger(__name__)

MANAGER_INSTALL_CAPABILITY = "ltk-manager-install"
MANAGER_REFRESH_INTERVAL_S = 10.0
MANAGER_PROGRESS_INTERVAL_S = 0.5

# 只有这些阶段允许后台替换运行时并重启；选人/对局/重连期间延迟
SAFE_RESTART_PHASES = frozenset({
  GameflowPhase.NONE,
  GameflowPhase.LOBBY,
  GameflowPhase.PRE_END_GAME,
  GameflowPhase.END_GAME,
  GameflowPhase.POST_GAME,
})

# 相同选择的抑制窗口：失败后的重试必须在窗口外才会再次进入注入状态机
DUPLICATE_SELECTION_WINDOW_S = 2.0
_DUPLICATE_INJECTION_STATUSES = frozenset({
  InjectionStatus.APPLYING,
  InjectionStatus.APPLIED,
  InjectionStatus.ERROR,
})

SelectionKey = tuple[int, int, int | None, int | None]


def _selection_key(selection: SkinSelection) -> SelectionKey:
  return (selection.champion_id, selection.skin_id, selection.chroma_id, selection.form_id)


class BridgeService:
  """所有阻塞 I/O 都通过 asyncio.to_thread，避免卡住 WebSocket。"""

  def __init__(self, config: BridgeConfig, project_root: Path) -> None:
    self._config = config
    self._project_root = project_root
    self._phase = GameflowPhase.NONE
    self._lcu_ready = False
    self._library = SkinLibrary(config, project_root / "data" / "skins")
    self._lcu = LcuClient(config)
    self._injection = InjectionManager(config, self._library, self._lcu, project_root)
    self._manager_installer = ManagerInstaller(config, project_root)
    self._install_task: asyncio.Task[None] | None = None
    self._last_manager_refresh = 0.0
    self._selection_lock = asyncio.Lock()
    self._last_selection_key: SelectionKey | None = None
    self._last_selection_at = 0.0
    self._stop_event = asyncio.Event()
    self._cleanup_task: asyncio.Task[None] | None = None
    self._websocket = WebSocketServer(
      config.websocket_port,
      config.auth_token,
      self.handle_selection,
      self.status,
      self.handle_install_manager,
    )
    self._self_update = SelfUpdater(
      config,
      project_root,
      request_stop=self._request_stop,
      is_safe_to_restart=self._can_restart_backend,
      notify=self._broadcast_update_status,
    )

  async def run(self) -> UpdatePlan | None:
    await self._websocket.start()
    log.info("Sona LTK bridge listening on ws://127.0.0.1:%s", self._config.websocket_port)
    self._cleanup_task = asyncio.create_task(
      self._cleanup_stale_update_files(),
      name="sona-ltk-update-cleanup",
    )
    self._self_update.start()
    try:
      while not self._stop_event.is_set():
        await self._poll_phase()
        try:
          await asyncio.wait_for(self._stop_event.wait(), timeout=1.0)
        except TimeoutError:
          pass
    except asyncio.CancelledError:
      await asyncio.to_thread(self._injection.cleanup)
      raise
    finally:
      if self._cleanup_task is not None:
        self._cleanup_task.cancel()
        await asyncio.gather(self._cleanup_task, return_exceptions=True)
      await self._self_update.stop()
      await self._websocket.stop()
    return self._self_update.plan

  async def _cleanup_stale_update_files(self) -> None:
    await asyncio.sleep(STARTUP_CLEANUP_DELAY_S)
    await asyncio.to_thread(cleanup_stale_update_files, self._project_root)

  def _request_stop(self) -> None:
    """自更新完成替换准备后请求主循环退出，由入口脚本执行替换。"""

    self._stop_event.set()

  def _can_restart_backend(self) -> bool:
    if self._phase not in SAFE_RESTART_PHASES:
      return False
    if self._injection.active:
      return False
    # 选择处理在注入 active 变为 True 之前也有一段窗口；用选择锁覆盖整个 apply。
    if self._selection_lock.locked():
      return False
    return self._install_task is None or self._install_task.done()

  async def _broadcast_update_status(self) -> None:
    await self._websocket.broadcast()

  async def handle_selection(self, selection: SkinSelection) -> None:
    if self._is_recent_duplicate(selection):
      log.info("忽略 %s 秒内的重复皮肤选择：%s", DUPLICATE_SELECTION_WINDOW_S, selection.skin_name)
      return

    # 多个 WebSocket 连接不能并发进入注入状态机；排队后再判定一次重复
    async with self._selection_lock:
      if self._is_recent_duplicate(selection):
        log.info("忽略排队期间变为重复的皮肤选择：%s", selection.skin_name)
        return
      await self._apply_selection(selection)

  async def _apply_selection(self, selection: SkinSelection) -> None:
    if self._phase not in INJECTABLE_PHASES:
      log.info("忽略非选人/游戏阶段的皮肤选择：%s", selection.skin_name)
      await self._websocket.broadcast(
        self._server_status(
          phase=str(self._phase),
          injection_status=str(InjectionStatus.IDLE),
          message="当前不在英雄选择或游戏阶段，已忽略本次选择",
          skin_name=selection.skin_name,
        ),
      )
      return

    # 记录开始时间：同一选择在 applying 期间的重复消息直接返回
    self._note_selection(selection)
    await self._websocket.broadcast(
      self._server_status(
        phase=str(self._phase),
        injection_status=str(InjectionStatus.APPLYING),
        message=f"正在准备 {selection.skin_name}，如弹出 UAC 请允许",
        skin_name=selection.skin_name,
      ),
    )
    try:
      await asyncio.to_thread(self._injection.apply, selection)
    finally:
      # 完成时间用于计算重复抑制窗口，避免失败后立刻重放同一条选择
      self._note_selection(selection)
    await self._websocket.broadcast()

  def _note_selection(self, selection: SkinSelection) -> None:
    self._last_selection_key = _selection_key(selection)
    self._last_selection_at = time.monotonic()

  def _is_recent_duplicate(self, selection: SkinSelection) -> bool:
    if self._last_selection_key != _selection_key(selection):
      return False
    if time.monotonic() - self._last_selection_at > DUPLICATE_SELECTION_WINDOW_S:
      return False
    return self._injection.snapshot().status in _DUPLICATE_INJECTION_STATUSES

  async def _poll_phase(self) -> None:
    try:
      await self._refresh_manager_status()
    except Exception:
      # LTK Manager 探测失败（如 psutil 权限错误）不能跳过或终止本轮 phase 轮询
      log.exception("LTK Manager 状态刷新异常，继续轮询")

    try:
      phase = await asyncio.to_thread(self._lcu.get_phase)
    except LcuUnavailable:
      if self._lcu_ready:
        self._lcu_ready = False
        log.info("LCU 连接已断开，等待客户端恢复")
      return
    except Exception:
      # 单次轮询异常不能终止后台循环；LcuUnavailable 已在上方静默处理
      log.exception("LCU phase 轮询异常，继续重试")
      return

    if not self._lcu_ready:
      self._lcu_ready = True
      log.info("LCU 连接已就绪（phase=%s）", phase)

    previous = self._phase
    self._phase = phase
    if phase != previous:
      log.info("LCU phase: %s → %s", previous, phase)

    if phase in {
      GameflowPhase.LOBBY,
      GameflowPhase.PRE_END_GAME,
      GameflowPhase.END_GAME,
      GameflowPhase.POST_GAME,
    } and self._injection.active:
      await asyncio.to_thread(self._injection.cleanup)

    if phase != previous:
      await self._websocket.broadcast()

  async def handle_install_manager(self) -> None:
    """立即返回，安装任务在后台运行并通过状态广播反馈进度。"""

    if self._install_task is not None and not self._install_task.done():
      return
    self._install_task = asyncio.create_task(self._run_manager_install())

  async def _run_manager_install(self) -> None:
    task = asyncio.create_task(asyncio.to_thread(self._manager_installer.install))
    try:
      while not task.done():
        await asyncio.sleep(MANAGER_PROGRESS_INTERVAL_S)
        await self._websocket.broadcast()
      await task
    except Exception:
      log.exception("LTK Manager 安装任务异常")
    finally:
      await self._websocket.broadcast()

  async def _refresh_manager_status(self) -> None:
    now = time.monotonic()
    if now - self._last_manager_refresh < MANAGER_REFRESH_INTERVAL_S:
      return
    self._last_manager_refresh = now
    before = self._manager_installer.snapshot()
    await asyncio.to_thread(self._manager_installer.refresh)
    after = self._manager_installer.snapshot()
    if (
      before.status != after.status
      or before.progress != after.progress
      or before.message != after.message
      or before.manager_path != after.manager_path
    ):
      await self._websocket.broadcast()

  def status(self) -> ServerStatus:
    snapshot: InjectionSnapshot = self._injection.snapshot()
    return self._server_status(
      phase=str(self._phase),
      injection_status=str(snapshot.status),
      message=snapshot.message,
      skin_name=snapshot.skin_name,
      patcher_running=snapshot.patcher_running,
    )

  def _server_status(
    self,
    *,
    phase: str,
    injection_status: str,
    message: str,
    skin_name: str | None = None,
    patcher_running: bool = False,
  ) -> ServerStatus:
    """所有状态消息都带上安装状态、后台版本与能力，避免客户端丢失。"""

    manager = self._manager_installer.snapshot()
    update = self._self_update.snapshot()
    return ServerStatus(
      phase=phase,
      injection_status=injection_status,
      message=message,
      skin_name=skin_name,
      patcher_running=patcher_running,
      ltk_manager_status=manager.status,
      ltk_manager_progress=manager.progress,
      ltk_manager_message=manager.message,
      capabilities=[MANAGER_INSTALL_CAPABILITY] if sys.platform == "win32" else [],
      backend_version=self._self_update.version,
      backend_update_status=update.status,
      backend_update_message=update.message,
      timestamp_ms=int(time.time() * 1000),
    )
