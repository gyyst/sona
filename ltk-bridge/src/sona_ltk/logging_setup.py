"""日志：控制台 + 项目根 logs/sona-ltk.log。"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .models.config import BridgeConfig


def setup_logging(config: BridgeConfig, project_root: Path) -> None:
  log_dir = project_root / "logs"
  log_dir.mkdir(parents=True, exist_ok=True)

  formatter = logging.Formatter(
    "%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
  )
  file_handler = RotatingFileHandler(
    log_dir / "sona-ltk.log",
    maxBytes=5 * 1024 * 1024,
    backupCount=3,
    encoding="utf-8",
  )
  file_handler.setFormatter(formatter)

  console_handler = logging.StreamHandler()
  console_handler.setFormatter(formatter)

  root = logging.getLogger()
  root.setLevel(config.log_level)
  root.handlers.clear()
  root.addHandler(file_handler)
  root.addHandler(console_handler)
