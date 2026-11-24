"""最小 LCU 客户端：lockfile、gameflow phase 与选人会话。"""

from __future__ import annotations

import base64
from pathlib import Path

import httpx
import psutil

from ..models.config import BridgeConfig
from ..models.lcu import ChampSelectSession, GameflowPhase, LockfileData


class LcuUnavailable(RuntimeError):
  """LCU 未启动或 lockfile 不可读。"""


class LcuClient:
  """连接信息每次请求前检查；客户端重启后自动刷新。"""

  def __init__(self, config: BridgeConfig) -> None:
    self._config = config
    self._lockfile: LockfileData | None = None
    self._authorization = ""

  def refresh(self) -> LockfileData:
    path = self._find_lockfile()
    try:
      raw = path.read_text(encoding="utf-8").strip()
      parts = raw.split(":")
      if len(parts) != 5:
        raise ValueError("lockfile 字段数不是 5")
      lockfile = LockfileData(
        name=parts[0],
        pid=int(parts[1]),
        port=int(parts[2]),
        password=parts[3],
        protocol=parts[4],
      )
    except (OSError, ValueError) as exc:
      raise LcuUnavailable(f"无法读取 LCU lockfile: {path}: {exc}") from exc

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
    except httpx.HTTPError:
      # LCU 可能刚重启：刷新连接信息后向上抛出，下一次请求使用新连接
      self.refresh()
      raise

  def _find_lockfile(self) -> Path:
    if self._config.lcu_lockfile_path is not None:
      return self._config.lcu_lockfile_path

    for process in psutil.process_iter(["name", "cmdline"]):
      if (process.info.get("name") or "").lower() != "leagueclientux.exe":
        continue
      for argument in process.info.get("cmdline") or []:
        for flag in ("--install-directory=", "--app-data-directory="):
          if argument.startswith(flag):
            candidate = Path(argument[len(flag):]) / "lockfile"
            if candidate.is_file():
              return candidate

    candidates = [
      Path(r"C:\Riot Games\League of Legends\lockfile"),
      Path(r"D:\Riot Games\League of Legends\lockfile"),
    ]
    for candidate in candidates:
      if candidate.is_file():
        return candidate
    raise LcuUnavailable("未找到 LCU lockfile，请在 config.json 中配置 lcuLockfilePath")
