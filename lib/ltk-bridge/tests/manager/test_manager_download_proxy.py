"""安装包经 GitHub 代理下载的候选与回退测试。"""

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
PROXY_URL = f"https://gh-proxy.org/{URL}"
OK_HEADERS = {"content-length": str(len(PAYLOAD))}


def _client(handler) -> httpx.Client:
  return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)


def test_downloads_through_configured_proxy(tmp_path: Path) -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    return httpx.Response(200, content=PAYLOAD, headers=OK_HEADERS)

  target = tmp_path / "setup.exe"
  with _client(handler) as client:
    download_installer(
      PROXY_URL,
      target,
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
      fallback_urls=[URL],
      extra_allowed_hosts=frozenset({"gh-proxy.org"}),
    )

  assert calls == [PROXY_URL]
  assert target.read_bytes() == PAYLOAD


def test_proxy_host_needs_explicit_allowlist(tmp_path: Path) -> None:
  """未把代理主机列入白名单时拒绝代理地址，并回退直连。"""

  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    return httpx.Response(200, content=PAYLOAD, headers=OK_HEADERS)

  with _client(handler) as client:
    download_installer(
      PROXY_URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
      fallback_urls=[URL],
    )

  assert calls == [URL]


def test_proxy_5xx_falls_back_to_direct(tmp_path: Path) -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    if request.url.host == "gh-proxy.org":
      return httpx.Response(503)
    return httpx.Response(200, content=PAYLOAD, headers=OK_HEADERS)

  target = tmp_path / "setup.exe"
  with _client(handler) as client:
    download_installer(
      PROXY_URL,
      target,
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
      fallback_urls=[URL],
      extra_allowed_hosts=frozenset({"gh-proxy.org"}),
    )

  assert calls == [PROXY_URL, URL]
  assert target.read_bytes() == PAYLOAD


def test_proxy_4xx_does_not_fall_back(tmp_path: Path) -> None:
  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    return httpx.Response(403)

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="下载失败"):
    download_installer(
      PROXY_URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
      fallback_urls=[URL],
      extra_allowed_hosts=frozenset({"gh-proxy.org"}),
    )

  assert calls == [PROXY_URL]


def test_hash_failure_does_not_fall_back(tmp_path: Path) -> None:
  """代理返回被篡改的内容时中止，不能把校验失败当网络问题重试。"""

  calls: list[str] = []

  def handler(request: httpx.Request) -> httpx.Response:
    calls.append(str(request.url))
    if request.url.host == "gh-proxy.org":
      tampered = b"x" * len(PAYLOAD)
      return httpx.Response(200, content=tampered, headers=OK_HEADERS)
    return httpx.Response(200, content=PAYLOAD, headers=OK_HEADERS)

  with _client(handler) as client, pytest.raises(ManagerDownloadError, match="SHA-256"):
    download_installer(
      PROXY_URL,
      tmp_path / "setup.exe",
      SHA,
      len(PAYLOAD),
      timeout_s=5,
      client=client,
      fallback_urls=[URL],
      extra_allowed_hosts=frozenset({"gh-proxy.org"}),
    )

  assert calls == [PROXY_URL]
