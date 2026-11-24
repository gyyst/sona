"""启动 / 连接 LTK Manager 与 LTF bridge。"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import psutil

from ..models.config import BridgeConfig
from .bridge_client import BridgeCommandError, BridgeUnavailable, LtkBridge
from .bridge_discovery import discover_bridge

LTF_LAUNCHER = "ltk_launcher.exe"
LTF_BRIDGE_DLL = "LeagueToolFlop.dll"
LTK_MANAGER_NAMES = ("ltk-manager.exe", "ltk manager.exe")


class LauncherError(RuntimeError):
  """LTK Manager 或 LTF launcher 不可用。"""


@dataclass(frozen=True)
class LtkSession:
  bridge: LtkBridge
  launched_by_us: bool
  manager_pid: int | None


def ensure_ltk_session(config: BridgeConfig, log_dir: Path) -> LtkSession:
  """优先连接已有 bridge；否则通过 launcher 启动 LTK Manager。"""

  existing = discover_bridge()
  if existing is not None:
    return LtkSession(LtkBridge(existing), False, existing.hello.pid)
  if not config.auto_start_ltk:
    raise LauncherError("LTK bridge 未运行，且 autoStartLtk=false")

  launcher = config.ltk_launcher_path or _default_launcher()
  manager = config.ltk_manager_path or _find_ltk_manager()
  if launcher is None or not launcher.is_file():
    raise LauncherError(f"缺少 {LTF_LAUNCHER}，请先按文档构建 LTF bridge")
  if not (launcher.parent / LTF_BRIDGE_DLL).is_file():
    raise LauncherError(f"{LTF_LAUNCHER} 旁缺少 {LTF_BRIDGE_DLL}")
  if manager is None or not manager.is_file():
    raise LauncherError("未找到 LTK Manager，请配置 ltkManagerPath")

  log_dir.mkdir(parents=True, exist_ok=True)
  command = [str(launcher), "--exe", str(manager), "--quiet", "--log-dir", str(log_dir)]
  creation_flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
  try:
    result = subprocess.run(
      command,
      cwd=launcher.parent,
      check=False,
      capture_output=True,
      text=True,
      encoding="utf-8",
      errors="replace",
      timeout=60,
      creationflags=creation_flags,
    )
  except (OSError, subprocess.SubprocessError) as exc:
    raise LauncherError(f"启动 LTF launcher 失败: {exc}") from exc

  if result.returncode == 5:
    raise LauncherError("LTK Manager 已打开但没有 LTF bridge，请关闭后重试")
  if result.returncode != 0:
    raise LauncherError(f"LTF launcher 退出码 {result.returncode}: {result.stderr.strip()}")

  match = re.search(r"LTK_MANAGER_PID=(\d+)", result.stdout or "")
  expected_pid = int(match.group(1)) if match else None
  deadline = time.monotonic() + config.bridge_timeout_s
  while time.monotonic() < deadline:
    endpoint = discover_bridge(expected_pid)
    if endpoint is not None:
      return LtkSession(LtkBridge(endpoint), True, endpoint.hello.pid)
    time.sleep(0.25)
  raise LauncherError("LTK Manager 已启动，但 LTKBridge 未在超时内就绪")


def close_ltk_session(session: LtkSession) -> None:
  """停止 patcher；仅关闭由本后台启动的 LTK Manager。"""

  try:
    session.bridge.stop_patcher()
  except (BridgeUnavailable, BridgeCommandError):
    pass
  if session.launched_by_us:
    session.bridge.kill()


def _default_launcher() -> Path:
  """源码运行使用 ltk-bridge/native/ltf/bin；打包后与 sona-ltk.exe 同目录。"""

  if getattr(sys, "frozen", False):
    return Path(sys.executable).resolve().parent / LTF_LAUNCHER
  return Path(__file__).resolve().parents[3] / "native" / "ltf" / "bin" / LTF_LAUNCHER


def _find_ltk_manager() -> Path | None:
  configured = os.environ.get("SONA_LTK_MANAGER")
  if configured and Path(configured).is_file():
    return Path(configured)

  for process in psutil.process_iter(["name", "exe"]):
    if (process.info.get("name") or "").lower() in LTK_MANAGER_NAMES:
      executable = process.info.get("exe")
      if executable and Path(executable).is_file():
        return Path(executable)

  bases = [
    os.environ.get("ProgramW6432"),
    os.environ.get("ProgramFiles"),
    os.environ.get("LOCALAPPDATA"),
  ]
  for base in bases:
    if not base:
      continue
    for folder in ("LTK Manager", "League Toolkit Manager"):
      for name in LTK_MANAGER_NAMES:
        candidate = Path(base) / folder / name
        if candidate.is_file():
          return candidate
  return None
