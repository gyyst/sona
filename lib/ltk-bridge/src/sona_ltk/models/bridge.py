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
  """LTK 错误；真实响应可能把具体原因再嵌一层 error。"""

  code: str | None = None
  kind: str | None = None
  message: str | None = None
  detail: JsonValue | None = None
  error: BridgeError | str | None = None


class BridgeInner(BridgeModel):
  """Tauri invoke 的内层响应；失败时 ok=false 且带 error。"""

  ok: bool | None = None
  value: JsonValue | None = None
  error: BridgeError | str | None = None


class InstallValue(BridgeModel):
  """import 命令 value 的标准结构。"""

  kind: str
  mod: LibraryMod | None = None


class PatcherFailureValue(BridgeModel):
  """`PatcherStatus.error`：LTK Manager 记录的最后一次启动/注入失败。"""

  kind: str | None = None
  message: str | None = None
  stage: str | None = None
  reason: str | None = None


class PatcherStatusValue(BridgeModel):
  """LTK patcher 的运行状态；`phase` 为 `idle` / `building` / `patching`。"""

  running: bool | None = None
  status: str | None = None
  stage: str | None = None
  phase: str | None = None
  error: PatcherFailureValue | None = None

  @property
  def phase_name(self) -> str:
    """去掉大小写与空白后的 phase；缺失时返回空串。"""

    return (self.phase or "").strip().lower()


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
    """把 bridge / LTK 的错误压成一行文本。

    提取顺序：顶层 error → response.error（字符串正文或 code/kind/message 与嵌套 error 的
    kind/message）→ 兜底文案。
    """

    if isinstance(self.error, str):
      return self.error
    if isinstance(self.error, BridgeError):
      return ": ".join(_error_parts(self.error)) or "LTK bridge error"
    inner = self.response.error if self.response is not None else None
    if isinstance(inner, str):
      return inner
    if isinstance(inner, BridgeError):
      text = ": ".join(_error_parts(inner))
      if text:
        return text
    return "LTK bridge returned ok=false"


def _error_parts(error: BridgeError) -> list[str]:
  """收集错误自身与嵌套 error 的可读字段，忽略空值。"""

  parts: list[str | None] = [error.code, error.kind, error.message]
  nested = error.error
  if isinstance(nested, str):
    parts.append(nested)
  elif isinstance(nested, BridgeError):
    parts.extend([nested.code, nested.kind, nested.message])
  return [part for part in parts if part]


def parse_install_value(response: BridgeResponse) -> InstallValue | None:
  """从 import 响应中提取安装结果；结构不完整时返回 None。"""

  value = response.response.value if response.response else None
  if not isinstance(value, dict):
    return None
  try:
    return InstallValue.model_validate(value)
  except ValueError:
    return None


def parse_patcher_status(response: BridgeResponse) -> PatcherStatusValue | None:
  """从 patcher_status 响应中提取状态；结构不完整时返回 None。"""

  value = response.response.value if response.response else None
  if not isinstance(value, dict):
    return None
  try:
    return PatcherStatusValue.model_validate(value)
  except ValueError:
    return None


def bridge_error_kind(response: BridgeResponse) -> str | None:
  """提取 LTK patcher 错误 kind，便于调用方决定是否重试。

  LTF 把 Tauri invoke 的结果嵌在 response 里，域错误的 kind 又嵌在 `error` 下，
  因此顶层与内层都要检查。
  """

  candidates: list[BridgeError | str | None] = [response.error]
  if response.response is not None:
    candidates.append(response.response.error)
  for error in candidates:
    kind = _nested_error_kind(error)
    if kind:
      return kind
  return None


def _nested_error_kind(error: BridgeError | str | None) -> str | None:
  """沿 `error` 链找到第一个 kind，忽略只有 code/message 的外层。"""

  while isinstance(error, BridgeError):
    if error.kind:
      return error.kind
    error = error.error
  return None
