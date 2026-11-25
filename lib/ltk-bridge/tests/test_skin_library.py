"""皮肤资源库路径与校验测试。"""

from __future__ import annotations

import zipfile
from collections.abc import Sequence
from pathlib import Path

import httpx
import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import SkinSelection
from sona_ltk.services.skin_library import (
  SkinLibrary,
  SkinLibraryError,
  UnsupportedFormError,
)

REMOTE_URL = "https://raw.githubusercontent.com/Alban1911/LeagueSkins/main/skins/99/99007/99007.zip"


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
  requested: list[list[str]] = []

  def fake_download(urls: Sequence[str], destination: Path) -> bool:
    requested.append(list(urls))
    _write_zip(destination)
    return True

  monkeypatch.setattr(library, "_download", fake_download)
  archive = library.resolve(_selection())

  assert archive.path == tmp_path / "cache" / "99" / "99007" / "99007.zip"
  assert requested == [[f"https://gh-proxy.org/{REMOTE_URL}", REMOTE_URL]]


def test_remote_mode_without_fallback_only_uses_proxy(
  tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
  config = BridgeConfig(github_proxy_fallback=False)
  library = SkinLibrary(config, tmp_path / "cache")
  requested: list[list[str]] = []

  def fake_download(urls: Sequence[str], destination: Path) -> bool:
    requested.append(list(urls))
    _write_zip(destination)
    return True

  monkeypatch.setattr(library, "_download", fake_download)
  library.resolve(_selection())

  assert requested == [[f"https://gh-proxy.org/{REMOTE_URL}"]]


def test_custom_mirror_is_not_proxied(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  mirror = "https://cdn.jsdelivr.net/gh/Alban1911/LeagueSkins@main"
  library = SkinLibrary(BridgeConfig(skin_repository_base_url=mirror), tmp_path / "cache")
  requested: list[list[str]] = []

  def fake_download(urls: Sequence[str], destination: Path) -> bool:
    requested.append(list(urls))
    _write_zip(destination)
    return True

  monkeypatch.setattr(library, "_download", fake_download)
  library.resolve(_selection())

  assert requested == [[f"{mirror}/skins/99/99007/99007.zip"]]


def test_local_cache_hit_skips_download(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  cache = tmp_path / "cache"
  _write_zip(cache / "99" / "99007" / "99007.zip")
  library = SkinLibrary(BridgeConfig(), cache)

  def fail_download(urls: Sequence[str], destination: Path) -> bool:
    raise AssertionError("缓存命中时不应发起下载")

  monkeypatch.setattr(library, "_download", fail_download)
  archive = library.resolve(_selection())

  assert archive.path == cache / "99" / "99007" / "99007.zip"


class _FakeResponse:
  def __init__(self, status_code: int, content: bytes = b"") -> None:
    self.status_code = status_code
    self._content = content
    self.headers: dict[str, str] = {}

  def raise_for_status(self) -> None:
    if self.status_code >= 400:
      request = httpx.Request("GET", "https://example.test")
      response = httpx.Response(self.status_code, request=request)
      raise httpx.HTTPStatusError("boom", request=request, response=response)

  def iter_bytes(self, chunk_size: int = 0) -> list[bytes]:
    return [self._content]


class _FakeStream:
  def __init__(self, response: _FakeResponse) -> None:
    self._response = response

  def __enter__(self) -> _FakeResponse:
    return self._response

  def __exit__(self, *args: object) -> bool:
    return False


def _patch_stream(monkeypatch: pytest.MonkeyPatch, responses: dict[str, _FakeResponse]) -> list[str]:
  called: list[str] = []

  def fake_stream(method: str, url: str, **_kwargs: object) -> _FakeStream:
    called.append(url)
    return _FakeStream(responses[url])

  monkeypatch.setattr("sona_ltk.services.skin_library.httpx.stream", fake_stream)
  return called


def test_download_falls_back_to_direct_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  proxy_url = f"https://gh-proxy.org/{REMOTE_URL}"
  called = _patch_stream(
    monkeypatch,
    {
      proxy_url: _FakeResponse(503),
      REMOTE_URL: _FakeResponse(200, b"zip-bytes"),
    },
  )
  library = SkinLibrary(BridgeConfig(), tmp_path / "cache")
  destination = tmp_path / "cache" / "99" / "99007" / "99007.zip"

  assert library._download([proxy_url, REMOTE_URL], destination) is True
  assert called == [proxy_url, REMOTE_URL]
  assert destination.read_bytes() == b"zip-bytes"


def test_download_404_does_not_fall_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  proxy_url = f"https://gh-proxy.org/{REMOTE_URL}"
  called = _patch_stream(monkeypatch, {proxy_url: _FakeResponse(404)})
  library = SkinLibrary(BridgeConfig(), tmp_path / "cache")

  assert library._download([proxy_url, REMOTE_URL], tmp_path / "x.zip") is False
  assert called == [proxy_url]


def test_download_raises_after_all_candidates_fail(
  tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
  proxy_url = f"https://gh-proxy.org/{REMOTE_URL}"
  _patch_stream(
    monkeypatch,
    {proxy_url: _FakeResponse(502), REMOTE_URL: _FakeResponse(500)},
  )
  library = SkinLibrary(BridgeConfig(), tmp_path / "cache")

  with pytest.raises(SkinLibraryError, match="下载皮肤失败"):
    library._download([proxy_url, REMOTE_URL], tmp_path / "x.zip")
