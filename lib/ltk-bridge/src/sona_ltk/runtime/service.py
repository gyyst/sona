"""后台服务：LCU phase 监控、注入调度与状态广播。"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

from ..models.config import BridgeConfig
from ..models.events import ServerStatus, SkinSelection
from ..models.lcu import GameflowPhase
from ..runtime.injection import InjectionManager, InjectionSnapshot, InjectionStatus
from ..services.lcu_client import LcuClient, LcuUnavailable
from ..services.manager import ManagerInstaller
from ..services.skin_library import SkinLibrary
from .websocket_server import WebSocketServer

log = logging.getLogger(__name__)

MANAGER_INSTALL_CAPABILITY = "ltk-manager-install"
MANAGER_REFRESH_INTERVAL_S = 10.0
MANAGER_PROGRESS_INTERVAL_S = 0.5


class BridgeService:
  """所有阻塞 I/O 都通过 asyncio.to_thread，避免卡住 WebSocket。"""

  def __init__(self, config: BridgeConfig, project_root: Path) -> None:
    self._config = config
    self._phase = GameflowPhase.NONE
    self._lcu_ready = False
    self._library = SkinLibrary(config, project_root / "data" / "skins")
    self._lcu = LcuClient(config)
    self._injection = InjectionManager(config, self._library, self._lcu, project_root)
    self._manager_installer = ManagerInstaller(config, project_root)
    self._install_task: asyncio.Task[None] | None = None
    self._last_manager_refresh = 0.0
    self._websocket = WebSocketServer(
      config.websocket_port,
      config.auth_token,
      self.handle_selection,
      self.status,
      self.handle_install_manager,
    )

  async def run(self) -> None:
    await self._websocket.start()
    log.info("Sona LTK bridge listening on ws://127.0.0.1:%s", self._config.websocket_port)
    try:
      while True:
        await self._poll_phase()
        await asyncio.sleep(1.0)
    except asyncio.CancelledError:
      await asyncio.to_thread(self._injection.cleanup)
      raise
    finally:
      await self._websocket.stop()

  async def handle_selection(self, selection: SkinSelection) -> None:
    if self._phase not in {
      GameflowPhase.CHAMP_SELECT,
      GameflowPhase.GAME_START,
      GameflowPhase.IN_PROGRESS,
      GameflowPhase.RECONNECT,
    }:
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

    await self._websocket.broadcast(
      self._server_status(
        phase=str(self._phase),
        injection_status=str(InjectionStatus.APPLYING),
        message=f"正在准备 {selection.skin_name}，如弹出 UAC 请允许",
        skin_name=selection.skin_name,
      ),
    )
    await asyncio.to_thread(self._injection.apply, selection)
    await self._websocket.broadcast()

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
    """所有状态消息都带上安装状态与能力，避免客户端收到选人状态后丢失。"""

    manager = self._manager_installer.snapshot()
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
      timestamp_ms=int(time.time() * 1000),
    )
