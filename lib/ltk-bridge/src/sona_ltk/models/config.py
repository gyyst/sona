"""本地后台配置。"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

DEFAULT_SKIN_REPOSITORY_BASE_URL = "https://raw.githubusercontent.com/Alban1911/LeagueSkins/main"
DEFAULT_GITHUB_PROXY = "https://gh-proxy.org"
GITHUB_PROXY_PLACEHOLDER = "{url}"

# 旧默认源布局是 skins/<英雄英文名>/<皮肤名>.zip，与 SkinLibrary 期望的数字目录不匹配，加载时自动迁移。
LEGACY_SKIN_REPOSITORY_BASE_URLS = frozenset(
  {
    "https://raw.githubusercontent.com/darkseal-org/lol-skins/master",
    "https://raw.githubusercontent.com/darkseal-org/lol-skins/main",
  },
)


class BridgeConfig(BaseModel):
  """从 config.json 读取；字段使用 camelCase，与示例配置一致。"""

  model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

  websocket_port: int = Field(default=50010, ge=1024, le=65535)
  auth_token: str = Field(default="sona-local-bridge-v1", min_length=8, max_length=200)
  ltk_launcher_path: Path | None = None
  ltk_manager_path: Path | None = None
  ltk_manager_version: str | None = None
  ltk_manager_download_url: str | None = None
  ltk_manager_sha256: str | None = None
  ltk_manager_size: int | None = Field(default=None, gt=0, le=500_000_000)
  ltk_manager_download_timeout_s: float = Field(default=300.0, ge=30, le=3600)
  ltk_manager_install_timeout_s: float = Field(default=600.0, ge=30, le=3600)
  auto_start_ltk: bool = True
  lcu_lockfile_path: Path | None = None
  skin_library_mode: Literal["remote", "local"] = "remote"
  skin_library_root: Path | None = None
  skin_repository_base_url: str = DEFAULT_SKIN_REPOSITORY_BASE_URL
  github_proxy: str | None = DEFAULT_GITHUB_PROXY
  github_proxy_fallback: bool = True
  download_timeout_s: float = Field(default=120.0, gt=0, le=600)
  bridge_timeout_s: float = Field(default=30.0, gt=0, le=300)
  patcher_ready_timeout_s: float = Field(default=300.0, ge=30, le=900)
  log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

  @field_validator(
    "ltk_launcher_path",
    "ltk_manager_path",
    "lcu_lockfile_path",
    "skin_library_root",
    "ltk_manager_version",
    "ltk_manager_download_url",
    "ltk_manager_sha256",
    "ltk_manager_size",
    "github_proxy",
    mode="before",
  )
  @classmethod
  def empty_str_to_none(cls, value: object) -> object:
    """config.example.json 用空字符串表示“自动探测”或“使用内置默认值”。"""

    if isinstance(value, str) and not value.strip():
      return None
    return value

  @field_validator("ltk_manager_size", mode="before")
  @classmethod
  def zero_size_to_none(cls, value: object) -> object:
    if value == 0:
      return None
    return value

  @field_validator("ltk_manager_version")
  @classmethod
  def validate_manager_version(cls, value: str | None) -> str | None:
    if value is None:
      return None
    parts = value.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
      raise ValueError("ltkManagerVersion 必须形如 1.33.0")
    return value

  @field_validator("ltk_manager_download_url")
  @classmethod
  def validate_manager_url(cls, value: str | None) -> str | None:
    if value is None:
      return None
    if not value.startswith("https://"):
      raise ValueError("ltkManagerDownloadUrl 必须是 https:// 地址")
    return value

  @field_validator("ltk_manager_sha256")
  @classmethod
  def validate_manager_sha256(cls, value: str | None) -> str | None:
    if value is None:
      return None
    cleaned = value.strip().lower()
    if len(cleaned) != 64 or any(char not in "0123456789abcdef" for char in cleaned):
      raise ValueError("ltkManagerSha256 必须是 64 位十六进制")
    return cleaned

  @field_validator("github_proxy")
  @classmethod
  def validate_github_proxy(cls, value: str | None) -> str | None:
    """空值关闭代理；非空必须是可解析的 HTTPS 前缀或 {url} 模板。"""

    if value is None:
      return None
    cleaned = value.strip()
    if not cleaned:
      return None
    if any(char.isspace() for char in cleaned):
      raise ValueError("githubProxy 不能包含空白字符")
    if not cleaned.startswith("https://"):
      raise ValueError("githubProxy 必须是 https:// 地址")

    normalized = cleaned.rstrip("/")
    sample = normalized.replace(GITHUB_PROXY_PLACEHOLDER, "https://raw.githubusercontent.com/x")
    parsed = urlparse(sample)
    if parsed.scheme != "https" or not parsed.hostname:
      raise ValueError("githubProxy 必须是包含主机的 https:// 地址")
    return normalized

  @field_validator("skin_repository_base_url")
  @classmethod
  def validate_repository_url(cls, value: str) -> str:
    normalized = value.rstrip("/")
    if not normalized.startswith("https://"):
      raise ValueError("skinRepositoryBaseUrl 必须是 https:// 地址")
    if normalized in LEGACY_SKIN_REPOSITORY_BASE_URLS:
      return DEFAULT_SKIN_REPOSITORY_BASE_URL
    return normalized

  @field_validator("skin_library_root")
  @classmethod
  def validate_local_root(cls, value: Path | None) -> Path | None:
    return value.expanduser() if value else None


def load_config(path: Path | None = None) -> BridgeConfig:
  """读取 config.json；不存在时返回默认配置。

  源码运行读取 lib/ltk-bridge/config.json；PyInstaller 打包后读取 exe 旁的 config.json。
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
