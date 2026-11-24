"""随 Sona 发布验证过的 LTK Manager 安装包信息与安装状态。"""

from __future__ import annotations

from enum import StrEnum

LTK_MANAGER_VERSION = "1.33.0"
LTK_MANAGER_DOWNLOAD_URL = (
  "https://github.com/LeagueToolkit/ltk-manager/releases/download/"
  f"v{LTK_MANAGER_VERSION}/LTK.Manager_{LTK_MANAGER_VERSION}_x64-setup.exe"
)
LTK_MANAGER_SHA256 = "d615a752940061e683e032506c432851df79e8b39f3732a9576fbedfdc6b5920"
LTK_MANAGER_SIZE = 24_696_744


class ManagerInstallStatus(StrEnum):
  UNKNOWN = "unknown"
  NOT_INSTALLED = "not-installed"
  DOWNLOADING = "downloading"
  VERIFYING = "verifying"
  INSTALLING = "installing"
  INSTALLED = "installed"
  ERROR = "error"
