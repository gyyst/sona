"""后台运行时更新清单（发布到 dist 分支的 ltk.json）。

清单由发布流水线从 Release zip 生成；后台只信任通过格式校验的字段，
下载地址由客户端根据 `release` 自行构造。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

RELEASE_PATTERN = re.compile(r"^v\d+(?:\.\d+)+$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

MAX_FILES = 64
MAX_FILE_SIZE = 200 * 1024 * 1024
MAX_ARCHIVE_SIZE = 300 * 1024 * 1024
MAX_PATH_LENGTH = 300

EXECUTABLE_NAME = "sona-ltk.exe"
# 用户数据与冻结入口不在后台更新范围内；清单出现这些路径直接视为非法。
RESERVED_TOP_LEVEL = frozenset({"config.json", "logs", "data", "downloads"})

HASH_CHUNK_SIZE = 64 * 1024


class UpdateManifestError(RuntimeError):
  """清单无法读取、校验失败或缺少必需文件。"""


def is_safe_manifest_path(value: str) -> bool:
  """只接受相对 POSIX 路径：拒绝绝对路径、`..`、反斜杠、冒号与控制字符。"""

  if not value or len(value) > MAX_PATH_LENGTH:
    return False
  if value != value.strip():
    return False
  if any(ord(char) < 32 or ord(char) == 127 for char in value):
    return False
  if "\\" in value or ":" in value:
    return False
  if value.startswith("/"):
    return False
  parts = value.split("/")
  for part in parts:
    if part in {"", ".", ".."}:
      return False
    # Windows 会去掉路径段末尾的空格与点；`.. ` 等价于 `..`，必须按段拒绝。
    if part != part.strip() or part.endswith("."):
      return False
  # Windows 文件系统不区分大小写，保留路径也要按小写判断。
  return parts[0].lower() not in RESERVED_TOP_LEVEL


class ManifestFile(BaseModel):
  """清单中的一个运行时文件。"""

  model_config = ConfigDict(extra="ignore")

  sha256: str
  size: int = Field(ge=0, le=MAX_FILE_SIZE)

  @field_validator("sha256")
  @classmethod
  def _normalize_sha256(cls, value: str) -> str:
    cleaned = value.strip().lower()
    if not SHA256_PATTERN.fullmatch(cleaned):
      raise ValueError("sha256 必须是 64 位小写十六进制")
    return cleaned


class BackendUpdateManifest(BaseModel):
  """`ltk.json` 的完整内容。"""

  model_config = ConfigDict(extra="ignore")

  release: str
  sha256: str
  size: int = Field(gt=0, le=MAX_ARCHIVE_SIZE)
  files: dict[str, ManifestFile]

  @field_validator("release")
  @classmethod
  def _validate_release(cls, value: str) -> str:
    if not RELEASE_PATTERN.fullmatch(value):
      raise ValueError("release 必须形如 v2026.11.25.8")
    return value

  @field_validator("sha256")
  @classmethod
  def _normalize_sha256(cls, value: str) -> str:
    cleaned = value.strip().lower()
    if not SHA256_PATTERN.fullmatch(cleaned):
      raise ValueError("zip sha256 必须是 64 位小写十六进制")
    return cleaned

  @field_validator("files")
  @classmethod
  def _validate_files(cls, value: dict[str, ManifestFile]) -> dict[str, ManifestFile]:
    if not value:
      raise ValueError("更新清单不能为空")
    if len(value) > MAX_FILES:
      raise ValueError(f"更新清单文件数量超过上限 {MAX_FILES}")
    for relative in value:
      if not is_safe_manifest_path(relative):
        raise ValueError(f"更新清单包含非法路径：{relative!r}")
    return value


@dataclass(frozen=True)
class LocalComparison:
  """本地目录与清单的比较结果。"""

  matches: bool
  missing: tuple[str, ...]
  mismatched: tuple[str, ...]


def sha256_file(path: Path) -> str:
  digest = hashlib.sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(HASH_CHUNK_SIZE), b""):
      digest.update(chunk)
  return digest.hexdigest()


def compare_local_files(root: Path, manifest: BackendUpdateManifest) -> LocalComparison:
  """逐文件比较大小与 SHA-256；缺失或内容不符都视为需要更新。"""

  missing: list[str] = []
  mismatched: list[str] = []
  for relative, expected in manifest.files.items():
    path = root / Path(relative)
    if not path.is_file():
      missing.append(relative)
      continue
    if path.stat().st_size != expected.size or sha256_file(path) != expected.sha256:
      mismatched.append(relative)
  return LocalComparison(
    matches=not missing and not mismatched,
    missing=tuple(missing),
    mismatched=tuple(mismatched),
  )


def runtime_files(manifest: BackendUpdateManifest) -> tuple[str, ...]:
  """替换顺序：其余文件在前，`sona-ltk.exe` 最后（失败时旧 exe 仍可启动）。"""

  if EXECUTABLE_NAME not in manifest.files:
    raise UpdateManifestError(f"更新清单缺少 {EXECUTABLE_NAME}")
  return tuple(name for name in manifest.files if name != EXECUTABLE_NAME) + (EXECUTABLE_NAME,)
