"""LTK Manager 安装状态机测试。"""

from __future__ import annotations

import hashlib
import sys
import threading
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.services.manager import installer as module
from sona_ltk.services.manager.download import ManagerDownloadError
from sona_ltk.services.manager.elevated import ElevationCancelled, ElevationError, run_elevated
from sona_ltk.services.manager.installer import ManagerInstaller, ManagerInstallStatus

PAYLOAD = b"installer-bytes" * 1000
SHA = hashlib.sha256(PAYLOAD).hexdigest()
URL = "https://github.com/LeagueToolkit/ltk-manager/releases/download/test.exe"
MANAGER_PATH = Path("C:/Program Files/LTK Manager/ltk-manager.exe")


@pytest.fixture(autouse=True)
def _small_installer(monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr(module, "LTK_MANAGER_SIZE", len(PAYLOAD))
  monkeypatch.setattr(module, "LTK_MANAGER_SHA256", SHA)
  monkeypatch.setattr(module, "LTK_MANAGER_DOWNLOAD_URL", URL)


def _cache_path(tmp_path: Path) -> Path:
  return tmp_path / "downloads" / "LTK.Manager_1.33.0_x64-setup.exe"


def _seed_cache(tmp_path: Path, payload: bytes = PAYLOAD) -> Path:
  path = _cache_path(tmp_path)
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_bytes(payload)
  return path


def _client(payload: bytes = PAYLOAD) -> httpx.Client:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=payload)

  return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_installs_cached_installer_and_verifies(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  calls: list[Path] = []

  def fake_run(executable: Path, parameters: str, timeout_s: float) -> int:
    calls.append(executable)
    assert parameters == "/S"
    return 0

  with (
    patch.object(module, "find_ltk_manager", side_effect=[None, None, MANAGER_PATH]),
    patch.object(module, "run_elevated", side_effect=fake_run),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED
  assert snapshot.manager_path == MANAGER_PATH
  assert calls == [_cache_path(tmp_path)]


def test_skips_install_when_already_installed(tmp_path: Path) -> None:
  with (
    patch.object(module, "find_ltk_manager", return_value=MANAGER_PATH),
    patch.object(module, "run_elevated") as run,
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED
  run.assert_not_called()


def test_configured_manager_path_skips_install(tmp_path: Path) -> None:
  manager = tmp_path / "LTK Manager" / "ltk-manager.exe"
  manager.parent.mkdir()
  manager.write_bytes(b"exe")
  config = BridgeConfig(ltk_manager_path=manager)

  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(module, "run_elevated") as run,
  ):
    installer = ManagerInstaller(config, tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED
  assert snapshot.manager_path == manager
  run.assert_not_called()


def test_configured_size_overrides_builtin(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  config = BridgeConfig(
    ltk_manager_sha256=SHA,
    ltk_manager_size=len(PAYLOAD),
  )

  with (
    patch.object(module, "LTK_MANAGER_SIZE", len(PAYLOAD) + 1),
    patch.object(module, "find_ltk_manager", side_effect=[None, None, MANAGER_PATH]),
    patch.object(module, "run_elevated", return_value=0),
  ):
    installer = ManagerInstaller(config, tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED


def test_downloads_when_cache_hash_is_wrong(tmp_path: Path) -> None:
  _seed_cache(tmp_path, b"corrupted")
  with (
    _client() as client,
    patch.object(module, "find_ltk_manager", side_effect=[None, None, MANAGER_PATH]),
    patch.object(module, "run_elevated", return_value=0),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path, http_client=client)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED
  assert _cache_path(tmp_path).read_bytes() == PAYLOAD


def test_download_failure_becomes_error(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(500)

  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False) as client,
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path, http_client=client)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "下载失败" in snapshot.message
  assert not _cache_path(tmp_path).exists()


def test_hash_failure_never_runs_installer(tmp_path: Path) -> None:
  _seed_cache(tmp_path, b"corrupted")

  def fake_download(url, destination, sha, size, **kwargs):
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(b"x" * len(PAYLOAD))
    return destination

  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(module, "download_installer", side_effect=fake_download),
    patch.object(module, "run_elevated") as run,
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "SHA-256" in snapshot.message
  run.assert_not_called()
  assert not _cache_path(tmp_path).exists()


def test_uac_cancelled_becomes_error(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(
      module,
      "run_elevated",
      side_effect=ElevationCancelled("已取消 UAC 授权，LTK Manager 未安装"),
    ),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "UAC" in snapshot.message


def test_second_verify_failure_blocks_installer(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(
      module,
      "verify_installer",
      side_effect=[None, ManagerDownloadError("安装包 SHA-256 校验失败")],
    ),
    patch.object(module, "run_elevated") as run,
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "SHA-256" in snapshot.message
  run.assert_not_called()
  assert not _cache_path(tmp_path).exists()


def test_installer_exit_code_becomes_error(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(module, "run_elevated", return_value=5),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "退出码 5" in snapshot.message


def test_reboot_required_is_reported(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  with (
    patch.object(module, "find_ltk_manager", side_effect=[None, None, MANAGER_PATH]),
    patch.object(module, "run_elevated", return_value=3010),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.INSTALLED
  assert "重启" in snapshot.message


def test_installer_not_found_after_install(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(module, "run_elevated", return_value=0),
    patch.object(module, "INSTALL_CHECK_TIMEOUT_S", 0.01),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    snapshot = installer.install()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert "未找到 ltk-manager.exe" in snapshot.message


def test_refresh_keeps_error_state(tmp_path: Path) -> None:
  with patch.object(module, "find_ltk_manager", return_value=None):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    installer._set(ManagerInstallStatus.ERROR, 0, "boom")
    snapshot = installer.refresh()

  assert snapshot.status == ManagerInstallStatus.ERROR
  assert snapshot.message == "boom"


def test_concurrent_install_runs_once(tmp_path: Path) -> None:
  _seed_cache(tmp_path)
  started = threading.Event()
  release = threading.Event()
  calls: list[int] = []

  def fake_install_locked() -> None:
    calls.append(1)
    started.set()
    release.wait(1)

  with (
    patch.object(module, "find_ltk_manager", return_value=None),
    patch.object(ManagerInstaller, "_install_locked", side_effect=fake_install_locked),
  ):
    installer = ManagerInstaller(BridgeConfig(), tmp_path)
    first = threading.Thread(target=installer.install)
    second = threading.Thread(target=installer.install)
    first.start()
    assert started.wait(1)
    second.start()
    second.join(1)
    release.set()
    first.join(1)

  assert calls == [1]


def test_run_elevated_requires_windows() -> None:
  if sys.platform == "win32":
    pytest.skip("Windows 上会真正调用 ShellExecuteEx")
  with pytest.raises(ElevationError, match="Windows"):
    run_elevated(Path("setup.exe"), "/S", 1)
