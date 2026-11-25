"""SelfUpdater 状态机：本地比较、下载解压、错误保留与空闲重启测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import BackendUpdateStatus
from sona_ltk.runtime import self_update as self_update_module
from sona_ltk.runtime.self_update import SelfUpdater, _detect_supported
from sona_ltk.services.update.download import UpdateDownloadError
from sona_ltk.services.update.manifest import BackendUpdateManifest
from sona_ltk.services.update.script import STAGING_DIR


class _Callbacks:
  def __init__(self) -> None:
    self.stop_calls = 0
    self.safe = True
    self.safe_checks = 0

  def request_stop(self) -> None:
    self.stop_calls += 1

  def is_safe(self) -> bool:
    self.safe_checks += 1
    return self.safe


def _updater(
  root: Path,
  callbacks: _Callbacks,
  *,
  supported: bool = True,
  idle_poll_s: float = 0,
) -> SelfUpdater:
  return SelfUpdater(
    BridgeConfig(),
    root,
    request_stop=callbacks.request_stop,
    is_safe_to_restart=callbacks.is_safe,
    build_version="deadbeef",
    supported=supported,
    initial_delay_s=0,
    idle_poll_s=idle_poll_s,
  )


def _write_files(root: Path, files: dict[str, bytes]) -> None:
  for name, content in files.items():
    path = root / Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _patch_manifest(monkeypatch: pytest.MonkeyPatch, manifest: BackendUpdateManifest) -> None:
  monkeypatch.setattr(
    self_update_module.download,
    "fetch_manifest",
    lambda **kwargs: manifest,
  )


@pytest.mark.asyncio
async def test_unsupported_never_checks_network(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks, supported=False)

  def _fail(**kwargs):
    raise AssertionError("unsupported 不应请求网络")

  monkeypatch.setattr(self_update_module.download, "fetch_manifest", _fail)

  snapshot = await updater.check_once()

  assert snapshot.status is BackendUpdateStatus.UNSUPPORTED
  assert snapshot.message
  assert callbacks.stop_calls == 0


def test_support_detection_requires_windows_frozen_and_version(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr(self_update_module.sys, "platform", "win32")
  monkeypatch.setattr(self_update_module.sys, "frozen", True, raising=False)
  assert _detect_supported("deadbeef") is True
  assert _detect_supported("dev") is False
  assert _detect_supported("") is False

  monkeypatch.setattr(self_update_module.sys, "frozen", False, raising=False)
  assert _detect_supported("deadbeef") is False

  monkeypatch.setattr(self_update_module.sys, "platform", "linux")
  assert _detect_supported("deadbeef") is False


def test_skip_env_disables_self_update(monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr(self_update_module.sys, "platform", "win32")
  monkeypatch.setattr(self_update_module.sys, "frozen", True, raising=False)
  monkeypatch.setenv(self_update_module.SKIP_ENV_NAME, "1")

  assert _detect_supported("deadbeef") is False


@pytest.mark.asyncio
async def test_local_match_sets_idle_and_cleans_staging(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  files = {"sona-ltk.exe": b"exe", "manager/manifest.json": b"{}"}
  _write_files(tmp_path, files)
  staging = tmp_path / STAGING_DIR
  staging.mkdir()
  (staging / "stale.bin").write_bytes(b"stale")
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks)

  snapshot = await updater.check_once()

  assert snapshot.status is BackendUpdateStatus.IDLE
  assert updater.plan is None
  assert not staging.exists()
  assert callbacks.stop_calls == 0


@pytest.mark.asyncio
async def test_ready_staging_is_reused_without_download(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  files = {"sona-ltk.exe": b"exe", "ltk_launcher.exe": b"launcher"}
  _write_files(tmp_path / STAGING_DIR, files)
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)

  def _fail_download(*args, **kwargs):
    raise AssertionError("暂存已就绪时不应重新下载")

  monkeypatch.setattr(self_update_module.download, "download_archive", _fail_download)
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks)

  snapshot = await updater.check_once()

  assert snapshot.status is BackendUpdateStatus.READY
  assert updater.plan is not None
  assert updater.plan.files == ("ltk_launcher.exe", "sona-ltk.exe")
  assert updater.plan.staged == tmp_path / STAGING_DIR


@pytest.mark.asyncio
async def test_download_and_extract_sets_ready(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  files = {"sona-ltk.exe": b"exe", "ltk_launcher.exe": b"launcher"}
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)
  downloaded: list[Path] = []

  def fake_download(current, destination, **kwargs):
    downloaded.append(destination)
    destination.write_bytes(b"zip")
    return destination

  def fake_extract(archive_path, current, staging):
    assert archive_path == downloaded[0]
    _write_files(staging, files)

  monkeypatch.setattr(self_update_module.download, "download_archive", fake_download)
  monkeypatch.setattr(self_update_module.archive, "extract_runtime", fake_extract)
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks)

  snapshot = await updater.check_once()

  assert snapshot.status is BackendUpdateStatus.READY
  assert downloaded == [tmp_path / "sona-update.zip"]
  assert updater.plan is not None


@pytest.mark.asyncio
async def test_download_failure_reports_error_and_keeps_old_runtime(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  original = tmp_path / "sona-ltk.exe"
  original.write_bytes(b"old-exe")
  manifest = make_manifest({"sona-ltk.exe": b"new-exe"})
  _patch_manifest(monkeypatch, manifest)

  def fail_download(*args, **kwargs):
    raise UpdateDownloadError("boom")

  monkeypatch.setattr(self_update_module.download, "download_archive", fail_download)
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks)

  snapshot = await updater.check_once()

  assert snapshot.status is BackendUpdateStatus.ERROR
  assert "boom" in snapshot.message
  assert updater.plan is None
  assert original.read_bytes() == b"old-exe"


@pytest.mark.asyncio
async def test_restart_waits_until_idle(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  files = {"sona-ltk.exe": b"exe"}
  _write_files(tmp_path / STAGING_DIR, files)
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)
  callbacks = _Callbacks()
  callbacks.safe = False

  original_is_safe = callbacks.is_safe

  def is_safe_after_two() -> bool:
    allowed = original_is_safe()
    if callbacks.safe_checks >= 2:
      callbacks.safe = True
    return allowed

  callbacks.is_safe = is_safe_after_two
  updater = _updater(tmp_path, callbacks)

  await updater._prepare_and_maybe_restart()

  assert callbacks.safe_checks >= 2
  assert callbacks.stop_calls == 1
  assert updater.snapshot().status is BackendUpdateStatus.RESTARTING


@pytest.mark.asyncio
async def test_restart_triggers_when_already_idle(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  files = {"sona-ltk.exe": b"exe"}
  _write_files(tmp_path / STAGING_DIR, files)
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)
  callbacks = _Callbacks()
  updater = _updater(tmp_path, callbacks)

  await updater._prepare_and_maybe_restart()

  assert callbacks.stop_calls == 1
  assert updater.plan is not None
  assert updater.snapshot().status is BackendUpdateStatus.RESTARTING


@pytest.mark.asyncio
async def test_plan_preserves_launch_arguments(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  """替换脚本重启后台时必须沿用插件传入的 --port/--token。"""

  files = {"sona-ltk.exe": b"exe"}
  _write_files(tmp_path / STAGING_DIR, files)
  manifest = make_manifest(files)
  _patch_manifest(monkeypatch, manifest)
  monkeypatch.setattr(
    self_update_module.sys,
    "argv",
    ["sona-ltk.exe", "--port", "50100", "--token", "abc"],
  )
  updater = _updater(tmp_path, _Callbacks())

  await updater.check_once()

  assert updater.plan is not None
  assert updater.plan.args == ("--port", "50100", "--token", "abc")


@pytest.mark.asyncio
async def test_each_check_refreshes_manifest(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
  make_manifest,
) -> None:
  """长期运行的后台必须每轮重新读取清单，否则永远发现不了新版本。"""

  _write_files(tmp_path, {"sona-ltk.exe": b"old-exe"})
  manifests = [
    make_manifest({"sona-ltk.exe": b"old-exe"}),
    make_manifest({"sona-ltk.exe": b"new-exe"}),
  ]
  calls = {"count": 0}

  def fetch_manifest(**kwargs):
    index = min(calls["count"], len(manifests) - 1)
    calls["count"] += 1
    return manifests[index]

  def fake_download(current, destination, **kwargs):
    destination.write_bytes(b"zip")
    return destination

  def fake_extract(archive_path, current, staging):
    _write_files(staging, {"sona-ltk.exe": b"new-exe"})

  monkeypatch.setattr(self_update_module.download, "fetch_manifest", fetch_manifest)
  monkeypatch.setattr(self_update_module.download, "download_archive", fake_download)
  monkeypatch.setattr(self_update_module.archive, "extract_runtime", fake_extract)
  updater = _updater(tmp_path, _Callbacks())

  first = await updater.check_once()
  second = await updater.check_once()

  assert first.status is BackendUpdateStatus.IDLE
  assert second.status is BackendUpdateStatus.READY
  assert calls["count"] == 2
