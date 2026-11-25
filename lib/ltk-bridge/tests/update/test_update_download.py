"""更新清单与 Release zip 下载、重定向与哈希校验测试。"""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

from sona_ltk.services.update.download import (
  UpdateDownloadError,
  download_archive,
  fetch_manifest,
  release_archive_url,
)

RELEASE = "v2026.11.25.8"
PAYLOAD = b"fake-runtime-zip" * 100
SHA = hashlib.sha256(PAYLOAD).hexdigest()
MANIFEST_JSON = (
  '{"release":"v2026.11.25.8","sha256":"' + "b" * 64 + '","size":1024,'
  '"files":{"sona-ltk.exe":{"sha256":"' + "a" * 64 + '","size":10}}}'
)
PROXY = "https://gh-proxy.org"
ARCHIVE_URL = release_archive_url(RELEASE)
PROXIED_URL = f"{PROXY}/{ARCHIVE_URL}"


def _client(handler) -> httpx.Client:
  return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def _manifest(make_manifest, **overrides):
  files = overrides.pop("files", {"sona-ltk.exe": b"x" * 10})
  archive_size = overrides.pop("archive_size", len(PAYLOAD))
  archive_sha256 = overrides.pop("archive_sha256", SHA)
  return make_manifest(
    files,
    archive_size=archive_size,
    archive_sha256=archive_sha256,
  )


def test_release_archive_url_is_constructed_client_side() -> None:
  assert ARCHIVE_URL == (
    "https://github.com/gyyst/sona/releases/download/v2026.11.25.8/"
    "sona-v2026.11.25.8.zip"
  )
  with pytest.raises(UpdateDownloadError):
    release_archive_url("2026.11.25.8")


def test_fetch_manifest_parses_valid_payload() -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    return httpx.Response(200, text=MANIFEST_JSON)

  with _client(handler) as client:
    manifest = fetch_manifest(client=client)

  assert manifest.release == RELEASE
  assert calls == ["https://raw.githubusercontent.com/gyyst/sona/dist/ltk.json"]


def test_fetch_manifest_falls_back_to_direct_after_proxy_5xx() -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    if request.url.host == "gh-proxy.org":
      return httpx.Response(503)
    return httpx.Response(200, text=MANIFEST_JSON)

  with _client(handler) as client:
    fetch_manifest(client=client, proxy=PROXY, proxy_fallback=True)

  assert len(calls) == 2
  assert calls[0].startswith(PROXY)
  assert calls[1].startswith("https://raw.githubusercontent.com/")


def test_fetch_manifest_rejects_invalid_payload() -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text="{}")

  with _client(handler) as client, pytest.raises(UpdateDownloadError):
    fetch_manifest(client=client)


def test_download_archive_success(tmp_path: Path, make_manifest) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    assert str(request.url) == ARCHIVE_URL
    return httpx.Response(200, content=PAYLOAD)

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client:
    result = download_archive(_manifest(make_manifest), destination, client=client)

  assert result == destination
  assert destination.read_bytes() == PAYLOAD
  assert not (tmp_path / "sona-update.zip.part").exists()


def test_download_archive_404_does_not_fall_back(tmp_path: Path, make_manifest) -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    if request.url.host == "gh-proxy.org":
      return httpx.Response(404)
    return httpx.Response(200, content=PAYLOAD)

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client, pytest.raises(UpdateDownloadError):
    download_archive(
      _manifest(make_manifest),
      destination,
      client=client,
      proxy=PROXY,
      proxy_fallback=True,
    )

  assert calls == [PROXIED_URL]
  assert not destination.exists()
  assert not (tmp_path / "sona-update.zip.part").exists()


def test_download_archive_5xx_falls_back_to_direct(tmp_path: Path, make_manifest) -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    if request.url.host == "gh-proxy.org":
      return httpx.Response(503)
    return httpx.Response(200, content=PAYLOAD)

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client:
    download_archive(
      _manifest(make_manifest),
      destination,
      client=client,
      proxy=PROXY,
      proxy_fallback=True,
    )

  assert calls == [PROXIED_URL, ARCHIVE_URL]
  assert destination.read_bytes() == PAYLOAD


def test_download_archive_rejects_size_mismatch(tmp_path: Path, make_manifest) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=PAYLOAD + b"extra")

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client, pytest.raises(UpdateDownloadError):
    download_archive(_manifest(make_manifest), destination, client=client)

  assert not destination.exists()
  assert not (tmp_path / "sona-update.zip.part").exists()


def test_download_archive_rejects_hash_mismatch(tmp_path: Path, make_manifest) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=PAYLOAD)

  destination = tmp_path / "sona-update.zip"
  manifest = _manifest(make_manifest, archive_sha256="c" * 64)
  with _client(handler) as client, pytest.raises(UpdateDownloadError):
    download_archive(manifest, destination, client=client)

  assert not destination.exists()


def test_download_archive_follows_allowed_redirect(tmp_path: Path, make_manifest) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    if request.url.host == "github.com":
      return httpx.Response(
        302,
        headers={"location": "https://objects.githubusercontent.com/blob"},
      )
    return httpx.Response(200, content=PAYLOAD)

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client:
    download_archive(_manifest(make_manifest), destination, client=client)

  assert destination.read_bytes() == PAYLOAD


def test_download_archive_rejects_disallowed_redirect(tmp_path: Path, make_manifest) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(302, headers={"location": "https://evil.example.com/x.zip"})

  destination = tmp_path / "sona-update.zip"
  with _client(handler) as client, pytest.raises(UpdateDownloadError):
    download_archive(_manifest(make_manifest), destination, client=client)

  assert not destination.exists()
