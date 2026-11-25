"""最小 LCU 客户端：lockfile、进程命令行、gameflow phase 与选人会话。"""

from __future__ import annotations

import base64
import logging
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx
import psutil
from pydantic import ValidationError

from ..models.config import BridgeConfig
from ..models.lcu import ChampSelectSession, GameflowPhase, LockfileData

log = logging.getLogger(__name__)

_LOCKFILE_FIELD_COUNT = 5
_PROCESS_NAME = "leagueclientux.exe"
_INSTALL_DIRECTORY_FLAGS = ("--install-directory=", "--app-data-directory=")
_APP_PORT_FLAG = "--app-port="
_AUTH_TOKEN_FLAG = "--remoting-auth-token="
_APP_PID_FLAG = "--app-pid="
_DEFAULT_LOCKFILE_PATHS: tuple[Path, ...] = (
  Path(r"C:\Riot Games\League of Legends\lockfile"),
  Path(r"D:\Riot Games\League of Legends\lockfile"),
)


class LcuUnavailable(RuntimeError):
  """LCU 未启动、连接信息不可用或请求失败。"""

  def __init__(self, message: str, status_code: int | None = None) -> None:
    super().__init__(message)
    # HTTP 状态码仅用于区分阶段竞态（404）与其他请求错误；连接层错误保持 None
    self.status_code = status_code


@dataclass(frozen=True)
class _UxProcess:
  """LeagueClientUx.exe 提供的连接线索：安装目录与命令行连接信息。"""

  pid: int
  install_directories: tuple[Path, ...]
  connection: LockfileData | None


def _parse_int(value: str | None) -> int | None:
  if value is None:
    return None
  try:
    return int(value)
  except ValueError:
    return None


def _parse_lockfile_text(path: Path) -> LockfileData:
  """解析 lockfile；失败时抛 LcuUnavailable，消息只含路径，绝不含 token。"""

  try:
    raw = path.read_text(encoding="utf-8").strip()
  except OSError as exc:
    raise LcuUnavailable(f"无法读取 LCU lockfile: {path}: {exc}") from exc
  except UnicodeDecodeError:
    # 半写入或加密的 lockfile 不是合法 UTF-8；消息不含文件内容
    raise LcuUnavailable(f"LCU lockfile 不是合法 UTF-8 文本: {path}") from None
  if not raw:
    raise LcuUnavailable(f"LCU lockfile 为空: {path}")

  parts = raw.split(":")
  if len(parts) != _LOCKFILE_FIELD_COUNT:
    raise LcuUnavailable(f"LCU lockfile 字段数不是 {_LOCKFILE_FIELD_COUNT}: {path}")

  name, raw_pid, raw_port, token, protocol = parts
  pid = _parse_int(raw_pid)
  port = _parse_int(raw_port)
  if pid is None or pid <= 0:
    raise LcuUnavailable(f"LCU lockfile 的 pid 非法: {path}")
  if port is None or not 1 <= port <= 65535:
    raise LcuUnavailable(f"LCU lockfile 的端口非法: {path}")
  if not name or not token or not protocol:
    raise LcuUnavailable(f"LCU lockfile 存在空字段: {path}")

  try:
    return LockfileData(name=name, pid=pid, port=port, password=token, protocol=protocol)
  except ValidationError:
    # ValidationError 的文本会带上字段原值（可能含 token），这里只报告路径
    raise LcuUnavailable(f"LCU lockfile 内容非法: {path}") from None


def _parse_cmdline(args: Sequence[str], pid_hint: int = 0) -> LockfileData | None:
  """从进程命令行提取连接信息；缺少端口或 token 时返回 None。

  --app-pid 为可选参数：缺失时使用进程自身 pid（pid_hint）。
  """

  values: dict[str, str] = {}
  for argument in args:
    for flag in (_APP_PORT_FLAG, _AUTH_TOKEN_FLAG, _APP_PID_FLAG):
      if argument.startswith(flag):
        values[flag] = argument[len(flag):]

  port = _parse_int(values.get(_APP_PORT_FLAG))
  token = (values.get(_AUTH_TOKEN_FLAG) or "").strip()
  if port is None or not 1 <= port <= 65535 or not token:
    return None

  app_pid = _parse_int(values.get(_APP_PID_FLAG))
  pid = app_pid if app_pid is not None and app_pid > 0 else pid_hint
  try:
    return LockfileData(name="riot", pid=pid, port=port, password=token, protocol="https")
  except ValidationError:
    # ValidationError 文本会带上字段原值（可能含 token），不向外传播
    return None


def _iter_ux_processes() -> Iterator[psutil.Process]:
  """枚举 LeagueClientUx.exe；单个进程读取失败时跳过，不影响其余进程。"""

  iterator = psutil.process_iter(["name", "cmdline"])
  while True:
    try:
      process = next(iterator)
    except StopIteration:
      return
    except psutil.Error:
      continue
    yield process


def _collect_ux_processes() -> list[_UxProcess]:
  """一次遍历同时收集安装目录与命令行连接信息，避免重复枚举进程。"""

  processes: list[_UxProcess] = []
  for process in _iter_ux_processes():
    try:
      info = process.info
      if (info.get("name") or "").lower() != _PROCESS_NAME:
        continue
      args = [str(argument) for argument in info.get("cmdline") or []]
    except (psutil.Error, AttributeError):
      continue

    install_directories: list[Path] = []
    for argument in args:
      for flag in _INSTALL_DIRECTORY_FLAGS:
        if argument.startswith(flag):
          value = argument[len(flag):].strip()
          if value:
            install_directories.append(Path(value))

    processes.append(
      _UxProcess(
        pid=process.pid,
        install_directories=tuple(install_directories),
        connection=_parse_cmdline(args, pid_hint=process.pid),
      ),
    )
  return processes


def _lockfile_candidates(processes: Sequence[_UxProcess]) -> tuple[Path, ...]:
  """进程安装目录拼出的 lockfile，按出现顺序去重。"""

  paths: list[Path] = []
  for process in processes:
    for directory in process.install_directories:
      paths.append(directory / "lockfile")
  return tuple(dict.fromkeys(paths))


def _read_lockfile_candidate(path: Path) -> LockfileData | None:
  """尝试读取一个 lockfile 候选；不可用时记录原因并返回 None。"""

  try:
    if path.stat().st_size == 0:
      log.debug("跳过 0 字节 LCU lockfile: %s", path)
      return None
  except OSError:
    return None
  try:
    lockfile = _parse_lockfile_text(path)
  except LcuUnavailable as exc:
    log.warning("LCU lockfile 不可用，尝试下一个来源: %s", exc)
    return None
  log.debug("使用 LCU lockfile: %s", path)
  return lockfile


class LcuClient:
  """连接信息每次请求前检查；客户端重启后自动刷新。"""

  def __init__(self, config: BridgeConfig) -> None:
    self._config = config
    self._lockfile: LockfileData | None = None
    self._authorization = ""

  def refresh(self) -> LockfileData:
    lockfile = self._discover()
    credentials = base64.b64encode(f"{lockfile.name}:{lockfile.password}".encode()).decode()
    self._lockfile = lockfile
    self._authorization = f"Basic {credentials}"
    return lockfile

  def get_phase(self) -> GameflowPhase:
    value = self._request("GET", "/lol-gameflow/v1/gameflow-phase")
    if not isinstance(value, str):
      raise LcuUnavailable("gameflow-phase 返回了非字符串")
    return GameflowPhase.from_api(value)

  def get_champ_select_session(self) -> ChampSelectSession:
    value = self._request("GET", "/lol-champ-select/v1/session")
    return ChampSelectSession.model_validate(value)

  def force_base_skin(self, champion_id: int) -> None:
    """让游戏加载基础皮肤，LTK 的 rebase mod 才能正确叠加。"""

    self._request(
      "PATCH",
      "/lol-champ-select/v1/session/my-selection",
      {"selectedSkinId": champion_id * 1000},
    )

  def _discover(self) -> LockfileData:
    """发现顺序：显式配置 → 进程 lockfile → 进程命令行 → 默认路径 → 明确报错。"""

    explicit = self._config.lcu_lockfile_path
    if explicit is not None:
      # 尊重用户显式配置：失败直接报错，不静默回退
      return _parse_lockfile_text(explicit)

    processes = _collect_ux_processes()
    candidates = _lockfile_candidates(processes)
    for candidate in candidates:
      lockfile = _read_lockfile_candidate(candidate)
      if lockfile is not None:
        return lockfile

    # 运行中进程的命令行优先于静态默认路径：默认路径可能残留旧安装的过期 lockfile
    for process in processes:
      if process.connection is not None:
        log.info(
          "通过 LeagueClientUx 命令行发现 LCU 连接（pid=%s, port=%s）",
          process.connection.pid,
          process.connection.port,
        )
        return process.connection

    defaults = tuple(path for path in _DEFAULT_LOCKFILE_PATHS if path not in candidates)
    for candidate in defaults:
      lockfile = _read_lockfile_candidate(candidate)
      if lockfile is not None:
        return lockfile

    raise LcuUnavailable(
      "未找到可用的 LCU 连接信息（已尝试：进程 lockfile/进程命令行/默认路径；"
      f"lockfile 候选 {len(candidates) + len(defaults)} 个、LeagueClientUx 进程 {len(processes)} 个）",
    )

  def _request(
    self,
    method: str,
    endpoint: str,
    body: dict[str, int] | None = None,
  ) -> object:
    if self._lockfile is None:
      self.refresh()
    lockfile = self._lockfile
    if lockfile is None:
      raise LcuUnavailable("LCU 未连接")

    url = f"https://127.0.0.1:{lockfile.port}{endpoint}"
    try:
      with httpx.Client(verify=False, timeout=5.0) as client:
        response = client.request(
          method,
          url,
          headers={"Authorization": self._authorization},
          json=body,
        )
        response.raise_for_status()
        return response.json() if response.content else None
    except httpx.HTTPStatusError as exc:
      # 客户端仍可达，只丢弃本次请求；保留连接缓存供下次复用
      raise LcuUnavailable(
        f"LCU 请求失败：HTTP {exc.response.status_code}",
        status_code=exc.response.status_code,
      ) from None
    except httpx.TransportError:
      # 客户端启动/重启窗口内端口未监听：清空缓存，下一次请求重新发现
      self._lockfile = None
      self._authorization = ""
      raise LcuUnavailable("LCU 连接失败，客户端可能正在启动或重启") from None
    except httpx.HTTPError:
      # 其余 httpx 错误同样只在本轮失败，避免异常冒泡终止后台轮询
      self._lockfile = None
      self._authorization = ""
      raise LcuUnavailable("LCU 请求失败，连接信息已重置") from None
    except ValueError:
      # 响应不是合法 JSON；消息不携带响应体，避免泄露敏感内容
      raise LcuUnavailable("LCU 响应不是合法 JSON") from None
