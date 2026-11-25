"""Release zip 解压安全与逐文件校验测试。"""

from __future__ import annotations

import hashlib
import stat
import zipfile
from pathlib import Path

import pytest

from sona_ltk.services.update.archive import UpdateArchiveError, extract_runtime
from sona_ltk.services.update.manifest import (
  BackendUpdateManifest,
  ManifestFile,
  sha256_file,
)


def _write_zip(path: Path, entries: list[tuple[str, bytes, int]]) -> Path:
  with zipfile.ZipFile(path, "w") as archive:
    for name, payload, mode in entries:
      info = zipfile.ZipInfo(name)
      info.external_attr = mode << 16
      archive.writestr(info, payload)
  return path


def _manifest(files: dict[str, bytes], **overrides: object) -> BackendUpdateManifest:
  payload = {
    "release": "v2026.11.25.8",
    "sha256": "b" * 64,
    "size": 1024,
    "files": {
      name: {"sha256": sha256_of(content), "size": len(content)}
      for name, content in files.items()
    },
  }
  payload.update(overrides)
  return BackendUpdateManifest.model_validate(payload)


def sha256_of(content: bytes) -> str:
  return hashlib.sha256(content).hexdigest()


def test_extracts_only_manifest_files(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [
      ("sona/ltk/sona-ltk.exe", b"exe", stat.S_IFREG | 0o644),
      ("sona/ltk/manager/manifest.json", b"{}", stat.S_IFREG | 0o644),
      ("sona/index.js", b"frozen", stat.S_IFREG | 0o644),
      ("sona/assets/README.txt", b"assets", stat.S_IFREG | 0o644),
    ],
  )
  manifest = _manifest(
    {"sona-ltk.exe": b"exe", "manager/manifest.json": b"{}"},
  )
  staging = tmp_path / "sona-update.new"

  extract_runtime(archive, manifest, staging)

  assert (staging / "sona-ltk.exe").read_bytes() == b"exe"
  assert (staging / "manager" / "manifest.json").read_bytes() == b"{}"
  assert not (staging / "index.js").exists()
  assert not (tmp_path / "index.js").exists()
  assert not (tmp_path / "assets").exists()


def test_cleans_existing_staging_before_extract(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/sona-ltk.exe", b"new", stat.S_IFREG | 0o644)],
  )
  manifest = _manifest({"sona-ltk.exe": b"new"})
  staging = tmp_path / "sona-update.new"
  staging.mkdir()
  (staging / "stale.txt").write_text("stale")

  extract_runtime(archive, manifest, staging)

  assert not (staging / "stale.txt").exists()
  assert (staging / "sona-ltk.exe").read_bytes() == b"new"


def test_missing_manifest_file_removes_staging(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/sona-ltk.exe", b"exe", stat.S_IFREG | 0o644)],
  )
  manifest = _manifest({"sona-ltk.exe": b"exe", "ltk_launcher.exe": b"launcher"})
  staging = tmp_path / "sona-update.new"

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, staging)

  assert not staging.exists()


def test_hash_mismatch_removes_staging(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/sona-ltk.exe", b"tampered", stat.S_IFREG | 0o644)],
  )
  manifest = _manifest({"sona-ltk.exe": b"original"})
  staging = tmp_path / "sona-update.new"

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, staging)

  assert not staging.exists()


def test_entry_size_mismatch_is_rejected(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/sona-ltk.exe", b"longer-size", stat.S_IFREG | 0o644)],
  )
  manifest = _manifest({"sona-ltk.exe": b"short"})

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, tmp_path / "staging")


def test_symlink_is_rejected(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/link.txt", b"target", stat.S_IFLNK | 0o777)],
  )
  manifest = _manifest({"link.txt": b"target"})

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, tmp_path / "staging")


def test_unsafe_manifest_path_is_rejected_even_with_constructed_model(
  tmp_path: Path,
) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [("sona/ltk/../evil.txt", b"evil", stat.S_IFREG | 0o644)],
  )
  # 正常校验不会接受该路径；用 model_construct 绕过构造校验，验证解压层防线。
  manifest = BackendUpdateManifest.model_construct(
    release="v2026.11.25.8",
    sha256="b" * 64,
    size=1024,
    files={"../evil.txt": ManifestFile(sha256=sha256_of(b"evil"), size=4)},
  )

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, tmp_path / "staging")

  assert not (tmp_path / "evil.txt").exists()
  assert not (tmp_path / "staging").exists()


def test_duplicate_entries_are_rejected(tmp_path: Path) -> None:
  archive = _write_zip(
    tmp_path / "update.zip",
    [
      ("sona/ltk/sona-ltk.exe", b"exe", stat.S_IFREG | 0o644),
      ("sona/ltk/sona-ltk.exe", b"exe", stat.S_IFREG | 0o644),
    ],
  )
  manifest = _manifest({"sona-ltk.exe": b"exe"})

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, tmp_path / "staging")


def test_bad_zip_removes_staging(tmp_path: Path) -> None:
  archive = tmp_path / "update.zip"
  archive.write_bytes(b"not a zip")
  manifest = _manifest({"sona-ltk.exe": b"exe"})
  staging = tmp_path / "staging"

  with pytest.raises(UpdateArchiveError):
    extract_runtime(archive, manifest, staging)

  assert not staging.exists()


def test_sha256_file_matches(tmp_path: Path) -> None:
  target = tmp_path / "data.bin"
  target.write_bytes(b"payload")
  assert sha256_file(target) == sha256_of(b"payload")
