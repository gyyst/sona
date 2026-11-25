"""更新计划 JSON、PowerShell 模板与清理逻辑测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sona_ltk import __main__ as main_module
from sona_ltk.services.update import script as script_module
from sona_ltk.services.update.script import (
  PLAN_FILE,
  SCRIPT_FILE,
  STAGING_DIR,
  ZIP_FILE,
  UpdatePlan,
  cleanup_stale_update_files,
  launch_update_script,
  render_update_script,
  write_update_plan,
  write_update_script,
)


def _plan(root: Path, *, args: tuple[str, ...] = ()) -> UpdatePlan:
  return UpdatePlan(
    pid=1234,
    target=root,
    staged=root / STAGING_DIR,
    exe="sona-ltk.exe",
    files=("ltk_launcher.exe", "manager/manifest.json", "sona-ltk.exe"),
    log=root / "logs" / "update.log",
    args=args,
  )


def test_write_update_plan_round_trips(tmp_path: Path) -> None:
  plan = _plan(tmp_path)
  plan_path = tmp_path / PLAN_FILE

  write_update_plan(plan, plan_path)

  payload = json.loads(plan_path.read_text(encoding="utf-8"))
  assert payload["pid"] == 1234
  assert payload["target"] == str(tmp_path)
  assert payload["staged"] == str(tmp_path / STAGING_DIR)
  assert payload["exe"] == "sona-ltk.exe"
  assert payload["files"][-1] == "sona-ltk.exe"
  assert payload["log"].endswith("update.log")
  assert payload["args"] == []


def test_write_update_plan_preserves_launch_arguments(tmp_path: Path) -> None:
  plan = _plan(tmp_path, args=("--port", "50010", "--token", "token with space"))
  plan_path = tmp_path / PLAN_FILE

  write_update_plan(plan, plan_path)

  payload = json.loads(plan_path.read_text(encoding="utf-8"))
  assert payload["args"] == ["--port", "50010", "--token", "token with space"]


def test_write_update_plan_rejects_unsafe_paths(tmp_path: Path) -> None:
  plan = UpdatePlan(
    pid=1,
    target=tmp_path,
    staged=tmp_path / STAGING_DIR,
    exe="sona-ltk.exe",
    files=("../evil.exe", "sona-ltk.exe"),
    log=tmp_path / "update.log",
  )
  with pytest.raises(ValueError):
    write_update_plan(plan, tmp_path / PLAN_FILE)


def test_write_update_plan_requires_executable(tmp_path: Path) -> None:
  plan = UpdatePlan(
    pid=1,
    target=tmp_path,
    staged=tmp_path / STAGING_DIR,
    exe="sona-ltk.exe",
    files=("a.dll",),
    log=tmp_path / "update.log",
  )
  with pytest.raises(ValueError):
    write_update_plan(plan, tmp_path / PLAN_FILE)


def test_render_script_contains_replace_and_rollback_flow() -> None:
  script = render_update_script()

  assert "Wait-Process -Id $pendingPid -Timeout 60" in script
  assert "Resolve-SafeChild" in script
  assert "拒绝冒号路径" in script
  assert "Restore-ReplacedFiles" in script
  assert "Start-Sleep -Seconds 8" in script
  assert ".old" in script
  assert "Start-Process -FilePath $exePath" in script
  assert "exit 1" in script


def test_render_script_restarts_with_original_arguments() -> None:
  script = render_update_script()

  assert "function ConvertTo-CommandLine" in script
  assert "$script:arguments = ConvertTo-CommandLine @($plan.args)" in script
  assert "-ArgumentList $script:arguments" in script


def test_write_update_script_uses_bom_and_crlf(tmp_path: Path) -> None:
  path = write_update_script(tmp_path)
  content = path.read_bytes()
  assert path.name == SCRIPT_FILE
  assert content.startswith(b"\xef\xbb\xbf")
  assert b"\r\n" in content


def test_cleanup_removes_staging_zip_plan_script_and_backups(tmp_path: Path) -> None:
  staging = tmp_path / STAGING_DIR
  staging.mkdir()
  (staging / "file.bin").write_bytes(b"staged")
  (tmp_path / ZIP_FILE).write_bytes(b"zip")
  (tmp_path / (ZIP_FILE + ".part")).write_bytes(b"partial")
  (tmp_path / SCRIPT_FILE).write_text("script", encoding="utf-8")
  (tmp_path / "sona-ltk.exe.old").write_bytes(b"old-exe")
  (tmp_path / "manager").mkdir()
  (tmp_path / "manager" / "manifest.json.old").write_bytes(b"old-manifest")
  plan_path = tmp_path / PLAN_FILE
  write_update_plan(_plan(tmp_path), plan_path)

  cleanup_stale_update_files(tmp_path)

  assert not staging.exists()
  assert not (tmp_path / ZIP_FILE).exists()
  assert not (tmp_path / (ZIP_FILE + ".part")).exists()
  assert not (tmp_path / SCRIPT_FILE).exists()
  assert not plan_path.exists()
  assert not (tmp_path / "sona-ltk.exe.old").exists()
  assert not (tmp_path / "manager" / "manifest.json.old").exists()


def test_cleanup_with_manifest_removes_backups_without_plan(
  tmp_path: Path,
  make_manifest,
) -> None:
  (tmp_path / "a.dll.old").write_bytes(b"old")
  manifest = make_manifest({"a.dll": b"new"})

  cleanup_stale_update_files(tmp_path, manifest)

  assert not (tmp_path / "a.dll.old").exists()


def test_launch_refuses_non_windows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr(script_module.sys, "platform", "linux")
  assert launch_update_script(tmp_path) is False


def test_launch_requires_script(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr(script_module.sys, "platform", "win32")
  with pytest.raises(FileNotFoundError):
    launch_update_script(tmp_path)


def test_launch_falls_back_to_restarting_old_backend(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  plan = _plan(tmp_path, args=("--port", "50010"))
  spawned: list[tuple[list[str], dict[str, object]]] = []

  monkeypatch.setattr(main_module, "launch_update_script", lambda root: False)
  monkeypatch.setattr(main_module.sys, "frozen", True, raising=False)
  monkeypatch.setattr(main_module.sys, "executable", str(tmp_path / "sona-ltk.exe"))
  monkeypatch.setattr(
    main_module.subprocess,
    "Popen",
    lambda command, **kwargs: spawned.append((command, kwargs)),
  )

  main_module._launch_pending_update(plan, tmp_path)

  # 替换脚本没启动时必须把旧版本拉起来，并沿用原启动参数
  assert [item[0] for item in spawned] == [[str(tmp_path / "sona-ltk.exe"), "--port", "50010"]]
  env = spawned[0][1]["env"]
  assert isinstance(env, dict)
  # 本次会话跳过自更新，避免同一会话反复重启
  assert env[main_module.SKIP_ENV_NAME] == "1"
  assert (tmp_path / PLAN_FILE).is_file()


def test_launch_does_not_start_a_second_backend_when_script_launches(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  plan = _plan(tmp_path)

  monkeypatch.setattr(main_module, "launch_update_script", lambda root: True)
  monkeypatch.setattr(
    main_module.subprocess,
    "Popen",
    lambda *args, **kwargs: pytest.fail("替换脚本已启动时不应再拉起第二个后台"),
  )

  main_module._launch_pending_update(plan, tmp_path)

  assert (tmp_path / PLAN_FILE).is_file()
