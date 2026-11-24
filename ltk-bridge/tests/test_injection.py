"""注入状态机测试（假 bridge / LCU / 资源库）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sona_ltk.models.bridge import BridgeError, BridgeInner, BridgeResponse
from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import SkinSelection
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.runtime import injection as injection_module
from sona_ltk.runtime.injection import InjectionManager, InjectionStatus
from sona_ltk.services.launcher import LtkSession
from sona_ltk.services.skin_library import SkinArchive


class FakeBridge:
  def __init__(self, start_ok: bool = True) -> None:
    self.calls: list[tuple[object, ...]] = []
    self.start_ok = start_ok

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
    if not self.start_ok:
      return BridgeResponse(ok=False, error=BridgeError(code="PATCHER", kind="DLL_UNAVAILABLE"))
    return BridgeResponse(ok=True)

  def stop_patcher(self) -> BridgeResponse:
    self.calls.append(("stop",))
    return BridgeResponse(ok=True)

  def patcher_status(self) -> BridgeResponse:
    return BridgeResponse(ok=True, response=BridgeInner(value={"running": True}))


class FakeLcu:
  def __init__(self) -> None:
    self.forced: list[int] = []

  def get_phase(self) -> GameflowPhase:
    return GameflowPhase.GAME_START

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
  assert ("import", "/tmp/fake.zip", bridge.calls[0][2]) in bridge.calls
  assert ("toggle", "m1", True) in bridge.calls
  assert ("start",) in bridge.calls


def test_chroma_uses_chroma_id(
  manager: tuple[InjectionManager, FakeBridge, FakeLcu, list[LtkSession]],
) -> None:
  instance, _, _, _ = manager
  snapshot = instance.apply(_selection(chroma_id=99991))
  assert snapshot.status is InjectionStatus.APPLIED


def test_patcher_failure_cleans_up(
  monkeypatch: pytest.MonkeyPatch,
  tmp_path: Path,
) -> None:
  bridge = FakeBridge(start_ok=False)
  session = LtkSession(bridge=bridge, launched_by_us=False, manager_pid=1)
  monkeypatch.setattr(injection_module, "ensure_ltk_session", lambda config, log_dir: session)
  monkeypatch.setattr(injection_module, "close_ltk_session", lambda current: None)
  instance = InjectionManager(BridgeConfig(), FakeLibrary(), FakeLcu(), tmp_path)

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
