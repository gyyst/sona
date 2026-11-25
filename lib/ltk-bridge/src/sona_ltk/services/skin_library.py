"""皮肤资源库：按 championId / skinId / chromaId 定位、下载与校验。"""

from __future__ import annotations

import hashlib
import logging
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..models.config import BridgeConfig
from ..models.events import SkinSelection
from .github_proxy import proxy_candidates

MAX_ARCHIVE_BYTES = 500 * 1024 * 1024

log = logging.getLogger(__name__)


class SkinLibraryError(RuntimeError):
  """资源不存在、下载失败或归档损坏。"""


class UnsupportedFormError(SkinLibraryError):
  """第一版桥接不支持特殊形态资源。"""


@dataclass(frozen=True)
class SkinArchive:
  path: Path
  champion_id: int
  skin_id: int
  chroma_id: int | None
  sha256: str


class SkinLibrary:
  """远程 LeagueSkins 资源库 + 本地缓存；也支持完全离线模式。"""

  def __init__(self, config: BridgeConfig, cache_root: Path) -> None:
    self._config = config
    self._cache_root = cache_root
    if config.skin_library_mode == "local" and config.skin_library_root is None:
      raise SkinLibraryError("本地皮肤库模式必须配置 skinLibraryRoot")

  def resolve(self, selection: SkinSelection) -> SkinArchive:
    if selection.form_id is not None:
      raise UnsupportedFormError("特殊形态资源暂未接入，请先选择普通皮肤或炫彩")

    target_id = selection.chroma_id or selection.skin_id
    root = self._cache_root if self._config.skin_library_mode == "remote" else self._config.skin_library_root
    if root is None:
      raise SkinLibraryError("皮肤库根目录不可用")

    relative_dir = self._relative_dir(selection.champion_id, selection.base_skin_id, selection.chroma_id)
    for suffix in (".zip", ".fantome"):
      path = root / relative_dir / f"{target_id}{suffix}"
      if path.is_file():
        return self._validate(path, selection, target_id)

    if self._config.skin_library_mode == "local":
      raise SkinLibraryError(f"本地皮肤库缺少 {relative_dir}/{target_id}.zip（或 .fantome）")

    for suffix in (".zip", ".fantome"):
      path = self._cache_root / relative_dir / f"{target_id}{suffix}"
      url = self._remote_url(relative_dir, target_id, suffix)
      candidates = proxy_candidates(
        url,
        self._config.github_proxy,
        self._config.github_proxy_fallback,
      )
      if self._download(candidates, path):
        return self._validate(path, selection, target_id)

    raise SkinLibraryError(f"皮肤资源不存在：champion={selection.champion_id} skin={target_id}")

  def _relative_dir(
    self,
    champion_id: int,
    base_skin_id: int,
    chroma_id: int | None,
  ) -> Path:
    root = Path(str(champion_id)) / str(base_skin_id)
    return root / str(chroma_id) if chroma_id is not None else root

  def _remote_url(self, relative_dir: Path, target_id: int, suffix: str) -> str:
    return f"{self._config.skin_repository_base_url}/skins/{relative_dir.as_posix()}/{target_id}{suffix}"

  def _download(self, urls: Sequence[str], destination: Path) -> bool:
    """依次尝试候选地址；404 表示资源不存在，其余失败换下一个候选。"""

    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    last_error: SkinLibraryError | None = None
    for index, url in enumerate(urls):
      try:
        with httpx.stream(
          "GET",
          url,
          follow_redirects=True,
          timeout=self._config.download_timeout_s,
        ) as response:
          if response.status_code == 404:
            return False
          response.raise_for_status()
          content_length = int(response.headers.get("content-length", "0"))
          if content_length > MAX_ARCHIVE_BYTES:
            raise SkinLibraryError(f"皮肤资源超过 {MAX_ARCHIVE_BYTES} 字节上限")
          with partial.open("wb") as handle:
            for chunk in response.iter_bytes(chunk_size=1024 * 1024):
              handle.write(chunk)
              if partial.stat().st_size > MAX_ARCHIVE_BYTES:
                raise SkinLibraryError(f"皮肤资源超过 {MAX_ARCHIVE_BYTES} 字节上限")
        partial.replace(destination)
        log.info("皮肤资源下载完成：%s", url)
        return True
      except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
          return False
        last_error = SkinLibraryError(f"下载皮肤失败 {exc.response.status_code}: {url}")
      except httpx.HTTPError as exc:
        last_error = SkinLibraryError(f"下载皮肤失败: {url}: {exc}")
      finally:
        partial.unlink(missing_ok=True)

      if index + 1 < len(urls):
        log.warning("下载失败，尝试备用地址 %s（原因：%s）", urls[index + 1], last_error)

    if last_error is not None:
      raise last_error
    return False

  def _validate(self, path: Path, selection: SkinSelection, target_id: int) -> SkinArchive:
    try:
      if not zipfile.is_zipfile(path):
        raise SkinLibraryError(f"皮肤归档损坏: {path}")
      digest = hashlib.sha256()
      with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
          digest.update(chunk)
    except OSError as exc:
      raise SkinLibraryError(f"无法读取皮肤归档: {path}: {exc}") from exc

    return SkinArchive(
      path=path,
      champion_id=selection.champion_id,
      skin_id=target_id,
      chroma_id=selection.chroma_id,
      sha256=digest.hexdigest(),
    )
