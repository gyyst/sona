"""本地后台配置。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class BridgeConfig(BaseModel):
  """从 config.json 读取；字段使用 camelCase，与示例配置一致。"""

  model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

  websocket_port: int = Field(default=50010, ge=1024, le=65535)
  auth_token: str = Field(default="sona-local-bridge-v1", min_length=8, max_length=200)
  ltk_launcher_path: Path | None = None
  ltk_manager_path: Path | None = None
  auto_start_ltk: bool = True
  lcu_lockfile_path: Path | None = None
  skin_library_mode: Literal["remote", "local"] = "remote"
  skin_library_root: Path | None = None
  skin_repository_base_url: str = "https://raw.githubusercontent.com/darkseal-org/lol-skins/master"
  download_timeout_s: float = Field(default=120.0, gt=0, le=600)
  bridge_timeout_s: float = Field(default=30.0, gt=0, le=300)
  log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

  @field_validator(
    "ltk_launcher_path",
    "ltk_manager_path",
    "lcu_lockfile_path",
    "skin_library_root",
    mode="before",
  )
  @classmethod
  def empty_path_to_none(cls, value: object) -> object:
    """config.example.json 用空字符串表示“自动探测”。"""

    if isinstance(value, str) and not value.strip():
      return None
    return value

  @field_validator("skin_repository_base_url")
  @classmethod
  def validate_repository_url(cls, value: str) -> str:
    normalized = value.rstrip("/")
    if not normalized.startswith("https://"):
      raise ValueError("skinRepositoryBaseUrl 必须是 https:// 地址")
    return normalized

  @field_validator("skin_library_root")
  @classmethod
  def validate_local_root(cls, value: Path | None) -> Path | None:
    return value.expanduser() if value else None


def load_config(path: Path | None = None) -> BridgeConfig:
  """读取 config.json；不存在时返回默认配置。

  源码运行读取 ltk-bridge/config.json；PyInstaller 打包后读取 exe 旁的 config.json。
  """

  if path is not None:
    config_path = path
  elif getattr(sys, "frozen", False):
    config_path = Path(sys.executable).resolve().parent / "config.json"
  else:
    config_path = Path(__file__).resolve().parents[3] / "config.json"

  if not config_path.is_file():
    return BridgeConfig()
  return BridgeConfig.model_validate_json(config_path.read_text(encoding="utf-8"))
