"""更新清单与 Release zip 下载：HTTPS、主机白名单、大小与 SHA-256 校验。

GitHub 代理配置从 `config` 上按需读取（`getattr`），不依赖代理模块是否存在；
只对 GitHub 家族主机套代理，代理主机必须来自用户配置。
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from pydantic import ValidationError

from .manifest import (
  MAX_ARCHIVE_SIZE,
  RELEASE_PATTERN,
  BackendUpdateManifest,
  sha256_file,
)
from .proxy import allowed_hosts, proxy_candidates

log = logging.getLogger(__name__)

MANIFEST_URL = "https://raw.githubusercontent.com/gyyst/sona/dist/ltk.json"
RELEASE_DOWNLOAD_BASE = "https://github.com/gyyst/sona/releases/download"
MANIFEST_TIMEOUT_S = 30.0
ARCHIVE_TIMEOUT_S = 600.0
MANIFEST_MAX_BYTES = 1024 * 1024
CHUNK_SIZE = 64 * 1024
MAX_REDIRECTS = 5
REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})


class UpdateDownloadError(RuntimeError):
  """清单或更新包下载、校验失败。"""


class _RetryableDownloadError(UpdateDownloadError):
  """连接、超时或 5xx 类失败，可以换下一个候选地址重试。"""


def release_archive_url(release: str) -> str:
  """客户端自行构造 Release zip 地址，不读取清单中的任意 URL。"""

  if not RELEASE_PATTERN.fullmatch(release):
    raise UpdateDownloadError(f"非法发布版本：{release}")
  return f"{RELEASE_DOWNLOAD_BASE}/{release}/sona-{release}.zip"


def fetch_manifest(
  *,
  proxy: str | None = None,
  proxy_fallback: bool = True,
  timeout_s: float = MANIFEST_TIMEOUT_S,
  client: httpx.Client | None = None,
) -> BackendUpdateManifest:
  """读取并校验 `dist/ltk.json`。"""

  allowed = allowed_hosts(proxy)
  candidates = proxy_candidates(MANIFEST_URL, proxy, proxy_fallback)
  owned = client is None
  http = client or httpx.Client(timeout=httpx.Timeout(timeout_s), follow_redirects=False)
  deadline = time.monotonic() + timeout_s
  try:
    payload = _fetch_bytes(http, candidates, MANIFEST_MAX_BYTES, deadline, allowed)
  except httpx.HTTPError as exc:
    raise UpdateDownloadError(f"更新清单下载失败：{exc}") from exc
  finally:
    if owned:
      http.close()

  try:
    return BackendUpdateManifest.model_validate_json(payload)
  except ValidationError as exc:
    raise UpdateDownloadError(f"更新清单无效：{exc}") from exc


def download_archive(
  manifest: BackendUpdateManifest,
  destination: Path,
  *,
  timeout_s: float = ARCHIVE_TIMEOUT_S,
  proxy: str | None = None,
  proxy_fallback: bool = True,
  client: httpx.Client | None = None,
) -> Path:
  """下载 Release zip 到 `.part`，整体大小与 SHA-256 校验通过后原子替换。"""

  url = release_archive_url(manifest.release)
  allowed = allowed_hosts(proxy)
  candidates = proxy_candidates(url, proxy, proxy_fallback)
  destination.parent.mkdir(parents=True, exist_ok=True)
  partial = destination.with_name(destination.name + ".part")
  partial.unlink(missing_ok=True)

  owned = client is None
  http = client or httpx.Client(timeout=httpx.Timeout(timeout_s), follow_redirects=False)
  deadline = time.monotonic() + timeout_s
  log.info("开始下载后台运行时：%s（%s 字节）", url, manifest.size)
  try:
    _download_candidates(http, candidates, partial, manifest.size, deadline, allowed)
    _verify_archive(partial, manifest)
  except UpdateDownloadError:
    partial.unlink(missing_ok=True)
    raise
  except OSError as exc:
    partial.unlink(missing_ok=True)
    raise UpdateDownloadError(f"写入后台更新包失败：{exc}") from exc
  finally:
    if owned:
      http.close()

  os.replace(partial, destination)
  log.info("后台运行时下载并校验通过：%s", destination)
  return destination


def _fetch_bytes(
  client: httpx.Client,
  urls: Sequence[str],
  limit: int,
  deadline: float,
  allowed_hosts: frozenset[str],
) -> bytes:
  last_error: UpdateDownloadError | None = None
  for index, url in enumerate(urls):
    try:
      return _read_url(client, url, limit, deadline, allowed_hosts)
    except _RetryableDownloadError as exc:
      last_error = exc
      if index + 1 >= len(urls):
        break
      log.warning("更新清单下载失败，尝试备用地址 %s（原因：%s）", urls[index + 1], exc)
  raise UpdateDownloadError(str(last_error) if last_error else "更新清单下载失败")


def _read_url(
  client: httpx.Client,
  url: str,
  limit: int,
  deadline: float,
  allowed_hosts: frozenset[str],
) -> bytes:
  current = url
  for _ in range(MAX_REDIRECTS + 1):
    _ensure_deadline(deadline)
    _ensure_allowed(current, allowed_hosts)
    try:
      with client.stream("GET", current) as response:
        if response.status_code in REDIRECT_CODES:
          current = _redirect_target(current, response)
          continue
        response.raise_for_status()
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_bytes(CHUNK_SIZE):
          _ensure_deadline(deadline)
          total += len(chunk)
          if total > limit:
            raise UpdateDownloadError("更新清单超出大小限制")
          chunks.append(chunk)
        return b"".join(chunks)
    except httpx.HTTPStatusError as exc:
      raise _status_error(exc) from exc
    except httpx.HTTPError as exc:
      raise _RetryableDownloadError(f"下载失败：{exc}") from exc
  raise UpdateDownloadError("下载重定向次数过多")


def _download_candidates(
  client: httpx.Client,
  urls: Sequence[str],
  target: Path,
  expected_size: int,
  deadline: float,
  allowed_hosts: frozenset[str],
) -> None:
  last_error: UpdateDownloadError | None = None
  for index, url in enumerate(urls):
    try:
      _stream_to_file(client, url, target, expected_size, deadline, allowed_hosts)
      return
    except _RetryableDownloadError as exc:
      target.unlink(missing_ok=True)
      last_error = exc
      if index + 1 >= len(urls):
        break
      log.warning("后台运行时下载失败，尝试备用地址 %s（原因：%s）", urls[index + 1], exc)
  raise UpdateDownloadError(str(last_error) if last_error else "后台运行时下载失败")


def _stream_to_file(
  client: httpx.Client,
  url: str,
  target: Path,
  expected_size: int,
  deadline: float,
  allowed_hosts: frozenset[str],
) -> None:
  current = url
  for _ in range(MAX_REDIRECTS + 1):
    _ensure_deadline(deadline)
    _ensure_allowed(current, allowed_hosts)
    try:
      with client.stream("GET", current) as response:
        if response.status_code in REDIRECT_CODES:
          current = _redirect_target(current, response)
          continue
        response.raise_for_status()
        _write_response(response, target, expected_size, deadline)
        return
    except httpx.HTTPStatusError as exc:
      raise _status_error(exc) from exc
    except httpx.HTTPError as exc:
      raise _RetryableDownloadError(f"下载失败：{exc}") from exc
  raise UpdateDownloadError("下载重定向次数过多")


def _write_response(
  response: httpx.Response,
  target: Path,
  expected_size: int,
  deadline: float,
) -> None:
  if expected_size > MAX_ARCHIVE_SIZE:
    raise UpdateDownloadError("更新包超出大小上限")
  written = 0
  with target.open("wb") as handle:
    for chunk in response.iter_bytes(CHUNK_SIZE):
      _ensure_deadline(deadline)
      written += len(chunk)
      if written > expected_size:
        raise UpdateDownloadError("更新包大小超出清单")
      handle.write(chunk)
  if written != expected_size:
    raise UpdateDownloadError(f"更新包大小不符：{written} != {expected_size}")


def _verify_archive(path: Path, manifest: BackendUpdateManifest) -> None:
  if not path.is_file():
    raise UpdateDownloadError("更新包不存在")
  size = path.stat().st_size
  if size != manifest.size:
    raise UpdateDownloadError(f"更新包大小不符：{size} != {manifest.size}")
  if sha256_file(path) != manifest.sha256:
    raise UpdateDownloadError("更新包 SHA-256 校验失败")


def _redirect_target(base: str, response: httpx.Response) -> str:
  location = response.headers.get("location")
  if not location:
    raise UpdateDownloadError("下载重定向缺少 Location")
  return urljoin(base, location)


def _status_error(exc: httpx.HTTPStatusError) -> UpdateDownloadError:
  status = exc.response.status_code
  message = f"下载失败：HTTP {status}"
  if 400 <= status < 500:
    return UpdateDownloadError(message)
  return _RetryableDownloadError(message)


def _ensure_allowed(url: str, allowed_hosts: frozenset[str]) -> None:
  parsed = urlparse(url)
  if parsed.scheme != "https":
    raise UpdateDownloadError("更新地址必须使用 HTTPS")
  host = (parsed.hostname or "").lower()
  if host not in allowed_hosts:
    raise UpdateDownloadError(f"不允许的更新主机：{parsed.hostname}")


def _ensure_deadline(deadline: float) -> None:
  if time.monotonic() > deadline:
    raise _RetryableDownloadError("下载超时，已中止")
