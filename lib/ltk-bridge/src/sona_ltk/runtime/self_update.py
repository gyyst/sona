"""后台运行时自更新状态机：检查清单 → 下载 → 等待空闲 → 重启。"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from .. import build_version as default_build_version
from ..models.config import BridgeConfig
from ..models.events import BackendUpdateStatus
from ..services.update import archive, download, manifest, script
from ..services.update.manifest import BackendUpdateManifest
from ..services.update.script import UpdatePlan

log = logging.getLogger(__name__)

INITIAL_DELAY_S = 300.0
CHECK_INTERVAL_S = 6 * 60 * 60.0
IDLE_POLL_S = 5.0
STOP_TIMEOUT_S = 10.0
# 替换脚本无法启动时，入口拉起旧后台并带上该变量，避免同一会话反复重启
SKIP_ENV_NAME = "SONA_LTK_SKIP_SELF_UPDATE"


@dataclass(frozen=True)
class BackendUpdateSnapshot:
  status: BackendUpdateStatus
  message: str


async def _noop_notify() -> None:
  return None


class SelfUpdater:
  """非 Windows、源码运行或 dev 构建只上报 `unsupported`，绝不替换文件。"""

  def __init__(
    self,
    config: BridgeConfig,
    project_root: Path,
    *,
    request_stop: Callable[[], None],
    is_safe_to_restart: Callable[[], bool],
    notify: Callable[[], Awaitable[None]] | None = None,
    build_version: str | None = None,
    supported: bool | None = None,
    initial_delay_s: float = INITIAL_DELAY_S,
    interval_s: float = CHECK_INTERVAL_S,
    idle_poll_s: float = IDLE_POLL_S,
  ) -> None:
    self._config = config
    self._root = project_root
    self._request_stop = request_stop
    self._is_safe_to_restart = is_safe_to_restart
    self._notify = notify or _noop_notify
    self.version = default_build_version if build_version is None else build_version
    self._supported = _detect_supported(self.version) if supported is None else supported
    self._initial_delay_s = initial_delay_s
    self._interval_s = interval_s
    self._idle_poll_s = idle_poll_s
    self._stop = asyncio.Event()
    self._manifest: BackendUpdateManifest | None = None
    self._plan: UpdatePlan | None = None
    self._task: asyncio.Task[None] | None = None
    self._status = (
      BackendUpdateStatus.IDLE if self._supported else BackendUpdateStatus.UNSUPPORTED
    )
    self._message = (
      "尚未检查后台更新" if self._supported else _unsupported_message(self.version)
    )

  @property
  def supported(self) -> bool:
    return self._supported

  @property
  def plan(self) -> UpdatePlan | None:
    return self._plan

  def snapshot(self) -> BackendUpdateSnapshot:
    return BackendUpdateSnapshot(self._status, self._message)

  def start(self) -> None:
    if not self._supported or self._task is not None:
      return
    self._task = asyncio.create_task(self._run(), name="sona-ltk-self-update")

  async def stop(self) -> None:
    self._stop.set()
    task = self._task
    if task is None:
      return
    self._task = None
    try:
      await asyncio.wait_for(task, timeout=STOP_TIMEOUT_S)
    except TimeoutError:
      task.cancel()
      await asyncio.gather(task, return_exceptions=True)
    except Exception:
      log.exception("后台自更新任务异常退出")

  async def check_once(self) -> BackendUpdateSnapshot:
    """立即执行一轮检查（供测试与手动诊断使用），不触发重启。"""

    await self._check_once()
    return self.snapshot()

  async def _run(self) -> None:
    try:
      await self._wait(self._initial_delay_s)
      while not self._stop.is_set():
        await self._prepare_and_maybe_restart()
        if self._stop.is_set() or self._plan is not None:
          return
        await self._wait(self._interval_s)
    except asyncio.CancelledError:
      raise
    except Exception:
      log.exception("后台自更新循环异常终止")

  async def _prepare_and_maybe_restart(self) -> None:
    await self._check_once()
    if self._stop.is_set() or self._plan is None:
      return
    while not self._is_safe_to_restart():
      await self._wait(self._idle_poll_s)
      if self._stop.is_set():
        return
    await self._set_status(BackendUpdateStatus.RESTARTING, "正在重启后台以应用更新")
    self._request_stop()

  async def _check_once(self) -> None:
    if not self._supported:
      return
    await self._set_status(BackendUpdateStatus.CHECKING, "正在检查后台更新")
    proxy = getattr(self._config, "github_proxy", None)
    fallback = bool(getattr(self._config, "github_proxy_fallback", True))
    try:
      # 每轮检查都必须重新读取 dist/ltk.json；缓存会让长期运行的后台
      # 永远发现不了之后发布的运行时版本。
      current = await asyncio.to_thread(
        download.fetch_manifest,
        proxy=proxy,
        proxy_fallback=fallback,
      )
      self._manifest = current
      local = await asyncio.to_thread(manifest.compare_local_files, self._root, current)
      if local.matches:
        await asyncio.to_thread(script.cleanup_stale_update_files, self._root, current)
        self._plan = None
        await self._set_status(BackendUpdateStatus.IDLE, "后台运行时已是最新")
        return

      staging = self._root / script.STAGING_DIR
      staged = await asyncio.to_thread(manifest.compare_local_files, staging, current)
      if staged.matches:
        self._plan = self._build_plan(current)
        await self._set_status(
          BackendUpdateStatus.READY,
          "后台更新已下载，等待空闲时重启",
        )
        return

      await self._set_status(BackendUpdateStatus.DOWNLOADING, "正在下载后台更新")
      archive_path = self._root / script.ZIP_FILE
      await asyncio.to_thread(
        download.download_archive,
        current,
        archive_path,
        proxy=proxy,
        proxy_fallback=fallback,
      )
      await asyncio.to_thread(archive.extract_runtime, archive_path, current, staging)
      staged = await asyncio.to_thread(manifest.compare_local_files, staging, current)
      if not staged.matches:
        raise archive.UpdateArchiveError("更新包解压结果与清单不一致")
      self._plan = self._build_plan(current)
      await self._set_status(BackendUpdateStatus.READY, "后台更新已下载，等待空闲时重启")
    except (
      download.UpdateDownloadError,
      archive.UpdateArchiveError,
      manifest.UpdateManifestError,
    ) as exc:
      log.warning("后台更新失败：%s", exc)
      self._manifest = None
      self._plan = None
      await self._set_status(BackendUpdateStatus.ERROR, f"后台更新失败：{exc}")
    except Exception as exc:
      log.exception("后台更新出现未预期错误")
      self._manifest = None
      self._plan = None
      await self._set_status(BackendUpdateStatus.ERROR, f"后台更新失败：{exc}")

  def _build_plan(self, current: BackendUpdateManifest) -> UpdatePlan:
    return UpdatePlan(
      pid=os.getpid(),
      target=self._root,
      staged=self._root / script.STAGING_DIR,
      exe=manifest.EXECUTABLE_NAME,
      files=manifest.runtime_files(current),
      log=self._root / script.LOG_RELATIVE_PATH,
      # 插件用 --port/--token 启动后台；替换后必须沿用，否则前端连不上新进程。
      args=tuple(sys.argv[1:]),
    )

  async def _set_status(self, status: BackendUpdateStatus, message: str) -> None:
    if self._status == status and self._message == message:
      return
    self._status = status
    self._message = message
    log.info("后台更新状态：%s %s", status, message)
    try:
      await self._notify()
    except Exception:
      log.exception("广播后台更新状态失败")

  async def _wait(self, seconds: float) -> None:
    if seconds <= 0:
      return
    try:
      await asyncio.wait_for(self._stop.wait(), timeout=seconds)
    except TimeoutError:
      pass


def _detect_supported(version: str) -> bool:
  if os.environ.get(SKIP_ENV_NAME) == "1":
    return False
  if sys.platform != "win32":
    return False
  if not getattr(sys, "frozen", False):
    return False
  return version not in {"", "dev"}


def _unsupported_message(version: str) -> str:
  if os.environ.get(SKIP_ENV_NAME) == "1":
    return "上次更新未能启动替换脚本，本次会话跳过后台自动更新"
  if sys.platform != "win32":
    return "当前平台不支持后台自动更新"
  if not getattr(sys, "frozen", False):
    return "源码运行模式不自动更新后台"
  if version in {"", "dev"}:
    return "开发版后台不参与自动更新"
  return "当前构建不支持后台自动更新"
