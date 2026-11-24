"""LTK Manager 安装状态机：下载 → 校验 → UAC 安装 → 复检。

官方安装器只允许 Program Files（ADR-0055），因此这里不传 `/D`，
安装包缓存在插件目录的 `downloads/` 下。
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from ...models.config import BridgeConfig
from ...models.ltk_manager import (
  LTK_MANAGER_DOWNLOAD_URL,
  LTK_MANAGER_SHA256,
  LTK_MANAGER_SIZE,
  LTK_MANAGER_VERSION,
  ManagerInstallStatus,
)
from ..launcher import find_ltk_manager
from .download import ManagerDownloadError, download_installer, verify_installer
from .elevated import ElevationCancelled, ElevationError, run_elevated

log = logging.getLogger(__name__)

INSTALL_CHECK_TIMEOUT_S = 15.0
INSTALL_CHECK_INTERVAL_S = 0.5
REBOOT_REQUIRED_CODE = 3010

ACTIVE_STATUSES = frozenset(
  {
    ManagerInstallStatus.DOWNLOADING,
    ManagerInstallStatus.VERIFYING,
    ManagerInstallStatus.INSTALLING,
  },
)


class ManagerInstallError(RuntimeError):
  """安装流程失败，消息可直接展示给用户。"""


@dataclass(frozen=True)
class ManagerInstallSnapshot:
  status: ManagerInstallStatus
  progress: int
  message: str
  manager_path: Path | None = None


class ManagerInstaller:
  """状态读取无阻塞；实际下载与安装由调用方放到线程中执行。"""

  def __init__(
    self,
    config: BridgeConfig,
    project_root: Path,
    *,
    http_client: httpx.Client | None = None,
  ) -> None:
    self._config = config
    self._http_client = http_client
    self._version = config.ltk_manager_version or LTK_MANAGER_VERSION
    self._url = config.ltk_manager_download_url or LTK_MANAGER_DOWNLOAD_URL
    self._sha256 = config.ltk_manager_sha256 or LTK_MANAGER_SHA256
    self._size = config.ltk_manager_size or LTK_MANAGER_SIZE
    self._installer_path = project_root / "downloads" / f"LTK.Manager_{self._version}_x64-setup.exe"
    self._lock = threading.Lock()
    self._installing = False
    self._snapshot = ManagerInstallSnapshot(
      ManagerInstallStatus.UNKNOWN,
      0,
      "正在检测 LTK Manager",
    )
    self.refresh()

  def snapshot(self) -> ManagerInstallSnapshot:
    with self._lock:
      return self._snapshot

  def refresh(self) -> ManagerInstallSnapshot:
    """检测外部安装/卸载；安装过程中不覆盖活动状态。"""

    with self._lock:
      if self._installing or self._snapshot.status in ACTIVE_STATUSES:
        return self._snapshot

    path = self._find_manager()

    with self._lock:
      if self._installing or self._snapshot.status in ACTIVE_STATUSES:
        return self._snapshot
      if path is not None:
        self._snapshot = ManagerInstallSnapshot(
          ManagerInstallStatus.INSTALLED,
          100,
          f"已安装：{path}",
          path,
        )
      elif self._snapshot.status != ManagerInstallStatus.ERROR:
        self._snapshot = ManagerInstallSnapshot(
          ManagerInstallStatus.NOT_INSTALLED,
          0,
          "未检测到 LTK Manager",
        )
      return self._snapshot

  def install(self) -> ManagerInstallSnapshot:
    """同步执行一次安装；重复调用或安装中直接返回当前快照。"""

    # 用户可能在外部刚装好；入口先探测一次，避免重复下载和 UAC。
    self.refresh()
    with self._lock:
      if self._installing or self._snapshot.status == ManagerInstallStatus.INSTALLED:
        return self._snapshot
      self._installing = True

    try:
      self._install_locked()
    except ManagerDownloadError as exc:
      log.warning("LTK Manager 安装包处理失败：%s", exc)
      self._set(ManagerInstallStatus.ERROR, 0, str(exc))
    except ManagerInstallError as exc:
      log.warning("LTK Manager 安装失败：%s", exc)
      self._set(ManagerInstallStatus.ERROR, 0, str(exc))
    except Exception as exc:
      log.exception("LTK Manager 安装异常")
      self._set(ManagerInstallStatus.ERROR, 0, f"安装失败：{exc}")
    finally:
      with self._lock:
        self._installing = False
    return self.snapshot()

  def _install_locked(self) -> None:
    if self._installer_ready():
      log.info("复用已缓存的 LTK Manager 安装包：%s", self._installer_path)
      self._set(ManagerInstallStatus.VERIFYING, 100, "安装包已缓存，正在校验")
    else:
      self._set(ManagerInstallStatus.DOWNLOADING, 0, f"正在下载 LTK Manager {self._version}")
      download_installer(
        self._url,
        self._installer_path,
        self._sha256,
        self._size,
        timeout_s=self._config.ltk_manager_download_timeout_s,
        on_progress=lambda progress: self._set(
          ManagerInstallStatus.DOWNLOADING,
          progress,
          f"正在下载 LTK Manager {self._version}",
        ),
        client=self._http_client,
      )
      self._set(ManagerInstallStatus.VERIFYING, 100, "正在校验安装包")
      try:
        verify_installer(self._installer_path, self._sha256, self._size)
      except ManagerDownloadError:
        self._installer_path.unlink(missing_ok=True)
        raise

    self._set(
      ManagerInstallStatus.INSTALLING,
      100,
      "正在启动安装程序，请在桌面允许 UAC 授权",
    )
    path, needs_reboot = self._run_installer()
    message = f"LTK Manager 已安装：{path}"
    if needs_reboot:
      message += "（系统提示需要重启）"
    self._set(ManagerInstallStatus.INSTALLED, 100, message, path)

  def _installer_ready(self) -> bool:
    try:
      verify_installer(self._installer_path, self._sha256, self._size)
      return True
    except ManagerDownloadError as exc:
      log.info("缓存安装包不可用（%s），将重新下载", exc)
      self._installer_path.unlink(missing_ok=True)
      return False

  def _run_installer(self) -> tuple[Path, bool]:
    # 校验与提权启动之间尽量缩小窗口：启动前再次校验。
    try:
      verify_installer(self._installer_path, self._sha256, self._size)
    except ManagerDownloadError as exc:
      self._installer_path.unlink(missing_ok=True)
      raise ManagerInstallError(str(exc)) from exc

    log.info("启动 LTK Manager 安装程序：%s /S", self._installer_path)
    started = time.monotonic()
    try:
      code = run_elevated(
        self._installer_path,
        "/S",
        self._config.ltk_manager_install_timeout_s,
      )
    except ElevationCancelled as exc:
      raise ManagerInstallError(str(exc)) from exc
    except ElevationError as exc:
      raise ManagerInstallError(str(exc)) from exc

    elapsed = time.monotonic() - started
    log.info("LTK Manager 安装程序退出码 %s，耗时 %.1fs", code, elapsed)
    if code not in {0, REBOOT_REQUIRED_CODE}:
      raise ManagerInstallError(
        f"安装程序退出码 {code}，请查看系统提示或手动安装",
      )

    deadline = time.monotonic() + INSTALL_CHECK_TIMEOUT_S
    while time.monotonic() < deadline:
      path = self._find_manager()
      if path is not None:
        log.info("LTK Manager 安装完成：%s", path)
        return path, code == REBOOT_REQUIRED_CODE
      time.sleep(INSTALL_CHECK_INTERVAL_S)
    raise ManagerInstallError(
      "安装程序已结束，但未找到 ltk-manager.exe；请尝试从官方 Releases 手动安装",
    )

  def _find_manager(self) -> Path | None:
    """配置路径优先，其次自动探测；与启动链路保持一致。"""

    configured = self._config.ltk_manager_path
    if configured is not None:
      candidate = configured.expanduser()
      if candidate.is_file():
        return candidate
    return find_ltk_manager()

  def _set(
    self,
    status: ManagerInstallStatus,
    progress: int,
    message: str,
    manager_path: Path | None = None,
  ) -> None:
    clamped = max(0, min(100, progress))
    with self._lock:
      self._snapshot = ManagerInstallSnapshot(status, clamped, message, manager_path)
