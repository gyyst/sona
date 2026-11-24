"""下载 LTK Manager 官方安装包到插件目录，并校验完整性。"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from collections.abc import Callable
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
) -> Path:
  """下载到 `.part`，校验通过后原子替换目标文件。"""

  destination.parent.mkdir(parents=True, exist_ok=True)
  partial = destination.with_name(destination.name + ".part")
  partial.unlink(missing_ok=True)
  log.info("开始下载 LTK Manager 安装包：%s（%s 字节）", url, expected_size)

  owned_client = client is None
  http = client or httpx.Client(timeout=httpx.Timeout(timeout_s), follow_redirects=False)
  deadline = time.monotonic() + timeout_s
  try:
    _stream_to_file(http, url, partial, expected_size, on_progress, deadline)
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


def _stream_to_file(
  client: httpx.Client,
  url: str,
  target: Path,
  expected_size: int,
  on_progress: Callable[[int], None] | None,
  deadline: float,
) -> None:
  current = url
  for _ in range(MAX_REDIRECTS + 1):
    if time.monotonic() > deadline:
      raise ManagerDownloadError("下载超时，已中止")
    _ensure_allowed(current)
    try:
      with client.stream("GET", current) as response:
        if time.monotonic() > deadline:
          raise ManagerDownloadError("下载超时，已中止")
        if response.status_code in REDIRECT_CODES:
          location = response.headers.get("location")
          if not location:
            raise ManagerDownloadError("下载重定向缺少 Location")
          current = urljoin(current, location)
          continue
        response.raise_for_status()
        _write_response(response, target, expected_size, on_progress, deadline)
        return
    except httpx.HTTPError as exc:
      raise ManagerDownloadError(f"下载失败：{exc}") from exc
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
        raise ManagerDownloadError("下载超时，已中止")
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


def _ensure_allowed(url: str) -> None:
  parsed = urlparse(url)
  if parsed.scheme != "https":
    raise ManagerDownloadError("安装包地址必须使用 HTTPS")
  if parsed.hostname not in LTK_MANAGER_DOWNLOAD_HOSTS:
    raise ManagerDownloadError(f"不允许的下载主机：{parsed.hostname}")
