"""入口：加载配置、初始化日志、运行后台服务。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from .logging_setup import setup_logging
from .models.config import load_config
from .runtime.service import BridgeService

PROJECT_ROOT = Path(__file__).resolve().parents[3]


async def _run() -> None:
  config = load_config()
  setup_logging(config, PROJECT_ROOT)
  service = BridgeService(config, PROJECT_ROOT)
  await service.run()


def main() -> None:
  try:
    asyncio.run(_run())
  except KeyboardInterrupt:
    pass


if __name__ == "__main__":
  main()
