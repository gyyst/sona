"""下载 LTK Manager 官方安装包到插件目录，并校验完整性。"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx

log = logging.getLogger(__name__)

REDIRECT_CODES = {301, 302, 303, 307, 308}
CHUNK_SIZE = 64 * 1024
MAX_SIZE_RATIO = 1.1
MAX_REDIRECTS = 5

# 安装包可能被 GitHub 重定向到对象存储；只允许这些主机。
LTK_MANAGER_DOWNLOAD_HOSTS = frozenset(
  {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
  },
)


class ManagerDownloadError(RuntimeError):
  """下载、写入或校验安装包失败。"""


class _RetryableDownloadError(ManagerDownloadError):
  """代理或网络类失败，可以换下一个候选地址重试。"""


def sha256_file(path: Path) -> str:
  digest = hashlib.sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
      digest.update(chunk)
  return digest.hexdigest()


def verify_installer(path: Path, expected_sha256: str, expected_size: int) -> None:
  """大小与 SHA-256 必须完全匹配；失败时抛错，由调用方决定是否删除。"""

  if not path.is_file():
    raise ManagerDownloadError("安装包不存在")
  size = path.stat().st_size
  if size != expected_size:
    raise ManagerDownloadError(f"安装包大小不符：{size} != {expected_size}")
  actual = sha256_file(path)
  if actual != expected_sha256.lower():
    raise ManagerDownloadError("安装包 SHA-256 校验失败")


def download_installer(
  url: str,
  destination: Path,
  expected_sha256: str,
  expected_size: int,
  *,
  timeout_s: float,
  on_progress: Callable[[int], None] | None = None,
  client: httpx.Client | None = None,
  fallback_urls: Sequence[str] = (),
  extra_allowed_hosts: frozenset[str] = frozenset(),
) -> Path:
  """下载到 `.part`，校验通过后原子替换目标文件。

  `fallback_urls` 用于代理失败时回退直连；`extra_allowed_hosts` 只应包含
  用户显式配置的代理主机，不能接受重定向返回的主机。
  """

  destination.parent.mkdir(parents=True, exist_ok=True)
  partial = destination.with_name(destination.name + ".part")
  partial.unlink(missing_ok=True)
  urls = [url, *fallback_urls]
  log.info("开始下载 LTK Manager 安装包：%s（%s 字节）", urls[0], expected_size)

  owned_client = client is None
  http = client or httpx.Client(timeout=httpx.Timeout(timeout_s), follow_redirects=False)
  deadline = time.monotonic() + timeout_s
  try:
    _download_candidates(
      http,
      urls,
      partial,
      expected_size,
      on_progress,
      deadline,
      extra_allowed_hosts,
    )
    verify_installer(partial, expected_sha256, expected_size)
  except ManagerDownloadError:
    partial.unlink(missing_ok=True)
    raise
  except OSError as exc:
    partial.unlink(missing_ok=True)
    raise ManagerDownloadError(f"写入安装包失败：{exc}") from exc
  finally:
    if owned_client:
      http.close()

  os.replace(partial, destination)
  log.info(
    "LTK Manager 安装包下载并校验通过：%s（sha256=%s…）",
    destination,
    expected_sha256[:12],
  )
  return destination


def _download_candidates(
  client: httpx.Client,
  urls: Sequence[str],
  target: Path,
  expected_size: int,
  on_progress: Callable[[int], None] | None,
  deadline: float,
  extra_allowed_hosts: frozenset[str],
) -> None:
  last_error: _RetryableDownloadError | None = None
  for index, url in enumerate(urls):
    try:
      _stream_to_file(
        client,
        url,
        target,
        expected_size,
        on_progress,
        deadline,
        extra_allowed_hosts,
      )
      log.info("安装包下载完成：%s", url)
      return
    except _RetryableDownloadError as exc:
      target.unlink(missing_ok=True)
      last_error = exc
      if index + 1 >= len(urls):
        break
      log.warning("下载失败，尝试备用地址 %s（原因：%s）", urls[index + 1], exc)
      if on_progress is not None:
        on_progress(0)

  if last_error is not None:
    raise ManagerDownloadError(str(last_error)) from last_error
  raise ManagerDownloadError("下载失败")


def _stream_to_file(
  client: httpx.Client,
  url: str,
  target: Path,
  expected_size: int,
  on_progress: Callable[[int], None] | None,
  deadline: float,
  extra_allowed_hosts: frozenset[str] = frozenset(),
) -> None:
  current = url
  for _ in range(MAX_REDIRECTS + 1):
    if time.monotonic() > deadline:
      raise _RetryableDownloadError("下载超时，已中止")
    _ensure_allowed(current, extra_allowed_hosts)
    try:
      with client.stream("GET", current) as response:
        if time.monotonic() > deadline:
          raise _RetryableDownloadError("下载超时，已中止")
        if response.status_code in REDIRECT_CODES:
          location = response.headers.get("location")
          if not location:
            raise ManagerDownloadError("下载重定向缺少 Location")
          current = urljoin(current, location)
          continue
        response.raise_for_status()
        _write_response(response, target, expected_size, on_progress, deadline)
        return
    except httpx.HTTPStatusError as exc:
      if 400 <= exc.response.status_code < 500:
        raise ManagerDownloadError(f"下载失败：{exc}") from exc
      raise _RetryableDownloadError(f"下载失败：{exc}") from exc
    except httpx.HTTPError as exc:
      raise _RetryableDownloadError(f"下载失败：{exc}") from exc
  raise ManagerDownloadError("下载重定向次数过多")


def _write_response(
  response: httpx.Response,
  target: Path,
  expected_size: int,
  on_progress: Callable[[int], None] | None,
  deadline: float,
) -> None:
  max_size = int(expected_size * MAX_SIZE_RATIO)
  written = 0
  with target.open("wb") as handle:
    for chunk in response.iter_bytes(CHUNK_SIZE):
      if time.monotonic() > deadline:
        raise _RetryableDownloadError("下载超时，已中止")
      written += len(chunk)
      if written > max_size:
        raise ManagerDownloadError("安装包大小超出预期，已中止下载")
      handle.write(chunk)
      if on_progress is not None:
        on_progress(min(99, int(written * 100 / expected_size)))
  if written != expected_size:
    raise ManagerDownloadError(f"安装包大小不符：{written} != {expected_size}")
  if on_progress is not None:
    on_progress(100)


def _ensure_allowed(url: str, extra_allowed_hosts: frozenset[str] = frozenset()) -> None:
  parsed = urlparse(url)
  if parsed.scheme != "https":
    raise ManagerDownloadError("安装包地址必须使用 HTTPS")
  host = (parsed.hostname or "").lower()
  if host in LTK_MANAGER_DOWNLOAD_HOSTS or host in extra_allowed_hosts:
    return
  # 代理主机不合法时允许回退直连；由调用方保证 extra 只来自用户配置。
  raise _RetryableDownloadError(f"不允许的下载主机：{parsed.hostname}")
