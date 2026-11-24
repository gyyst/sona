"""客户端 → 后台的 WebSocket 消息。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter

from .base import ApiModel
from .ltk_manager import ManagerInstallStatus


class AuthMessage(ApiModel):
  """连接认证消息；认证通过前后台拒绝其他消息。"""

  type: Literal["auth"] = "auth"
  token: str = Field(min_length=8, max_length=200)


class SkinSelection(ApiModel):
  """一次皮肤 / 炫彩 / 形态选择。"""

  type: Literal["skin-selection"] = "skin-selection"
  champion_id: int = Field(gt=0, le=10000)
  skin_id: int = Field(gt=0)
  base_skin_id: int = Field(gt=0)
  chroma_id: int | None = Field(default=None, gt=0)
  form_id: int | None = Field(default=None, gt=0)
  skin_name: str = Field(min_length=1, max_length=200)
  owned: bool
  source: Literal["manual", "remembered", "random"]
  timestamp_ms: int = Field(ge=0)


class InstallLtkManager(ApiModel):
  """请求后台下载并安装 LTK Manager（安装位置由官方安装器决定）。"""

  type: Literal["install-ltk-manager"] = "install-ltk-manager"


class ServerStatus(ApiModel):
  """后台 → 客户端的运行状态。"""

  type: Literal["status"] = "status"
  phase: str
  injection_status: str
  message: str
  skin_name: str | None = None
  patcher_running: bool = False
  ltk_manager_status: ManagerInstallStatus = ManagerInstallStatus.UNKNOWN
  ltk_manager_progress: int = Field(default=0, ge=0, le=100)
  ltk_manager_message: str = ""
  capabilities: list[str] = Field(default_factory=list)
  timestamp_ms: int = Field(ge=0)


type ClientMessage = AuthMessage | SkinSelection | InstallLtkManager

_MESSAGE_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(
  Annotated[ClientMessage, Field(discriminator="type")],
)


def parse_client_message(payload: str) -> ClientMessage:
  """严格解析客户端 JSON；非法消息直接抛 ValidationError。"""

  return _MESSAGE_ADAPTER.validate_json(payload)
