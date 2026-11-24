"""后台服务对 LTK Manager 状态刷新的广播行为测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.ltk_manager import ManagerInstallStatus
from sona_ltk.runtime.service import BridgeService
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
