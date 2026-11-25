"""更新计划与 PowerShell 替换脚本：备份、替换、健康检查、失败回滚。

后台退出前写入计划与固定模板脚本，由 detached PowerShell 在进程退出后
逐文件替换；`sona-ltk.exe` 最后替换，任一步失败恢复全部已替换文件。
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .manifest import BackendUpdateManifest, is_safe_manifest_path
from .script_template import SCRIPT_TEMPLATE

log = logging.getLogger(__name__)

PLAN_FILE = "sona-ltk-update.json"
SCRIPT_FILE = "sona-ltk-update.ps1"
ZIP_FILE = "sona-update.zip"
STAGING_DIR = "sona-update.new"
LOG_RELATIVE_PATH = Path("logs") / "update.log"
HEALTH_CHECK_SECONDS = 8
# 新版本启动后等替换脚本完成健康检查，再清理 *.old 备份
STARTUP_CLEANUP_DELAY_S = HEALTH_CHECK_SECONDS + 2


@dataclass(frozen=True)
class UpdatePlan:
  """一次待执行的运行时替换。"""

  pid: int
  target: Path
  staged: Path
  exe: str
  files: tuple[str, ...]
  log: Path
  # 旧进程的启动参数（如 --port / --token）。重启必须沿用它们，
  # 否则插件用自定义端口启动的后台会在替换后失联。
  args: tuple[str, ...] = field(default_factory=tuple)


def write_update_plan(plan: UpdatePlan, path: Path) -> None:
  """写入替换计划 JSON；文件名由后台构造，PowerShell 只读取这些字段。"""

  if plan.exe not in plan.files:
    raise ValueError("更新计划必须包含后台可执行文件")
  for relative in plan.files:
    if not is_safe_manifest_path(relative):
      raise ValueError(f"更新计划包含非法路径：{relative!r}")
  if any(not isinstance(item, str) for item in plan.args):
    raise ValueError("更新计划参数必须是字符串")

  payload = {
    "pid": plan.pid,
    "target": str(plan.target),
    "staged": str(plan.staged),
    "exe": plan.exe,
    "files": list(plan.files),
    "log": str(plan.log),
    "args": list(plan.args),
  }
  path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def render_update_script() -> str:
  """返回固定的 PowerShell 替换脚本模板。"""

  return SCRIPT_TEMPLATE.replace("__HEALTH_CHECK_SECONDS__", str(HEALTH_CHECK_SECONDS))


def write_update_script(project_root: Path) -> Path:
  # Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当作 ANSI；带 BOM 才能正确读取中文日志文案。
  script_path = project_root / SCRIPT_FILE
  script_path.write_text(render_update_script(), encoding="utf-8-sig", newline="\r\n")
  return script_path


def launch_update_script(project_root: Path) -> bool:
  """仅在 Windows 上以 detached 方式启动替换脚本。"""

  if sys.platform != "win32":
    return False
  script_path = project_root / SCRIPT_FILE
  if not script_path.is_file():
    raise FileNotFoundError(f"更新脚本不存在：{script_path}")

  creationflags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
    subprocess,
    "CREATE_NEW_PROCESS_GROUP",
    0,
  )
  subprocess.Popen(
    [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      str(script_path),
    ],
    cwd=str(project_root),
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
    creationflags=creationflags,
  )
  return True


def cleanup_stale_update_files(
  project_root: Path,
  manifest: BackendUpdateManifest | None = None,
) -> None:
  """启动成功后清理上一次更新留下的暂存、压缩包、计划、脚本与 `*.old`。

  先读残余计划 JSON 拿到文件列表，再按清单补充；删除失败只记录日志。
  """

  plan_path = project_root / PLAN_FILE
  candidates = set(_read_plan_files(plan_path))
  if manifest is not None:
    candidates.update(manifest.files)

  for relative in candidates:
    if not is_safe_manifest_path(relative):
      continue
    _unlink(project_root / Path(relative + ".old"))

  shutil.rmtree(project_root / STAGING_DIR, ignore_errors=True)
  _unlink(project_root / ZIP_FILE)
  _unlink(project_root / (ZIP_FILE + ".part"))
  _unlink(plan_path)
  _unlink(project_root / SCRIPT_FILE)


def _read_plan_files(plan_path: Path) -> tuple[str, ...]:
  try:
    payload = json.loads(plan_path.read_text(encoding="utf-8"))
  except (OSError, ValueError):
    return ()
  if not isinstance(payload, dict):
    return ()
  files = payload.get("files")
  if not isinstance(files, list):
    return ()
  return tuple(item for item in files if isinstance(item, str))


def _unlink(path: Path) -> None:
  try:
    path.unlink(missing_ok=True)
  except OSError as exc:
    log.warning("清理更新残留失败：%s（%s）", path, exc)
