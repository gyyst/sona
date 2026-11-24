"""Pydantic 模型基类：客户端字段使用 camelCase。"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
  """客户端协议模型：拒绝未知字段，避免拼写错误被静默接受。"""

  model_config = ConfigDict(
    populate_by_name=True,
    alias_generator=to_camel,
    extra="forbid",
  )


class LcuModel(BaseModel):
  """LCU 响应模型：只取需要的字段，忽略客户端返回的其余内容。"""

  model_config = ConfigDict(
    populate_by_name=True,
    alias_generator=to_camel,
    extra="ignore",
  )
