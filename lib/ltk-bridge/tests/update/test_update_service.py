"""后台更新协议字段与空闲重启门控测试。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from sona_ltk import build_version
from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import BackendUpdateStatus, ServerStatus
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.runtime.service import SAFE_RESTART_PHASES, BridgeService
from sona_ltk.services.manager import installer as installer_module


class _Injection:
  def __init__(self, active: bool) -> None:
    self._active = active

  @property
  def active(self) -> bool:
    return self._active


def _service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> BridgeService:
  monkeypatch.setattr(installer_module, "find_ltk_manager", lambda: None)
  return BridgeService(BridgeConfig(), tmp_path)


def test_server_status_includes_backend_fields() -> None:
  status = ServerStatus(
    phase="Lobby",
    injection_status="idle",
    message="ok",
    backend_version="deadbeef",
    backend_update_status=BackendUpdateStatus.READY,
    backend_update_message="已下载",
    timestamp_ms=1,
  )

  payload = status.model_dump_json(by_alias=True)

  assert '"backendVersion":"deadbeef"' in payload
  assert '"backendUpdateStatus":"ready"' in payload
  assert '"backendUpdateMessage":"已下载"' in payload


def test_server_status_backend_fields_default_for_old_backends() -> None:
  status = ServerStatus(phase="", injection_status="idle", message="", timestamp_ms=1)
  assert status.backend_version == ""
  assert status.backend_update_status is BackendUpdateStatus.IDLE
  assert status.backend_update_message == ""
  assert status.model_dump(by_alias=True)["backendVersion"] == ""


@pytest.mark.parametrize("phase", sorted(SAFE_RESTART_PHASES, key=str))
def test_restart_allowed_in_safe_phases(
  phase: GameflowPhase,
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  service._phase = phase
  service._injection = _Injection(active=False)  # type: ignore[assignment]

  assert service._can_restart_backend() is True


@pytest.mark.parametrize(
  "phase",
  [
    GameflowPhase.CHAMP_SELECT,
    GameflowPhase.MATCHMAKING,
    GameflowPhase.READY_CHECK,
    GameflowPhase.GAME_START,
    GameflowPhase.IN_PROGRESS,
    GameflowPhase.RECONNECT,
  ],
)
def test_restart_blocked_during_game_phases(
  phase: GameflowPhase,
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  service._phase = phase
  service._injection = _Injection(active=False)  # type: ignore[assignment]

  assert service._can_restart_backend() is False


def test_restart_blocked_while_injection_active(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  service._phase = GameflowPhase.LOBBY
  service._injection = _Injection(active=True)  # type: ignore[assignment]

  assert service._can_restart_backend() is False


@pytest.mark.asyncio
async def test_restart_blocked_while_manager_install_runs(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  service._phase = GameflowPhase.LOBBY
  service._injection = _Injection(active=False)  # type: ignore[assignment]
  task = asyncio.create_task(asyncio.sleep(60))
  service._install_task = task
  try:
    assert service._can_restart_backend() is False
  finally:
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
  assert service._can_restart_backend() is True


@pytest.mark.asyncio
async def test_restart_blocked_while_a_selection_is_being_applied(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  service._phase = GameflowPhase.LOBBY
  # 注入 active 尚未翻转时，选择锁也必须阻止重启
  service._injection = _Injection(active=False)  # type: ignore[assignment]

  async with service._selection_lock:
    assert service._can_restart_backend() is False

  assert service._can_restart_backend() is True


def test_status_reports_backend_version_and_supported_state(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)

  status = service.status()

  assert status.backend_version == build_version
  # 测试在 Linux 上运行，自更新应明确标记为不支持而不是静默空闲
  assert status.backend_update_status is BackendUpdateStatus.UNSUPPORTED
  assert status.backend_update_message
