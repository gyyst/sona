"""注入状态机测试（假 bridge / LCU / 资源库）。"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from sona_ltk.models.bridge import BridgeError, BridgeInner, BridgeResponse
from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import SkinSelection
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.runtime import champion_select as champion_select_module
from sona_ltk.runtime import injection as injection_module
from sona_ltk.runtime.hints import CDP_UNAVAILABLE_HINT, STAGING_REFUSED_HINT
from sona_ltk.runtime.injection import InjectionManager, InjectionStatus
from sona_ltk.services.launcher import LtkSession
from sona_ltk.services.lcu_client import LcuUnavailable
from sona_ltk.services.skin_library import SkinArchive


class FakeBridge:
  def __init__(
    self,
    start_ok: bool = True,
    start_error: BridgeError | None = None,
    phases: list[dict[str, object]] | None = None,
  ) -> None:
    self.calls: list[tuple[object, ...]] = []
    self.start_ok = start_ok
    self.start_error = start_error
    self.phases = list(phases) if phases is not None else [{"running": True, "phase": "patching"}]
    self.status_polls = 0
    self.on_status: Callable[[], None] | None = None

  def ping(self) -> bool:
    return True

  def import_skin(self, path: str, name: str) -> BridgeResponse:
    self.calls.append(("import", path, name))
    return BridgeResponse(
      ok=True,
      response=BridgeInner(
        value={"kind": "installed", "mod": {"id": "m1", "name": name, "enabled": False}},
      ),
    )

  def list_mods(self) -> list[object]:
    return []

  def toggle(self, mod_id: str, enabled: bool) -> BridgeResponse:
    self.calls.append(("toggle", mod_id, enabled))
    return BridgeResponse(ok=True)

  def uninstall(self, mod_id: str) -> BridgeResponse:
    self.calls.append(("uninstall", mod_id))
    return BridgeResponse(ok=True)

  def start_patcher(self) -> BridgeResponse:
    self.calls.append(("start",))
    if self.start_ok:
      return BridgeResponse(ok=True)
    error = self.start_error or BridgeError(code="PATCHER", kind="DLL_UNAVAILABLE")
    return BridgeResponse(ok=False, response=BridgeInner(ok=False, error=error))

  def stop_patcher(self) -> BridgeResponse:
    self.calls.append(("stop",))
    return BridgeResponse(ok=True)

  def patcher_status(self) -> BridgeResponse:
    self.status_polls += 1
    if self.on_status is not None:
      self.on_status()
    index = min(self.status_polls - 1, len(self.phases) - 1)
    return BridgeResponse(ok=True, response=BridgeInner(value=self.phases[index]))


class _FakeChampSelectSession:
  def __init__(self, locked: bool) -> None:
    self._locked = locked

  def local_player_locked(self) -> bool:
    return self._locked


class FakeLcu:
  """按顺序返回预设 phase；默认停在 ChampSelect 且本地玩家已锁定。"""

  def __init__(
    self,
    phases: list[GameflowPhase] | None = None,
    locked: bool = True,
  ) -> None:
    self.phases = list(phases) if phases is not None else [GameflowPhase.CHAMP_SELECT]
    self.locked = locked
    self.forced: list[int] = []
    self.phase_calls = 0

  def get_phase(self) -> GameflowPhase:
    phase = self.phases[min(self.phase_calls, len(self.phases) - 1)]
    self.phase_calls += 1
    return phase

  def get_champ_select_session(self) -> _FakeChampSelectSession:
    return _FakeChampSelectSession(self.locked)

  def force_base_skin(self, champion_id: int) -> None:
    self.forced.append(champion_id)


class FakeLibrary:
  def resolve(self, selection: SkinSelection) -> SkinArchive:
    return SkinArchive(
      path=Path("/tmp/fake.zip"),
      champion_id=selection.champion_id,
      skin_id=selection.chroma_id or selection.skin_id,
      chroma_id=selection.chroma_id,
      sha256="0" * 64,
    )


def _selection(owned: bool = False, chroma_id: int | None = None) -> SkinSelection:
  return SkinSelection(
    champion_id=99,
    skin_id=99007,
    base_skin_id=99007,
    chroma_id=chroma_id,
    skin_name="Elementalist Lux",
    owned=owned,
    source="manual",
    timestamp_ms=1,
  )


def _build_manager(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
  bridge: FakeBridge,
  config: BridgeConfig | None = None,
  lcu: FakeLcu | None = None,
) -> InjectionManager:
  session = LtkSession(bridge=bridge, launched_by_us=False, manager_pid=1)
  monkeypatch.setattr(injection_module, "ensure_ltk_session", lambda cfg, log_dir: session)
  monkeypatch.setattr(injection_module, "close_ltk_session", lambda current: None)
  return InjectionManager(config or BridgeConfig(), FakeLibrary(), lcu or FakeLcu(), tmp_path)


@pytest.fixture
def manager(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]]:
  bridge = FakeBridge()
  lcu = FakeLcu()
  session = LtkSession(bridge=bridge, launched_by_us=False, manager_pid=1)
  closed: list[LtkSession] = []
  monkeypatch.setattr(injection_module, "ensure_ltk_session", lambda config, log_dir: session)
  monkeypatch.setattr(injection_module, "close_ltk_session", lambda current: closed.append(current))
  instance = InjectionManager(BridgeConfig(), FakeLibrary(), lcu, tmp_path)
  return instance, bridge, lcu, closed


def test_owned_skin_skips_injection(manager: tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]]) -> None:
  instance, bridge, lcu, _ = manager
  snapshot = instance.apply(_selection(owned=True))
  assert snapshot.status is InjectionStatus.SKIPPED_OWNED
  assert bridge.calls == []
  assert lcu.forced == []


def test_unowned_skin_is_applied(manager: tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]]) -> None:
  instance, bridge, lcu, _ = manager
  snapshot = instance.apply(_selection())
  assert snapshot.status is InjectionStatus.APPLIED
  assert snapshot.patcher_running is True
  assert lcu.forced == [99]
  assert ("import", str(Path("/tmp/fake.zip")), bridge.calls[0][2]) in bridge.calls
  assert ("toggle", "m1", True) in bridge.calls
  assert ("start",) in bridge.calls
  assert bridge.status_polls == 1


def test_patcher_stays_applying_while_building(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge(
    phases=[
      {"running": True, "phase": "building"},
      {"running": True, "phase": "building"},
      {"running": True, "phase": "patching"},
    ],
  )
  instance = _build_manager(monkeypatch, tmp_path, bridge)
  monkeypatch.setattr(champion_select_module.time, "sleep", lambda _seconds: None)
  observed: list[InjectionStatus] = []
  bridge.on_status = lambda: observed.append(instance.snapshot().status)

  snapshot = instance.apply(_selection())

  assert bridge.status_polls == 3
  assert set(observed) == {InjectionStatus.APPLYING}
  assert snapshot.status is InjectionStatus.APPLIED


def test_patcher_without_phase_keeps_the_previous_behaviour(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge(phases=[{"running": True}])
  instance = _build_manager(monkeypatch, tmp_path, bridge)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert bridge.status_polls == 1


def test_a_staging_refusal_reaches_the_client_as_its_own_hint(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge(
    phases=[
      {
        "running": False,
        "phase": "idle",
        "error": {"kind": "STAGING_REFUSED", "message": "cannot stage under Program Files"},
      },
    ],
  )
  instance = _build_manager(monkeypatch, tmp_path, bridge)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.ERROR
  assert snapshot.message == STAGING_REFUSED_HINT


def test_a_string_import_error_reaches_the_client_as_its_own_hint(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  class _CdpUnavailableBridge(FakeBridge):
    def import_skin(self, path: str, name: str) -> BridgeResponse:
      return BridgeResponse.model_validate(
        {"ok": False, "response": {"ok": False, "error": "CDP unavailable or timed out"}},
      )

  instance = _build_manager(monkeypatch, tmp_path, _CdpUnavailableBridge())

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.ERROR
  assert snapshot.message == CDP_UNAVAILABLE_HINT


def test_chroma_uses_chroma_id(
  manager: tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]],
) -> None:
  instance, _, _, _ = manager
  snapshot = instance.apply(_selection(chroma_id=99991))
  assert snapshot.status is InjectionStatus.APPLIED


def test_locked_champ_select_forces_base_skin_once(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge()
  lcu = FakeLcu()
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert lcu.forced == [99]
  assert lcu.phase_calls == 2


def test_leaving_champ_select_stops_waiting_without_my_selection(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  """AC-1/AC-2：phase 变成 InProgress 后下一轮立即停止，且不再改写基础皮肤。"""

  bridge = FakeBridge()
  lcu = FakeLcu(phases=[GameflowPhase.CHAMP_SELECT, GameflowPhase.IN_PROGRESS], locked=False)
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)
  monkeypatch.setattr(champion_select_module.time, "sleep", lambda _seconds: None)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert lcu.forced == []
  # 第一轮 ChampSelect，第二轮 InProgress 即停止，随后确认阶段；不会继续轮询
  assert lcu.phase_calls == 3
  assert any(call[0] == "import" for call in bridge.calls)
  assert ("start",) in bridge.calls


@pytest.mark.parametrize(
  "phase",
  [GameflowPhase.GAME_START, GameflowPhase.IN_PROGRESS, GameflowPhase.RECONNECT],
)
def test_late_selection_skips_rebase_and_keeps_injecting(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
  phase: GameflowPhase,
) -> None:
  bridge = FakeBridge()
  lcu = FakeLcu(phases=[phase])
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert lcu.forced == []
  assert any(call[0] == "import" for call in bridge.calls)
  assert ("start",) in bridge.calls


@pytest.mark.parametrize(
  "phase",
  [GameflowPhase.LOBBY, GameflowPhase.NONE, GameflowPhase.POST_GAME],
)
def test_ended_phase_cancels_injection(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
  phase: GameflowPhase,
) -> None:
  bridge = FakeBridge()
  lcu = FakeLcu(phases=[phase])
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.ERROR
  assert "已取消本次注入" in snapshot.message
  assert phase.value in snapshot.message
  assert bridge.calls == []
  assert lcu.forced == []


def test_lock_timeout_skips_base_skin_and_keeps_injecting(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge()
  lcu = FakeLcu(locked=False)
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)
  monkeypatch.setattr(champion_select_module, "CHAMPION_LOCK_TIMEOUT_S", 0.0)
  monkeypatch.setattr(champion_select_module.time, "sleep", lambda _seconds: None)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert lcu.forced == []
  assert ("start",) in bridge.calls


class _PhaseRaceLcu(FakeLcu):
  """检查与 PATCH 之间 phase 已切走：PATCH 返回 404，但注入应继续。"""

  def force_base_skin(self, champion_id: int) -> None:
    super().force_base_skin(champion_id)
    self.phases = [GameflowPhase.IN_PROGRESS]
    raise LcuUnavailable("LCU 请求失败：HTTP 404", status_code=404)


def test_phase_race_during_my_selection_is_not_fatal(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge()
  lcu = _PhaseRaceLcu()
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)

  snapshot = instance.apply(_selection())

  assert lcu.forced == [99]  # 只发出一次 PATCH，失败后不重试
  assert snapshot.status is InjectionStatus.APPLIED
  assert ("start",) in bridge.calls


@pytest.mark.parametrize(
  ("status_code", "message"),
  [(None, "LCU 连接失败，客户端可能正在启动或重启"), (500, "LCU 请求失败：HTTP 500")],
)
def test_non_404_lcu_failure_is_not_swallowed(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
  status_code: int | None,
  message: str,
) -> None:
  """只有阶段竞态导致的 404 可以降级；连接错误与 5xx 必须暴露为注入失败。"""

  class _FailingLcu(FakeLcu):
    def force_base_skin(self, champion_id: int) -> None:
      self.phases = [GameflowPhase.IN_PROGRESS]
      raise LcuUnavailable(message, status_code=status_code)

  bridge = FakeBridge()
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=_FailingLcu())

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.ERROR
  assert message in snapshot.message
  assert bridge.calls == []


class _UnreadableLcu(FakeLcu):
  def get_phase(self) -> GameflowPhase:
    raise LcuUnavailable("LCU 连接失败，客户端可能正在启动或重启")


def test_unreadable_lcu_skips_rebase_and_keeps_injecting(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  """LCU 阶段不可读时保持原行为：跳过等待与基础皮肤改写，继续尝试注入。"""

  bridge = FakeBridge()
  lcu = _UnreadableLcu()
  instance = _build_manager(monkeypatch, tmp_path, bridge, lcu=lcu)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.APPLIED
  assert lcu.forced == []
  assert ("start",) in bridge.calls


def test_patcher_failure_cleans_up(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge(start_ok=False)
  instance = _build_manager(monkeypatch, tmp_path, bridge)

  snapshot = instance.apply(_selection())

  assert snapshot.status is InjectionStatus.ERROR
  assert ("uninstall", "m1") in bridge.calls


def test_cleanup_stops_patcher_and_uninstalls(
  manager: tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]],
) -> None:
  instance, bridge, _, closed = manager
  instance.apply(_selection())
  snapshot = instance.cleanup()
  assert snapshot.status is InjectionStatus.IDLE
  assert ("stop",) in bridge.calls
  assert ("uninstall", "m1") in bridge.calls
  assert len(closed) == 1
