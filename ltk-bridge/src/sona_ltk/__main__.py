"""入口：加载配置、初始化日志、运行后台服务。"""

from __future__ import annotations

import argparse
import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path

from .logging_setup import setup_logging
from .models.config import BridgeConfig, load_config
from .runtime.service import BridgeService


@dataclass(frozen=True)
class CliOptions:
  config: Path | None
  port: int | None
  token: str | None


def _project_root() -> Path:
  """源码运行使用仓库内的 ltk-bridge；PyInstaller 打包后使用 exe 所在目录。"""

  if getattr(sys, "frozen", False):
    return Path(sys.executable).resolve().parent
  return Path(__file__).resolve().parents[3]


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


async def _run(argv: list[str]) -> None:
  options = _parse_options(argv)
  config = _apply_options(load_config(options.config), options)
  project_root = _project_root()
  setup_logging(config, project_root)
  service = BridgeService(config, project_root)
  await service.run()


def main(argv: list[str] | None = None) -> None:
  try:
    asyncio.run(_run(sys.argv[1:] if argv is None else argv))
  except KeyboardInterrupt:
    pass


if __name__ == "__main__":
  main()
