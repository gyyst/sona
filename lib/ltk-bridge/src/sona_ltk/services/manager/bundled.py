"""随插件分发的 LTK Manager 安装包清单。

发布流水线把自维护的安装包放进插件目录的 `ltk/manager/`，并写入 `manifest.json`。
后台优先使用这份随包副本，因为它是与当前 Sona 版本一起构建和校验过的版本；
缺失或损坏时才回退到 `models/ltk_manager.py` 的内置默认值。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

log = logging.getLogger(__name__)

MANIFEST_NAME = "manifest.json"
BUNDLED_DIR_NAME = "manager"


class BundledManagerError(RuntimeError):
  """随包清单存在但无法读取或校验。"""


class BundledManagerManifest(BaseModel):
  """`ltk/manager/manifest.json` 的内容。"""

  model_config = ConfigDict(extra="ignore")

  version: str
  file: str
  sha256: str = Field(min_length=64, max_length=64)
  size: int = Field(gt=0)


@dataclass(frozen=True)
class BundledManager:
  """校验通过的随包安装包。"""

  version: str
  path: Path
  sha256: str
  size: int


def _manifest_path(project_root: Path) -> Path:
  return project_root / BUNDLED_DIR_NAME / MANIFEST_NAME


def load_bundled_manager(project_root: Path) -> BundledManager | None:
  """读取并校验随包清单；文件不存在或内容无效时返回 None。

  只做清单层面的校验，安装包本身的 SHA-256 由安装状态机在运行前复核。
  """

  manifest_path = _manifest_path(project_root)
  if not manifest_path.is_file():
    return None

  try:
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
  except (OSError, ValueError) as exc:
    log.warning("随包 LTK Manager 清单不可读：%s", exc)
    return None

  try:
    manifest = BundledManagerManifest.model_validate(payload)
  except ValidationError as exc:
    log.warning("随包 LTK Manager 清单字段无效：%s", exc)
    return None

  installer = manifest_path.parent / manifest.file
  if not installer.is_file():
    log.warning("随包 LTK Manager 安装包缺失：%s", installer)
    return None

  return BundledManager(
    version=manifest.version,
    path=installer,
    sha256=manifest.sha256.lower(),
    size=manifest.size,
  )
