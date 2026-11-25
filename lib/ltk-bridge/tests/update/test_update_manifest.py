"""ltk.json 校验、路径安全与本地逐文件比较测试。"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from sona_ltk.services.update.manifest import (
  BackendUpdateManifest,
  UpdateManifestError,
  compare_local_files,
  is_safe_manifest_path,
  runtime_files,
)

SHA_A = "a" * 64
SHA_B = "b" * 64


def _payload(files: dict[str, dict[str, object]] | None = None, **overrides: object) -> dict[str, object]:
  payload: dict[str, object] = {
    "release": "v2026.11.25.8",
    "sha256": SHA_B,
    "size": 1024,
    "files": files if files is not None else {"sona-ltk.exe": {"sha256": SHA_A, "size": 10}},
  }
  payload.update(overrides)
  return payload


def test_accepts_valid_manifest() -> None:
  manifest = BackendUpdateManifest.model_validate(_payload())
  assert manifest.release == "v2026.11.25.8"
  assert manifest.files["sona-ltk.exe"].sha256 == SHA_A


@pytest.mark.parametrize(
  "release",
  ["2026.11.25.8", "v2026", "v2026.11.25.8-rc", "vabc", "v2026.11.25.8 "],
)
def test_rejects_invalid_release(release: str) -> None:
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(_payload(release=release))


def test_normalizes_uppercase_hashes() -> None:
  manifest = BackendUpdateManifest.model_validate(
    _payload(files={"a.txt": {"sha256": SHA_A.upper(), "size": 1}}),
  )
  assert manifest.files["a.txt"].sha256 == SHA_A
  assert manifest.sha256 == SHA_B


def test_rejects_invalid_hashes() -> None:
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(_payload(sha256="not-a-hash"))
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(
      _payload(files={"a.txt": {"sha256": "xyz", "size": 1}}),
    )


def test_rejects_empty_files() -> None:
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(_payload(files={}))


def test_rejects_too_many_files() -> None:
  files = {f"file-{index}.bin": {"sha256": SHA_A, "size": 1} for index in range(65)}
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(_payload(files=files))


def test_rejects_oversized_archive_and_file() -> None:
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(_payload(size=301 * 1024 * 1024))
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(
      _payload(files={"big.bin": {"sha256": SHA_A, "size": 201 * 1024 * 1024}}),
    )


@pytest.mark.parametrize(
  "path",
  [
    "/abs/path",
    "../evil",
    "a/../b",
    "a\\b",
    "C:/windows",
    "a:b",
    "logs/x.log",
    "data/x",
    "downloads/x",
    "config.json",
    "Config.json",
    "LOGS/x.log",
    "",
    " leading",
    "trailing ",
    "a//b",
    "a/./b",
    "a/.. /b",
    "a/b ",
    "a/b.",
    "a/\x01",
  ],
)
def test_rejects_unsafe_paths(path: str) -> None:
  with pytest.raises(ValidationError):
    BackendUpdateManifest.model_validate(
      _payload(files={path: {"sha256": SHA_A, "size": 1}}),
    )


@pytest.mark.parametrize(
  "path",
  ["sona-ltk.exe", "manager/manifest.json", "启动 脚本.bat", "README.md"],
)
def test_accepts_safe_paths(path: str) -> None:
  assert is_safe_manifest_path(path)


def test_runtime_files_puts_executable_last() -> None:
  manifest = BackendUpdateManifest.model_validate(
    _payload(
      files={
        "sona-ltk.exe": {"sha256": SHA_A, "size": 1},
        "b.dll": {"sha256": SHA_A, "size": 1},
        "a.bat": {"sha256": SHA_A, "size": 1},
      },
    ),
  )
  assert runtime_files(manifest) == ("b.dll", "a.bat", "sona-ltk.exe")


def test_runtime_files_requires_executable() -> None:
  manifest = BackendUpdateManifest.model_validate(
    _payload(files={"a.dll": {"sha256": SHA_A, "size": 1}}),
  )
  with pytest.raises(UpdateManifestError):
    runtime_files(manifest)


def test_compare_local_files_matches(tmp_path: Path, make_manifest) -> None:
  native = b"exe-bytes"
  launcher = b"launcher"
  (tmp_path / "sona-ltk.exe").write_bytes(native)
  (tmp_path / "ltk_launcher.exe").write_bytes(launcher)
  (tmp_path / "unrelated.txt").write_bytes(b"extra files are ignored")
  manifest = make_manifest({"sona-ltk.exe": native, "ltk_launcher.exe": launcher})

  result = compare_local_files(tmp_path, manifest)

  assert result.matches is True
  assert result.missing == ()
  assert result.mismatched == ()


def test_compare_local_files_reports_missing_and_mismatch(
  tmp_path: Path,
  make_manifest,
) -> None:
  (tmp_path / "sona-ltk.exe").write_bytes(b"old")
  manifest = make_manifest(
    {"sona-ltk.exe": b"new", "ltk_launcher.exe": b"launcher"},
  )

  result = compare_local_files(tmp_path, manifest)

  assert result.matches is False
  assert result.missing == ("ltk_launcher.exe",)
  assert result.mismatched == ("sona-ltk.exe",)


def test_compare_local_files_detects_same_size_different_content(
  tmp_path: Path,
  make_manifest,
) -> None:
  (tmp_path / "a.dll").write_bytes(b"aaaa")
  manifest = make_manifest({"a.dll": b"bbbb"})

  assert compare_local_files(tmp_path, manifest).mismatched == ("a.dll",)
