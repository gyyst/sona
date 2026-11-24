"""后台服务对 LTK Manager 状态刷新的广播行为测试。"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.models.ltk_manager import ManagerInstallStatus
from sona_ltk.runtime.service import BridgeService
from sona_ltk.services.lcu_client import LcuUnavailable
from sona_ltk.services.manager import installer as installer_module
from sona_ltk.services.manager.installer import ManagerInstallSnapshot


class _FakeInstaller:
  def __init__(self, *snapshots: ManagerInstallSnapshot) -> None:
    self._snapshots = list(snapshots)
    self._index = 0

  def snapshot(self) -> ManagerInstallSnapshot:
    return self._snapshots[min(self._index, len(self._snapshots) - 1)]

  def refresh(self) -> ManagerInstallSnapshot:
    self._index = min(self._index + 1, len(self._snapshots) - 1)
    return self.snapshot()


class _FakeWebSocket:
  def __init__(self) -> None:
    self.calls = 0

  async def broadcast(self) -> None:
    self.calls += 1


def _service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> BridgeService:
  monkeypatch.setattr(installer_module, "find_ltk_manager", lambda: None)
  return BridgeService(BridgeConfig(), tmp_path)


@pytest.mark.asyncio
async def test_refresh_broadcasts_manager_change(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  before = ManagerInstallSnapshot(
    ManagerInstallStatus.NOT_INSTALLED,
    0,
    "未检测到 LTK Manager",
  )
  after = ManagerInstallSnapshot(
    ManagerInstallStatus.INSTALLED,
    100,
    "已安装",
    Path("C:/Program Files/LTK Manager/ltk-manager.exe"),
  )
  service._manager_installer = _FakeInstaller(before, after)
  websocket = _FakeWebSocket()
  service._websocket = websocket
  service._last_manager_refresh = 0.0

  await service._refresh_manager_status()

  assert websocket.calls == 1


@pytest.mark.asyncio
async def test_refresh_skips_broadcast_without_change(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service = _service(tmp_path, monkeypatch)
  snapshot = ManagerInstallSnapshot(
    ManagerInstallStatus.NOT_INSTALLED,
    0,
    "未检测到 LTK Manager",
  )
  service._manager_installer = _FakeInstaller(snapshot, snapshot)
  websocket = _FakeWebSocket()
  service._websocket = websocket
  service._last_manager_refresh = 0.0

  await service._refresh_manager_status()

  assert websocket.calls == 0


class _StubLcu:
  """按顺序返回 phase 或抛出预设异常的 LCU 客户端桩。"""

  def __init__(self, *results: GameflowPhase | BaseException) -> None:
    self._results = list(results)
    self.calls = 0

  def get_phase(self) -> GameflowPhase:
    result = self._results[min(self.calls, len(self._results) - 1)]
    self.calls += 1
    if isinstance(result, BaseException):
      raise result
    return result


def _poll_service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, lcu: _StubLcu) -> BridgeService:
  """替换管理器与 WebSocket 依赖，只保留 phase 轮询逻辑。"""

  service = _service(tmp_path, monkeypatch)
  snapshot = ManagerInstallSnapshot(
    ManagerInstallStatus.NOT_INSTALLED,
    0,
    "未检测到 LTK Manager",
  )
  service._manager_installer = _FakeInstaller(snapshot, snapshot)
  service._websocket = _FakeWebSocket()
  service._lcu = lcu  # type: ignore[assignment]
  return service


@pytest.mark.asyncio
async def test_poll_phase_survives_unexpected_exception(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  stub = _StubLcu(RuntimeError("模拟轮询异常"), GameflowPhase.CHAMP_SELECT)
  service = _poll_service(tmp_path, monkeypatch, stub)

  await service._poll_phase()  # 不得向外抛出
  assert stub.calls == 1
  assert service._phase is GameflowPhase.NONE

  # 后续轮询继续执行并恢复
  await service._poll_phase()
  assert stub.calls == 2
  assert service._phase is GameflowPhase.CHAMP_SELECT


@pytest.mark.asyncio
async def test_poll_phase_does_not_swallow_cancelled_error(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  stub = _StubLcu(asyncio.CancelledError())
  service = _poll_service(tmp_path, monkeypatch, stub)

  # CancelledError 是 BaseException，不能被 except Exception 吞掉
  with pytest.raises(asyncio.CancelledError):
    await service._poll_phase()


@pytest.mark.asyncio
async def test_poll_phase_survives_manager_refresh_exception(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  caplog: pytest.LogCaptureFixture,
) -> None:
  stub = _StubLcu(GameflowPhase.CHAMP_SELECT)
  service = _poll_service(tmp_path, monkeypatch, stub)

  async def _fail() -> None:
    raise RuntimeError("模拟管理器探测异常")

  monkeypatch.setattr(service, "_refresh_manager_status", _fail)
  caplog.set_level(logging.ERROR)

  await service._poll_phase()  # 不得向外抛出

  assert "LTK Manager 状态刷新异常" in caplog.text
  assert stub.calls == 1
  assert service._phase is GameflowPhase.CHAMP_SELECT


@pytest.mark.asyncio
async def test_poll_phase_does_not_swallow_manager_refresh_cancelled_error(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  stub = _StubLcu(GameflowPhase.CHAMP_SELECT)
  service = _poll_service(tmp_path, monkeypatch, stub)

  async def _cancel() -> None:
    raise asyncio.CancelledError()

  monkeypatch.setattr(service, "_refresh_manager_status", _cancel)

  with pytest.raises(asyncio.CancelledError):
    await service._poll_phase()

  assert stub.calls == 0


@pytest.mark.asyncio
async def test_poll_phase_tracks_lcu_ready_state(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  caplog: pytest.LogCaptureFixture,
) -> None:
  stub = _StubLcu(GameflowPhase.NONE, LcuUnavailable("连接失败"), GameflowPhase.CHAMP_SELECT)
  service = _poll_service(tmp_path, monkeypatch, stub)
  caplog.set_level(logging.INFO)

  await service._poll_phase()
  assert service._lcu_ready is True
  assert "LCU 连接已就绪" in caplog.text

  await service._poll_phase()
  assert service._lcu_ready is False
  assert "LCU 连接已断开" in caplog.text

  await service._poll_phase()
  assert service._lcu_ready is True
  assert stub.calls == 3
