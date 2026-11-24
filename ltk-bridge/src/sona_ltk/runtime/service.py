"""后台服务：LCU phase 监控、注入调度与状态广播。"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from ..models.config import BridgeConfig
from ..models.events import ServerStatus, SkinSelection
from ..models.lcu import GameflowPhase
from ..runtime.injection import InjectionManager, InjectionSnapshot, InjectionStatus
from ..services.lcu_client import LcuClient, LcuUnavailable
from ..services.skin_library import SkinLibrary
from .websocket_server import WebSocketServer

log = logging.getLogger(__name__)


class BridgeService:
  """所有阻塞 I/O 都通过 asyncio.to_thread，避免卡住 WebSocket。"""

  def __init__(self, config: BridgeConfig, project_root: Path) -> None:
    self._config = config
    self._phase = GameflowPhase.NONE
    self._library = SkinLibrary(config, project_root / "data" / "skins")
    self._lcu = LcuClient(config)
    self._injection = InjectionManager(config, self._library, self._lcu, project_root)
    self._websocket = WebSocketServer(
      config.websocket_port,
      config.auth_token,
      self.handle_selection,
      self.status,
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
        ServerStatus(
          phase=str(self._phase),
          injection_status=InjectionStatus.IDLE,
          message="当前不在英雄选择或游戏阶段，已忽略本次选择",
          skin_name=selection.skin_name,
          timestamp_ms=int(time.time() * 1000),
        ),
      )
      return

    await self._websocket.broadcast(
      ServerStatus(
        phase=str(self._phase),
        injection_status=InjectionStatus.APPLYING,
        message=f"正在准备 {selection.skin_name}",
        skin_name=selection.skin_name,
        timestamp_ms=int(time.time() * 1000),
      ),
    )
    await asyncio.to_thread(self._injection.apply, selection)
    await self._websocket.broadcast()

  async def _poll_phase(self) -> None:
    try:
      phase = await asyncio.to_thread(self._lcu.get_phase)
    except LcuUnavailable:
      return

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

  def status(self) -> ServerStatus:
    snapshot: InjectionSnapshot = self._injection.snapshot()
    return ServerStatus(
      phase=str(self._phase),
      injection_status=str(snapshot.status),
      message=snapshot.message,
      skin_name=snapshot.skin_name,
      patcher_running=snapshot.patcher_running,
      timestamp_ms=int(time.time() * 1000),
    )
