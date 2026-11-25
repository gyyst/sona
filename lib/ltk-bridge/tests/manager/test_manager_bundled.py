"""随包 LTK Manager 清单的读取与校验测试。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from sona_ltk.services.manager.bundled import load_bundled_manager

PAYLOAD = b"bundled-installer"
SHA = hashlib.sha256(PAYLOAD).hexdigest()


def _write_bundle(
  root: Path,
  *,
  manifest: dict | None = None,
  installer: bytes | None = PAYLOAD,
) -> Path:
  folder = root / "manager"
  folder.mkdir(parents=True, exist_ok=True)
  if installer is not None:
    (folder / "LTK.Manager_1.34.0_x64-setup.exe").write_bytes(installer)
  payload = manifest
  if payload is None:
    payload = {
      "version": "1.34.0",
      "file": "LTK.Manager_1.34.0_x64-setup.exe",
      "sha256": SHA,
      "size": len(PAYLOAD),
    }
  (folder / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
  return folder


def test_returns_none_without_a_manifest(tmp_path: Path) -> None:
  assert load_bundled_manager(tmp_path) is None


def test_reads_a_valid_manifest(tmp_path: Path) -> None:
  _write_bundle(tmp_path)

  bundled = load_bundled_manager(tmp_path)

  assert bundled is not None
  assert bundled.version == "1.34.0"
  assert bundled.sha256 == SHA
  assert bundled.size == len(PAYLOAD)
  assert bundled.path.is_file()


def test_returns_none_when_the_installer_file_is_missing(tmp_path: Path) -> None:
  _write_bundle(tmp_path, installer=None)

  assert load_bundled_manager(tmp_path) is None


def test_returns_none_for_an_unreadable_manifest(tmp_path: Path) -> None:
  folder = tmp_path / "manager"
  folder.mkdir(parents=True)
  (folder / "manifest.json").write_text("{not json", encoding="utf-8")

  assert load_bundled_manager(tmp_path) is None


def test_returns_none_for_a_manifest_with_an_invalid_digest(tmp_path: Path) -> None:
  _write_bundle(tmp_path, manifest={
    "version": "1.34.0",
    "file": "LTK.Manager_1.34.0_x64-setup.exe",
    "sha256": "too-short",
    "size": len(PAYLOAD),
  })

  assert load_bundled_manager(tmp_path) is None


def test_returns_none_for_a_manifest_without_a_version(tmp_path: Path) -> None:
  _write_bundle(tmp_path, manifest={
    "file": "LTK.Manager_1.34.0_x64-setup.exe",
    "sha256": SHA,
    "size": len(PAYLOAD),
  })

  assert load_bundled_manager(tmp_path) is None


def test_lowercases_the_digest(tmp_path: Path) -> None:
  _write_bundle(tmp_path, manifest={
    "version": "1.34.0",
    "file": "LTK.Manager_1.34.0_x64-setup.exe",
    "sha256": SHA.upper(),
    "size": len(PAYLOAD),
  })

  bundled = load_bundled_manager(tmp_path)

  assert bundled is not None
  assert bundled.sha256 == SHA
