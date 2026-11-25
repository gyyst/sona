"""Release zip 解压：只解压清单内的文件，拒绝符号链接与路径穿越。"""

from __future__ import annotations

import shutil
import stat
import zipfile
from pathlib import Path

from .manifest import (
  BackendUpdateManifest,
  ManifestFile,
  is_safe_manifest_path,
  sha256_file,
)

ARCHIVE_PREFIX = "sona/ltk/"
CHUNK_SIZE = 64 * 1024


class UpdateArchiveError(RuntimeError):
  """更新包结构、路径或逐文件校验失败。"""


def extract_runtime(archive_path: Path, manifest: BackendUpdateManifest, staging: Path) -> None:
  """把清单列出的运行时文件解压到 staging；任何失败都删除 staging。"""

  shutil.rmtree(staging, ignore_errors=True)
  staging.mkdir(parents=True, exist_ok=True)
  try:
    _extract(archive_path, manifest, staging)
  except UpdateArchiveError:
    shutil.rmtree(staging, ignore_errors=True)
    raise
  except (OSError, zipfile.BadZipFile) as exc:
    shutil.rmtree(staging, ignore_errors=True)
    raise UpdateArchiveError(f"解压后台更新包失败：{exc}") from exc


def _extract(archive_path: Path, manifest: BackendUpdateManifest, staging: Path) -> None:
  expected = set(manifest.files)
  extracted: set[str] = set()
  with zipfile.ZipFile(archive_path) as archive:
    for member in archive.infolist():
      if member.is_dir():
        continue
      name = member.filename
      if not name.startswith(ARCHIVE_PREFIX):
        # zip 里还有 index.js / assets 等非后台文件，一律不写入磁盘
        continue
      relative = name[len(ARCHIVE_PREFIX) :]
      if relative not in expected:
        continue
      if relative in extracted:
        raise UpdateArchiveError(f"更新包包含重复文件：{relative}")
      _extract_member(archive, member, relative, manifest.files[relative], staging)
      extracted.add(relative)

  missing = expected - extracted
  if missing:
    preview = ", ".join(sorted(missing)[:5])
    raise UpdateArchiveError(f"更新包缺少清单文件：{preview}")


def _extract_member(
  archive: zipfile.ZipFile,
  member: zipfile.ZipInfo,
  relative: str,
  expected: ManifestFile,
  staging: Path,
) -> None:
  if stat.S_ISLNK(member.external_attr >> 16):
    raise UpdateArchiveError(f"更新包包含符号链接：{relative}")
  if not is_safe_manifest_path(relative):
    raise UpdateArchiveError(f"更新包包含非法路径：{relative!r}")
  if member.file_size != expected.size:
    raise UpdateArchiveError(f"更新包文件大小与清单不符：{relative}")

  destination = staging / Path(relative)
  destination.parent.mkdir(parents=True, exist_ok=True)
  written = 0
  try:
    with archive.open(member) as source, destination.open("wb") as target:
      for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
        written += len(chunk)
        if written > expected.size:
          raise UpdateArchiveError(f"更新包文件超出清单大小：{relative}")
        target.write(chunk)
  except (OSError, zipfile.BadZipFile) as exc:
    raise UpdateArchiveError(f"写入更新文件失败：{relative}（{exc}）") from exc

  if written != expected.size:
    raise UpdateArchiveError(f"更新包文件大小不符：{relative}")
  if sha256_file(destination) != expected.sha256:
    raise UpdateArchiveError(f"更新包文件 SHA-256 校验失败：{relative}")
