"""安装包下载与校验测试。"""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

from sona_ltk.services.manager.download import (
  ManagerDownloadError,
  download_installer,
)

PAYLOAD = b"fake-installer-bytes" * 100
SHA = hashlib.sha256(PAYLOAD).hexdigest()
URL = "https://github.com/LeagueToolkit/ltk-manager/releases/download/v1.33.0/test.exe"


def _client(handler) -> httpx.Client:
  return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_downloads_and_verifies(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    assert str(request.url) == URL
    return httpx.Response(
      200,
      content=PAYLOAD,
      headers={"content-length": str(len(PAYLOAD))},
    )

  target = tmp_path / "setup.exe"
  progress: list[int] = []
  with _client(handler) as client:
    result = download_installer(
      URL,
      target,
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      on_progress=progress.append,
      client=client,
    )

  assert result == target
  assert target.read_bytes() == PAYLOAD
  assert progress[-1] == 100


def test_rejects_bad_hash_and_cleans_partial(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=PAYLOAD)

  target = tmp_path / "setup.exe"
  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="SHA-256"):
    download_installer(URL, target, "0" * 64, len(PAYLOAD), timeout_s=5, client=client)

  assert not target.exists()
  assert not target.with_name(target.name + ".part").exists()


def test_rejects_size_mismatch(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=PAYLOAD)

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="大小不符"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD) + 1,
      timeout_s=5,
      client=client,
    )


def test_rejects_non_https_url(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    raise AssertionError("不应发出请求")

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="HTTPS"):
    download_installer(
      "http://github.com/file.exe",
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_rejects_non_allowlisted_host(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    raise AssertionError("不应发出请求")

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="主机"):
    download_installer(
      "https://evil.example.com/file.exe",
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_follows_allowlisted_redirect(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    if request.url.host == "github.com":
      return httpx.Response(
        302,
        headers={"location": "https://objects.githubusercontent.com/file.exe"},
      )
    return httpx.Response(200, content=PAYLOAD)

  target = tmp_path / "setup.exe"
  with _client(handler) as client:
    download_installer(URL, target, SHA, len(PAYLOAD), timeout_s=5, client=client)
  assert target.read_bytes() == PAYLOAD


def test_rejects_redirect_to_untrusted_host(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
      302,
      headers={"location": "https://evil.example.com/file.exe"},
    )

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="主机"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_wraps_http_status_error(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(404)

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="下载失败"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_rejects_too_many_redirects(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(302, headers={"location": URL})

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="重定向次数过多"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_rejects_redirect_to_http(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
      302,
      headers={"location": "http://github.com/file.exe"},
    )

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="HTTPS"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
    )


def test_rejects_oversized_response(tmp_path: Path) -> None:
  def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=PAYLOAD)

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="大小超出预期"):
    download_installer(
      URL,
      tmp_path / "setup.exe",
      SHA,
      10,
      timeout_s=5,
      client=client,
    )
