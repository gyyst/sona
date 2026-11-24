"""LTF bridge 的请求 / 响应模型。"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, field_validator

# PEP 695 递归类型别名：Pydantic 2.14 需要显式命名递归类型
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, JsonValue]


class BridgeModel(BaseModel):
  """桥接响应字段比客户端协议更松散，允许 LTK 扩展字段。"""

  model_config = ConfigDict(populate_by_name=True, extra="allow")


class BridgeHello(BridgeModel):
  ok: bool
  service: str | None = None
  version: str | None = None
  pid: int | None = None
  port: int | None = None
  auth: bool | None = None


class LibraryMod(BridgeModel):
  """LTK Manager 库中的一条 mod。"""

  id: str
  name: str = ""
  enabled: bool = False
  fingerprint: str | None = None

  @field_validator("id", "name", mode="before")
  @classmethod
  def coerce_text(cls, value: object) -> str:
    return "" if value is None else str(value)


class BridgeError(BridgeModel):
  code: str | None = None
  kind: str | None = None
  message: str | None = None
  detail: JsonValue | None = None


class BridgeInner(BridgeModel):
  """Tauri invoke 的内层响应。"""

  value: JsonValue | None = None


class InstallValue(BridgeModel):
  """import 命令 value 的标准结构。"""

  kind: str
  mod: LibraryMod | None = None


class PatcherStatusValue(BridgeModel):
  running: bool | None = None
  status: str | None = None
  stage: str | None = None


class BridgeResponse(BridgeModel):
  ok: bool
  service: str | None = None
  pid: int | None = None
  library: list[LibraryMod] | None = None
  response: BridgeInner | None = None
  error: str | BridgeError | None = None
  raw: JsonValue | None = None
  note: str | None = None

  @property
  def error_text(self) -> str:
    """把 bridge / LTK 的错误压成一行文本。"""

    if isinstance(self.error, str):
      return self.error
    if isinstance(self.error, BridgeError):
      parts = [self.error.code, self.error.kind, self.error.message]
      return ": ".join(part for part in parts if part) or "LTK bridge error"
    return "LTK bridge returned ok=false"


def parse_install_value(response: BridgeResponse) -> InstallValue | None:
  """从 import 响应中提取安装结果；结构不完整时返回 None。"""

  value = response.response.value if response.response else None
  if not isinstance(value, dict):
    return None
  try:
    return InstallValue.model_validate(value)
  except ValueError:
    return None


def bridge_error_kind(response: BridgeResponse) -> str | None:
  """提取 LTK patcher 错误 kind，便于调用方决定是否重试。"""

  error = response.error
  return error.kind if isinstance(error, BridgeError) else None
