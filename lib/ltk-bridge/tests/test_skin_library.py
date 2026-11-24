"""皮肤资源库路径与校验测试。"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import SkinSelection
from sona_ltk.services.skin_library import (
  SkinLibrary,
  SkinLibraryError,
  UnsupportedFormError,
)


def _selection(
  champion_id: int = 99,
  skin_id: int = 99007,
  base_skin_id: int = 99007,
  chroma_id: int | None = None,
) -> SkinSelection:
  return SkinSelection(
    champion_id=champion_id,
    skin_id=skin_id,
    base_skin_id=base_skin_id,
    chroma_id=chroma_id,
    skin_name="Elementalist Lux",
    owned=False,
    source="manual",
    timestamp_ms=1,
  )


def _write_zip(path: Path) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  with zipfile.ZipFile(path, "w") as archive:
    archive.writestr("META/info.json", '{"name":"test"}')


def test_local_base_skin_resolution(tmp_path: Path) -> None:
  library_root = tmp_path / "library"
  _write_zip(library_root / "99" / "99007" / "99007.zip")
  library = SkinLibrary(
    BridgeConfig(skin_library_mode="local", skin_library_root=library_root),
    tmp_path / "cache",
  )

  archive = library.resolve(_selection())

  assert archive.skin_id == 99007
  assert archive.chroma_id is None
  assert archive.path == library_root / "99" / "99007" / "99007.zip"
  assert len(archive.sha256) == 64


def test_local_chroma_resolution(tmp_path: Path) -> None:
  library_root = tmp_path / "library"
  _write_zip(library_root / "99" / "99007" / "99991" / "99991.zip")
  library = SkinLibrary(
    BridgeConfig(skin_library_mode="local", skin_library_root=library_root),
    tmp_path / "cache",
  )

  archive = library.resolve(_selection(skin_id=99991, chroma_id=99991))

  assert archive.skin_id == 99991
  assert archive.chroma_id == 99991


def test_missing_local_skin(tmp_path: Path) -> None:
  library = SkinLibrary(
    BridgeConfig(skin_library_mode="local", skin_library_root=tmp_path / "empty"),
    tmp_path / "cache",
  )
  with pytest.raises(SkinLibraryError):
    library.resolve(_selection())


def test_forms_are_not_supported_yet(tmp_path: Path) -> None:
  library = SkinLibrary(
    BridgeConfig(skin_library_mode="local", skin_library_root=tmp_path),
    tmp_path / "cache",
  )
  selection = SkinSelection(
    champion_id=99,
    skin_id=99007,
    base_skin_id=99007,
    form_id=99991,
    skin_name="Elementalist Lux Air",
    owned=False,
    source="manual",
    timestamp_ms=1,
  )
  with pytest.raises(UnsupportedFormError):
    library.resolve(selection)


def test_corrupt_archive_is_rejected(tmp_path: Path) -> None:
  library_root = tmp_path / "library"
  path = library_root / "99" / "99007" / "99007.zip"
  path.parent.mkdir(parents=True)
  path.write_bytes(b"not a zip")
  library = SkinLibrary(
    BridgeConfig(skin_library_mode="local", skin_library_root=library_root),
    tmp_path / "cache",
  )
  with pytest.raises(SkinLibraryError):
    library.resolve(_selection())


def test_remote_mode_uses_cache_and_expected_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  library = SkinLibrary(BridgeConfig(), tmp_path / "cache")
  requested: list[str] = []

  def fake_download(url: str, destination: Path) -> bool:
    requested.append(url)
    _write_zip(destination)
    return True

  monkeypatch.setattr(library, "_download", fake_download)
  archive = library.resolve(_selection())

  assert archive.path == tmp_path / "cache" / "99" / "99007" / "99007.zip"
  assert requested == [
    "https://raw.githubusercontent.com/Alban1911/LeagueSkins/main/skins/99/99007/99007.zip",
  ]
