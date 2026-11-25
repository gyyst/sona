"""一次选人换肤的注入状态机：资源 → import → toggle → patcher。"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from ..models.bridge import BridgeResponse, bridge_error_kind, parse_install_value
from ..models.config import BridgeConfig
from ..models.events import SkinSelection
from ..models.lcu import GameflowPhase
from ..services.bridge_client import BridgeCommandError, BridgeUnavailable, LtkBridge
from ..services.launcher import LtkSession, close_ltk_session, ensure_ltk_session
from ..services.lcu_client import LcuClient
from ..services.skin_library import SkinLibrary
from .hints import patcher_failure_message
from .patcher_status import patcher_is_running, wait_for_patcher_ready

log = logging.getLogger(__name__)


class InjectionStatus(StrEnum):
  IDLE = "idle"
  APPLYING = "applying"
  APPLIED = "applied"
  SKIPPED_OWNED = "skipped-owned"
  ERROR = "error"


@dataclass(frozen=True)
class InjectionSnapshot:
  status: InjectionStatus
  message: str
  skin_name: str | None = None
  champion_id: int | None = None
  patcher_running: bool = False
  mod_id: str | None = None


@dataclass(frozen=True)
class ManagedMod:
  mod_id: str
  name: str
  owned_by_us: bool
  original_enabled: bool


class InjectionManager:
  """串行执行注入；只清理本后台导入或明确切换过的 mod。"""

  def __init__(
    self,
    config: BridgeConfig,
    library: SkinLibrary,
    lcu: LcuClient,
    project_root: Path,
  ) -> None:
    self._config = config
    self._library = library
    self._lcu = lcu
    self._log_dir = project_root / "logs" / "ltk"
    self._lock = threading.Lock()
    self._session: LtkSession | None = None
    self._mods: list[ManagedMod] = []
    self._patcher_started = False
    self._snapshot = InjectionSnapshot(InjectionStatus.IDLE, "等待皮肤选择")

  def apply(self, selection: SkinSelection) -> InjectionSnapshot:
    with self._lock:
      return self._apply_locked(selection)

  def cleanup(self) -> InjectionSnapshot:
    with self._lock:
      self._cleanup_locked()
      self._snapshot = InjectionSnapshot(InjectionStatus.IDLE, "本局注入已清理")
      return self._snapshot

  def snapshot(self) -> InjectionSnapshot:
    return self._snapshot

  @property
  def active(self) -> bool:
    return self._patcher_started or bool(self._mods)

  def _apply_locked(self, selection: SkinSelection) -> InjectionSnapshot:
    self._snapshot = InjectionSnapshot(
      InjectionStatus.APPLYING,
      f"正在准备 {selection.skin_name}，如弹出 UAC 请允许",
      selection.skin_name,
      selection.champion_id,
    )
    try:
      self._cleanup_mods_locked()
      if selection.owned:
        self._cleanup_locked()
        self._snapshot = InjectionSnapshot(
          InjectionStatus.SKIPPED_OWNED,
          "该皮肤已拥有，无需注入",
          selection.skin_name,
          selection.champion_id,
        )
        return self._snapshot

      archive = self._library.resolve(selection)
      self._ensure_session_locked()
      # 必须在英雄锁定后强制基础皮肤：未锁定时 LCU 会忽略 my-selection
      self._wait_for_champion_locked(selection.champion_id)
      self._lcu.force_base_skin(selection.champion_id)

      mod_name = f"Sona_{selection.champion_id}_{selection.skin_id}_{uuid.uuid4().hex[:8]}"
      response = self._bridge.import_skin(str(archive.path), mod_name)
      if not response.ok:
        raise BridgeCommandError(response.error_text)

      install = parse_install_value(response)
      mod = install.mod if install else None
      if mod is None:
        mod = next((item for item in self._bridge.list_mods() if item.name == mod_name), None)
      if mod is None:
        raise BridgeCommandError("import 成功但响应中没有 mod 标识")

      managed = ManagedMod(
        mod_id=mod.id,
        name=mod.name,
        owned_by_us=install is not None and install.kind == "installed",
        original_enabled=mod.enabled,
      )
      self._mods.append(managed)
      self._require_ok(self._bridge.toggle(mod.id, True), "toggle")
      self._start_patcher_locked()
      wait_for_patcher_ready(self._bridge, self._config.patcher_ready_timeout_s)

      self._snapshot = InjectionSnapshot(
        InjectionStatus.APPLIED,
        f"游戏内注入已启动：{selection.skin_name}",
        selection.skin_name,
        selection.champion_id,
        patcher_running=True,
        mod_id=mod.id,
      )
      log.info("皮肤注入成功 champion=%s skin=%s mod=%s", selection.champion_id, selection.skin_id, mod.id)
      return self._snapshot
    except Exception as exc:
      log.exception("皮肤注入失败")
      self._cleanup_locked()
      self._snapshot = InjectionSnapshot(
        InjectionStatus.ERROR,
        str(exc),
        selection.skin_name,
        selection.champion_id,
      )
      return self._snapshot

  @property
  def _bridge(self) -> LtkBridge:
    if self._session is None:
      raise BridgeUnavailable("LTK 会话尚未建立")
    return self._session.bridge

  def _ensure_session_locked(self) -> None:
    if self._session is not None:
      if self._session.bridge.ping():
        return
      close_ltk_session(self._session)
    self._session = ensure_ltk_session(self._config, self._log_dir)

  def _wait_for_champion_locked(self, champion_id: int, timeout_s: float = 90.0) -> None:
    """选人阶段等待本地玩家锁定英雄；游戏已开始时直接返回。"""

    try:
      if self._lcu.get_phase() is not GameflowPhase.CHAMP_SELECT:
        return
    except Exception:  # noqa: BLE001 - LCU 不可用时继续尝试注入
      return

    deadline = time.monotonic() + timeout_s
    logged_error = False
    while time.monotonic() < deadline:
      try:
        session = self._lcu.get_champ_select_session()
        if session.local_player_locked():
          return
      except Exception as exc:  # noqa: BLE001 - 选人会话短暂不可读时继续轮询
        if not logged_error:
          log.debug("选人会话暂不可读，继续等待锁定：%s", exc)
          logged_error = True
      time.sleep(0.25)
    log.warning("等待英雄锁定超时，继续尝试注入 champion=%s", champion_id)

  def _start_patcher_locked(self) -> None:
    response = self._bridge.start_patcher()
    if response.ok:
      self._patcher_started = True
      return
    kind = bridge_error_kind(response)
    if kind in {"ALREADY_RUNNING", "BUSY"} and self._patcher_is_running():
      self._patcher_started = True
      return
    raise BridgeCommandError(patcher_failure_message(response))

  def _patcher_is_running(self) -> bool:
    return patcher_is_running(self._bridge)

  def _cleanup_mods_locked(self) -> None:
    if self._session is None:
      return
    if self._patcher_started:
      try:
        self._bridge.stop_patcher()
      except (BridgeUnavailable, BridgeCommandError):
        pass
      self._patcher_started = False

    for mod in reversed(self._mods):
      try:
        if mod.owned_by_us:
          self._bridge.uninstall(mod.mod_id)
        elif not mod.original_enabled:
          self._bridge.toggle(mod.mod_id, False)
      except (BridgeUnavailable, BridgeCommandError):
        log.warning("清理 mod 失败：%s", mod.mod_id)
    self._mods.clear()

  def _cleanup_locked(self) -> None:
    self._cleanup_mods_locked()
    if self._session is not None:
      close_ltk_session(self._session)
      self._session = None

  @staticmethod
  def _require_ok(response: BridgeResponse, action: str) -> None:
    if not response.ok:
      raise BridgeCommandError(f"{action} failed: {response.error_text}")
