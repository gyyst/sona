"""发布清单生成脚本对样例 zip 的契约测试。"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

from sona_ltk.services.update.archive import extract_runtime
from sona_ltk.services.update.manifest import BackendUpdateManifest

SCRIPT = Path(__file__).resolve().parents[4] / "scripts" / "ltk" / "runtime-manifest.py"


def _write_zip(path: Path, entries: dict[str, bytes]) -> Path:
  with zipfile.ZipFile(path, "w") as archive:
    for name, payload in entries.items():
      archive.writestr(name, payload)
  return path


def _run(archive: Path, release: str, output: Path) -> subprocess.CompletedProcess[str]:
  return subprocess.run(
    [sys.executable, str(SCRIPT), str(archive), release, str(output)],
    capture_output=True,
    text=True,
    check=False,
  )


def _zip_sha256(path: Path) -> str:
  digest = hashlib.sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(64 * 1024), b""):
      digest.update(chunk)
  return digest.hexdigest()


def test_generates_manifest_with_exe_last_and_exclusions(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "sona-v2026.11.25.8.zip",
    {
      "sona/index.js": b"frozen",
      "sona/assets/README.txt": b"assets",
      "sona/ltk/sona-ltk.exe": b"exe",
      "sona/ltk/ltk_launcher.exe": b"launcher",
      "sona/ltk/LeagueToolFlop.dll": b"dll",
      "sona/ltk/config.example.json": b"{}",
      "sona/ltk/manager/manifest.json": b"{\"version\":\"1.33.0\"}",
      "sona/ltk/config.json": b"user-config",
      "sona/ltk/Config.json": b"user-config-alt",
      "sona/ltk/logs/sona-ltk.log": b"user-log",
      "sona/ltk/LOGS/other.log": b"user-log-alt",
      "sona/ltk/data/skins/a.zip": b"user-skin",
      "sona/ltk/downloads/setup.exe": b"user-download",
    },
  )
  output = tmp_path / "ltk.json"

  result = _run(archive, "v2026.11.25.8", output)

  assert result.returncode == 0, result.stderr
  payload = json.loads(output.read_text(encoding="utf-8"))
  assert payload["release"] == "v2026.11.25.8"
  assert payload["size"] == archive.stat().st_size
  assert payload["sha256"] == _zip_sha256(archive)
  assert list(payload["files"]) == [
    "LeagueToolFlop.dll",
    "config.example.json",
    "ltk_launcher.exe",
    "manager/manifest.json",
    "sona-ltk.exe",
  ]
  assert payload["files"]["sona-ltk.exe"] == {
    "sha256": hashlib.sha256(b"exe").hexdigest(),
    "size": 3,
  }
  # 生成脚本与后台消费模型必须保持同一契约
  parsed = BackendUpdateManifest.model_validate_json(output.read_text(encoding="utf-8"))
  assert list(parsed.files) == list(payload["files"])


def test_generated_manifest_extracts_the_same_zip(tmp_path: Path) -> None:
  """发布端生成的清单必须能被后台消费端直接用于解压，避免两侧契约漂移。"""

  archive = _write_zip(
    tmp_path / "sona-v2026.11.25.8.zip",
    {
      "sona/index.js": b"frozen",
      "sona/assets/README.txt": b"assets",
      "sona/ltk/sona-ltk.exe": b"exe",
      "sona/ltk/manager/LTK Manager_1.33.0_x64-setup.exe": b"installer",
    },
  )
  output = tmp_path / "ltk.json"
  result = _run(archive, "v2026.11.25.8", output)
  assert result.returncode == 0, result.stderr

  manifest = BackendUpdateManifest.model_validate_json(output.read_text(encoding="utf-8"))
  staging = tmp_path / "staging"
  extract_runtime(archive, manifest, staging)

  assert list(manifest.files)[-1] == "sona-ltk.exe"
  assert (staging / "sona-ltk.exe").read_bytes() == b"exe"
  assert (staging / "manager" / "LTK Manager_1.33.0_x64-setup.exe").read_bytes() == b"installer"
  assert not (staging / "index.js").exists()
  assert not (staging / "assets").exists()


def test_rejects_invalid_release(tmp_path: Path) -> None:
  archive = _write_zip(tmp_path / "a.zip", {"sona/ltk/sona-ltk.exe": b"exe"})
  result = _run(archive, "2026.11.25.8", tmp_path / "ltk.json")
  assert result.returncode == 1
  assert "release" in result.stderr


def test_rejects_missing_executable(tmp_path: Path) -> None:
  archive = _write_zip(tmp_path / "a.zip", {"sona/ltk/a.dll": b"dll"})
  result = _run(archive, "v2026.11.25.8", tmp_path / "ltk.json")
  assert result.returncode == 1
  assert "sona-ltk.exe" in result.stderr


def test_rejects_path_traversal_member(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "a.zip",
    {
      "sona/ltk/sona-ltk.exe": b"exe",
      "sona/ltk/../evil.txt": b"evil",
    },
  )
  result = _run(archive, "v2026.11.25.8", tmp_path / "ltk.json")
  assert result.returncode == 1
  assert "非法路径" in result.stderr


def test_rejects_trailing_space_component(tmp_path: Path) -> None:
  # Windows 会去掉路径段末尾空格；`.. ` 等价于 `..`，必须在生成清单时拒绝
  archive = _write_zip(
    tmp_path / "a.zip",
    {
      "sona/ltk/sona-ltk.exe": b"exe",
      "sona/ltk/.. /evil.txt": b"evil",
    },
  )
  result = _run(archive, "v2026.11.25.8", tmp_path / "ltk.json")
  assert result.returncode == 1
  assert "非法路径" in result.stderr


def test_rejects_missing_zip(tmp_path: Path) -> None:
  result = _run(tmp_path / "missing.zip", "v2026.11.25.8", tmp_path / "ltk.json")
  assert result.returncode == 1
  assert "不存在" in result.stderr
