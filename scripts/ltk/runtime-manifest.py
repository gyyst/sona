#!/usr/bin/env python3
"""生成后台运行时更新清单 ltk.json（纯标准库，供发布流水线使用）。

用法：
  python3 scripts/ltk/runtime-manifest.py <release-zip> <release-tag> <output-json>

清单列出 `sona/ltk/` 下全部程序文件的大小与 SHA-256，以及 Release zip 的
整体大小与 SHA-256；`sona-ltk.exe` 排在最后，替换脚本最后替换它。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

ARCHIVE_PREFIX = "sona/ltk/"
EXECUTABLE_NAME = "sona-ltk.exe"
EXCLUDED_TOP_LEVEL = frozenset({"config.json", "logs", "data", "downloads"})

MAX_FILES = 64
MAX_FILE_SIZE = 200 * 1024 * 1024
MAX_ARCHIVE_SIZE = 300 * 1024 * 1024
MAX_PATH_LENGTH = 300

RELEASE_PATTERN = re.compile(r"^v\d+(?:\.\d+)+$")
CHUNK_SIZE = 64 * 1024


class ManifestError(RuntimeError):
  """Release zip 或参数不满足清单契约。"""


def is_safe_relative_path(value: str) -> bool:
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
    # Windows 会去掉路径段末尾的空格与点；生成清单时就要拒绝，避免消费端误解。
    if part != part.strip() or part.endswith("."):
      return False
  return parts[0].lower() not in EXCLUDED_TOP_LEVEL


def sha256_file(path: Path) -> str:
  digest = hashlib.sha256()
  with path.open("rb") as handle:
    for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
      digest.update(chunk)
  return digest.hexdigest()


def hash_member(archive: zipfile.ZipFile, member: zipfile.ZipInfo) -> str:
  digest = hashlib.sha256()
  written = 0
  with archive.open(member) as source:
    for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
      written += len(chunk)
      if written > member.file_size:
        raise ManifestError(f"zip 成员大小异常：{member.filename}")
      digest.update(chunk)
  if written != member.file_size:
    raise ManifestError(f"zip 成员读取不完整：{member.filename}")
  return digest.hexdigest()


def collect_files(archive: zipfile.ZipFile) -> dict[str, dict[str, object]]:
  files: dict[str, dict[str, object]] = {}
  for member in archive.infolist():
    if member.is_dir():
      continue
    name = member.filename
    if not name.startswith(ARCHIVE_PREFIX):
      continue
    relative = name[len(ARCHIVE_PREFIX) :]
    if not relative:
      continue
    parts = relative.split("/")
    # 用户数据与冻结入口由发布包提供或运行时生成，不进入后台更新清单
    if relative.lower() == "config.json" or parts[0].lower() in {"logs", "data", "downloads"}:
      continue
    if not is_safe_relative_path(relative):
      raise ManifestError(f"zip 包含非法路径：{relative!r}")
    if relative in files:
      raise ManifestError(f"zip 包含重复文件：{relative}")
    if member.file_size > MAX_FILE_SIZE:
      raise ManifestError(f"文件超过 200 MB：{relative}")
    files[relative] = {"sha256": hash_member(archive, member), "size": member.file_size}

  if not files:
    raise ManifestError("zip 中没有 sona/ltk/ 运行时文件")
  if len(files) > MAX_FILES:
    raise ManifestError(f"文件数量超过上限 {MAX_FILES}")
  if EXECUTABLE_NAME not in files:
    raise ManifestError(f"zip 中缺少 {EXECUTABLE_NAME}")
  return files


def build_manifest(zip_path: Path, release: str) -> dict[str, object]:
  if not RELEASE_PATTERN.fullmatch(release):
    raise ManifestError(f"release 必须形如 v2026.11.25.8：{release!r}")
  if not zip_path.is_file():
    raise ManifestError(f"Release zip 不存在：{zip_path}")
  size = zip_path.stat().st_size
  if size <= 0 or size > MAX_ARCHIVE_SIZE:
    raise ManifestError(f"Release zip 大小非法：{size}")

  with zipfile.ZipFile(zip_path) as archive:
    collected = collect_files(archive)

  # 其余文件按名称排序保证可重复；exe 最后替换，失败时旧 exe 仍可启动。
  ordered = {name: collected[name] for name in sorted(collected) if name != EXECUTABLE_NAME}
  ordered[EXECUTABLE_NAME] = collected[EXECUTABLE_NAME]

  return {
    "release": release,
    "sha256": sha256_file(zip_path),
    "size": size,
    "files": ordered,
  }


def write_manifest(manifest: dict[str, object], output: Path) -> None:
  output.parent.mkdir(parents=True, exist_ok=True)
  output.write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
  )


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(description="生成后台运行时更新清单 ltk.json")
  parser.add_argument("zip", type=Path, help="Release zip 路径")
  parser.add_argument("release", help="发布 tag，例如 v2026.11.25.8")
  parser.add_argument("output", type=Path, help="输出 ltk.json 路径")
  args = parser.parse_args(argv)

  try:
    manifest = build_manifest(args.zip, args.release)
  except (ManifestError, OSError, zipfile.BadZipFile) as exc:
    print(f"生成 ltk.json 失败：{exc}", file=sys.stderr)
    return 1

  write_manifest(manifest, args.output)
  files = manifest["files"]
  count = len(files) if isinstance(files, dict) else 0
  print(f"ltk.json 已生成：{args.output}（{count} 个运行时文件）")
  return 0


if __name__ == "__main__":
  sys.exit(main())
