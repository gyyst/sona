"""后台服务对 LTK Manager 状态刷新的广播行为测试。"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import ServerStatus, SkinSelection
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.models.ltk_manager import ManagerInstallStatus
from sona_ltk.runtime.injection import InjectionSnapshot, InjectionStatus
from sona_ltk.runtime.service import DUPLICATE_SELECTION_WINDOW_S, BridgeService
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
    self.statuses: list[ServerStatus] = []

  async def broadcast(self, status: ServerStatus | None = None) -> None:
    self.calls += 1
    if status is not None:
      self.statuses.append(status)


class _FakeInjection:
  """记录 apply 调用并统计并发度；apply 在 to_thread 中执行。"""

  def __init__(self) -> None:
    self.processed: list[SkinSelection] = []
    self.max_active = 0
    self._active = 0
    self._snapshot = InjectionSnapshot(InjectionStatus.IDLE, "等待皮肤选择")

  def apply(self, selection: SkinSelection) -> InjectionSnapshot:
    self._active += 1
    self.max_active = max(self.max_active, self._active)
    try:
      time.sleep(0.02)
      self.processed.append(selection)
      self._snapshot = InjectionSnapshot(InjectionStatus.APPLIED, "已应用", selection.skin_name)
      return self._snapshot
    finally:
      self._active -= 1

  def snapshot(self) -> InjectionSnapshot:
    return self._snapshot


def _selection(skin_id: int = 99007) -> SkinSelection:
  return SkinSelection(
    champion_id=99,
    skin_id=skin_id,
    base_skin_id=99007,
    chroma_id=None,
    form_id=None,
    skin_name="Elementalist Lux",
    owned=False,
    source="manual",
    timestamp_ms=1,
  )


def _selection_service(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> tuple[BridgeService, _FakeInjection]:
  service = _service(tmp_path, monkeypatch)
  service._websocket = _FakeWebSocket()
  service._phase = GameflowPhase.CHAMP_SELECT
  injection = _FakeInjection()
  service._injection = injection  # type: ignore[assignment]
  return service, injection


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


@pytest.mark.asyncio
async def test_duplicate_selection_within_window_is_processed_once(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service, injection = _selection_service(tmp_path, monkeypatch)

  await service.handle_selection(_selection())
  await service.handle_selection(_selection())

  assert len(injection.processed) == 1


@pytest.mark.asyncio
async def test_duplicate_selection_retry_is_allowed_after_window(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service, injection = _selection_service(tmp_path, monkeypatch)

  await service.handle_selection(_selection())
  service._last_selection_at -= DUPLICATE_SELECTION_WINDOW_S + 1
  await service.handle_selection(_selection())

  assert len(injection.processed) == 2


@pytest.mark.asyncio
async def test_different_skin_is_not_treated_as_duplicate(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service, injection = _selection_service(tmp_path, monkeypatch)

  await service.handle_selection(_selection(99007))
  await service.handle_selection(_selection(99008))

  assert [selection.skin_id for selection in injection.processed] == [99007, 99008]


@pytest.mark.asyncio
async def test_queued_duplicate_selection_is_dropped_after_apply(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  """排队期间 duplicate 检查未命中（快照仍为 idle），拿到锁后应再次判定并丢弃。"""

  service, injection = _selection_service(tmp_path, monkeypatch)

  await asyncio.gather(
    service.handle_selection(_selection()),
    service.handle_selection(_selection()),
  )

  assert len(injection.processed) == 1
  assert injection.max_active == 1


@pytest.mark.asyncio
async def test_concurrent_selections_are_serialized(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service, injection = _selection_service(tmp_path, monkeypatch)

  await asyncio.gather(
    service.handle_selection(_selection(99007)),
    service.handle_selection(_selection(99008)),
  )

  assert injection.max_active == 1
  assert len(injection.processed) == 2


@pytest.mark.asyncio
async def test_selection_outside_injectable_phase_is_rejected(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  service, injection = _selection_service(tmp_path, monkeypatch)
  service._phase = GameflowPhase.LOBBY

  await service.handle_selection(_selection())

  assert injection.processed == []
  assert "已忽略本次选择" in service._websocket.statuses[-1].message
