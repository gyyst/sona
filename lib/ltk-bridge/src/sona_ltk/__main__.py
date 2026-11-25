"""入口：加载配置、初始化日志、运行后台服务。"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .logging_setup import setup_logging
from .models.config import BridgeConfig, load_config
from .runtime.self_update import SKIP_ENV_NAME
from .runtime.service import BridgeService
from .services.update.script import (
  PLAN_FILE,
  UpdatePlan,
  launch_update_script,
  write_update_plan,
  write_update_script,
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CliOptions:
  config: Path | None
  port: int | None
  token: str | None


def _project_root() -> Path:
  """源码运行使用仓库根目录（logs/、data/）；PyInstaller 打包后使用 exe 所在目录。"""

  if getattr(sys, "frozen", False):
    return Path(sys.executable).resolve().parent
  # lib/ltk-bridge/src/sona_ltk/__main__.py 向上 4 层为仓库根目录
  return Path(__file__).resolve().parents[4]


def _parse_options(argv: list[str]) -> CliOptions:
  parser = argparse.ArgumentParser(
    prog="sona-ltk",
    description="Sona 选人换肤的 LTK Manager 本地桥接后台",
  )
  parser.add_argument("--config", type=Path, default=None, help="config.json 路径")
  parser.add_argument("--port", type=int, default=None, help="WebSocket 端口")
  parser.add_argument("--token", default=None, help="认证 token")
  args = parser.parse_args(argv)
  return CliOptions(config=args.config, port=args.port, token=args.token)


def _apply_options(config: BridgeConfig, options: CliOptions) -> BridgeConfig:
  """命令行参数覆盖配置文件，并重新走一遍 Pydantic 校验。"""

  data = config.model_dump()
  if options.port is not None:
    data["websocket_port"] = options.port
  if options.token:
    data["auth_token"] = options.token
  return BridgeConfig.model_validate(data)


async def _run(argv: list[str]) -> UpdatePlan | None:
  options = _parse_options(argv)
  config = _apply_options(load_config(options.config), options)
  project_root = _project_root()
  setup_logging(config, project_root)
  service = BridgeService(config, project_root)
  return await service.run()


def _launch_pending_update(plan: UpdatePlan | None, project_root: Path) -> None:
  """主循环因自更新退出后，写入计划并 detached 启动替换脚本。"""

  if plan is None:
    return
  launched = False
  try:
    write_update_plan(plan, project_root / PLAN_FILE)
    write_update_script(project_root)
    launched = launch_update_script(project_root)
  except (OSError, ValueError):
    log.exception("写入后台更新计划失败，保留旧版本")

  if launched:
    return
  # 替换脚本没能启动时不能把后台留在停止状态；直接拉起旧版本，更新下个周期重试。
  try:
    _restart_without_update(plan)
  except OSError:
    log.exception("启动替换脚本失败且无法重启后台，请在 Sona 中重新启动后台")


def _restart_without_update(plan: UpdatePlan) -> None:
  if not getattr(sys, "frozen", False):
    return
  creationflags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(
    subprocess,
    "CREATE_NEW_PROCESS_GROUP",
    0,
  )
  subprocess.Popen(
    [sys.executable, *plan.args],
    cwd=str(plan.target),
    env={**os.environ, SKIP_ENV_NAME: "1"},
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
    close_fds=True,
    creationflags=creationflags,
  )


def main(argv: list[str] | None = None) -> None:
  project_root = _project_root()
  try:
    plan = asyncio.run(_run(sys.argv[1:] if argv is None else argv))
  except KeyboardInterrupt:
    return
  _launch_pending_update(plan, project_root)


if __name__ == "__main__":
  main()
