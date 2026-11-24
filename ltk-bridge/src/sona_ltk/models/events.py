"""客户端 → 后台的 WebSocket 消息。"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter

from .base import ApiModel


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


class ServerStatus(ApiModel):
  """后台 → 客户端的运行状态。"""

  type: Literal["status"] = "status"
  phase: str
  injection_status: str
  message: str
  skin_name: str | None = None
  patcher_running: bool = False
  timestamp_ms: int = Field(ge=0)


type ClientMessage = AuthMessage | SkinSelection

_MESSAGE_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(
  Annotated[ClientMessage, Field(discriminator="type")],
)


def parse_client_message(payload: str) -> ClientMessage:
  """严格解析客户端 JSON；非法消息直接抛 ValidationError。"""

  return _MESSAGE_ADAPTER.validate_json(payload)
