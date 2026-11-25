"""LCU 连接发现：lockfile 解析、进程命令行回退与发现顺序测试。"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import psutil
import pytest

from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.lcu import GameflowPhase
from sona_ltk.services import lcu_client as lcu_module
from sona_ltk.services.lcu_client import (
  LcuClient,
  LcuUnavailable,
  _parse_cmdline,
  _parse_lockfile_text,
)

_TOKEN = "test-secret-token"
_VALID_LOCKFILE = f"riot:4242:65210:{_TOKEN}:https"


class _FakeProcess:
  def __init__(self, pid: int, name: str, cmdline: list[str]) -> None:
    self.pid = pid
    self.info: dict[str, object] = {"name": name, "cmdline": cmdline}


class _InaccessibleProcess(_FakeProcess):
  """info 访问抛 psutil 错误的进程，用于验证枚举失败隔离。"""

  def __init__(self, pid: int) -> None:
    self.pid = pid

  @property
  def info(self) -> dict[str, object]:  # type: ignore[override]
    raise psutil.AccessDenied(pid=self.pid)


def _fake_process_iter(processes: list[_FakeProcess]) -> Callable[..., Iterator[_FakeProcess]]:
  def _iter(_attrs: object = None) -> Iterator[_FakeProcess]:
    return iter(processes)

  return _iter


@pytest.fixture(autouse=True)
def _isolate_discovery(monkeypatch: pytest.MonkeyPatch) -> None:
  """屏蔽真实客户端与默认 Riot 安装目录，保证测试确定。"""

  monkeypatch.setattr(lcu_module, "_DEFAULT_LOCKFILE_PATHS", ())
  monkeypatch.setattr(lcu_module.psutil, "process_iter", _fake_process_iter([]))


def _ux_process(*arguments: str, pid: int = 4242) -> _FakeProcess:
  return _FakeProcess(pid, "LeagueClientUx.exe", list(arguments))


def _client(monkeypatch: pytest.MonkeyPatch, processes: list[_FakeProcess], **config: object) -> LcuClient:
  monkeypatch.setattr(lcu_module.psutil, "process_iter", _fake_process_iter(processes))
  return LcuClient(BridgeConfig(**config))


def _write_lockfile(directory: Path, content: str) -> Path:
  directory.mkdir(parents=True, exist_ok=True)
  path = directory / "lockfile"
  path.write_text(content, encoding="utf-8")
  return path


# ---------------------------------------------------------------------------
# _parse_lockfile_text
# ---------------------------------------------------------------------------


def test_parse_lockfile_text_valid(tmp_path: Path) -> None:
  path = _write_lockfile(tmp_path, _VALID_LOCKFILE)

  lockfile = _parse_lockfile_text(path)

  assert lockfile.name == "riot"
  assert lockfile.pid == 4242
  assert lockfile.port == 65210
  assert lockfile.password == _TOKEN
  assert lockfile.protocol == "https"


def test_parse_lockfile_text_rejects_zero_byte_file(tmp_path: Path) -> None:
  path = _write_lockfile(tmp_path, "")

  with pytest.raises(LcuUnavailable, match="为空"):
    _parse_lockfile_text(path)


def test_parse_lockfile_text_rejects_short_fields(tmp_path: Path) -> None:
  path = _write_lockfile(tmp_path, "riot:1:2")

  with pytest.raises(LcuUnavailable, match="字段数"):
    _parse_lockfile_text(path)


def test_parse_lockfile_text_rejects_invalid_port_without_token(tmp_path: Path) -> None:
  path = _write_lockfile(tmp_path, f"riot:4242:70000:{_TOKEN}:https")

  with pytest.raises(LcuUnavailable) as excinfo:
    _parse_lockfile_text(path)

  assert _TOKEN not in str(excinfo.value)


def test_parse_lockfile_text_rejects_non_utf8_content(tmp_path: Path) -> None:
  path = tmp_path / "lockfile"
  path.write_bytes(b"\xff\xfe\x00\x00riot:4242")

  with pytest.raises(LcuUnavailable, match="UTF-8") as excinfo:
    _parse_lockfile_text(path)

  assert _TOKEN not in str(excinfo.value)


# ---------------------------------------------------------------------------
# _parse_cmdline
# ---------------------------------------------------------------------------


def test_parse_cmdline_valid() -> None:
  lockfile = _parse_cmdline(
    [
      "--app-port=65210",
      "--remoting-auth-token=cmdline-token",
      "--app-pid=7777",
      "--install-directory=D:/Games/LeagueClient",
    ],
  )

  assert lockfile is not None
  assert lockfile.name == "riot"
  assert lockfile.port == 65210
  assert lockfile.pid == 7777
  assert lockfile.password == "cmdline-token"
  assert lockfile.protocol == "https"


def test_parse_cmdline_missing_port_returns_none() -> None:
  assert _parse_cmdline(["--remoting-auth-token=cmdline-token", "--app-pid=1"]) is None


def test_parse_cmdline_missing_token_returns_none() -> None:
  assert _parse_cmdline(["--app-port=65210", "--app-pid=1"]) is None
  assert _parse_cmdline(["--app-port=65210", "--remoting-auth-token="]) is None


def test_parse_cmdline_non_numeric_port_returns_none() -> None:
  assert _parse_cmdline(["--app-port=abc", "--remoting-auth-token=cmdline-token"]) is None


def test_parse_cmdline_ignores_empty_install_directory() -> None:
  lockfile = _parse_cmdline(
    ["--app-port=65210", "--remoting-auth-token=cmdline-token", "--install-directory="],
  )

  assert lockfile is not None
  assert lockfile.port == 65210


# ---------------------------------------------------------------------------
# LcuClient.refresh 发现顺序
# ---------------------------------------------------------------------------


def test_refresh_prefers_explicit_lockfile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  explicit = _write_lockfile(tmp_path, f"riot:1:61111:{_TOKEN}:https")
  processes = [_ux_process("--app-port=62222", f"--remoting-auth-token={_TOKEN}", "--app-pid=2")]

  client = _client(monkeypatch, processes, lcu_lockfile_path=explicit)

  assert client.refresh().port == 61111


def test_refresh_explicit_empty_lockfile_does_not_fall_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  explicit = _write_lockfile(tmp_path, "")
  processes = [_ux_process("--app-port=62222", f"--remoting-auth-token={_TOKEN}", "--app-pid=2")]

  client = _client(monkeypatch, processes, lcu_lockfile_path=explicit)

  with pytest.raises(LcuUnavailable, match="为空"):
    client.refresh()


def test_refresh_prefers_valid_lockfile_over_cmdline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  install_dir = tmp_path / "LeagueClient"
  _write_lockfile(install_dir, f"riot:1:63333:{_TOKEN}:https")
  processes = [
    _ux_process(
      "--app-port=64444",
      "--remoting-auth-token=cmdline-token",
      "--app-pid=2",
      f"--install-directory={install_dir}",
    ),
  ]

  client = _client(monkeypatch, processes)

  assert client.refresh().port == 63333


def test_refresh_prefers_cmdline_over_default_lockfile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  stale = _write_lockfile(tmp_path / "stale-riot", f"riot:1:60555:{_TOKEN}:https")
  monkeypatch.setattr(lcu_module, "_DEFAULT_LOCKFILE_PATHS", (stale,))
  processes = [_ux_process("--app-port=60666", "--remoting-auth-token=cmdline-token", "--app-pid=2")]

  client = _client(monkeypatch, processes)

  assert client.refresh().port == 60666


def test_refresh_uses_default_lockfile_without_cmdline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  default_lockfile = _write_lockfile(tmp_path / "riot", f"riot:1:60777:{_TOKEN}:https")
  monkeypatch.setattr(lcu_module, "_DEFAULT_LOCKFILE_PATHS", (default_lockfile,))
  # 命令行缺少 --app-port，无法构造连接信息
  processes = [_ux_process("--remoting-auth-token=cmdline-token")]

  client = _client(monkeypatch, processes)

  assert client.refresh().port == 60777


def test_refresh_falls_back_to_cmdline_for_zero_byte_lockfile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  install_dir = tmp_path / "LeagueClient"
  _write_lockfile(install_dir, "")
  processes = [
    _ux_process(
      "--app-port=6555",
      "--remoting-auth-token=cmdline-token",
      "--app-pid=2",
      f"--install-directory={install_dir}",
    ),
  ]

  client = _client(monkeypatch, processes)

  lockfile = client.refresh()
  assert lockfile.port == 6555
  assert lockfile.password == "cmdline-token"


def test_refresh_falls_back_to_cmdline_when_lockfile_missing(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  install_dir = tmp_path / "LeagueClient"
  install_dir.mkdir()
  processes = [
    _ux_process(
      "--app-port=6666",
      "--remoting-auth-token=cmdline-token",
      f"--install-directory={install_dir}",
    ),
  ]

  client = _client(monkeypatch, processes)

  lockfile = client.refresh()
  assert lockfile.port == 6666
  # 命令行缺少 --app-pid 时使用进程自身 pid
  assert lockfile.pid == 4242


def test_refresh_skips_invalid_lockfile_and_uses_next_candidate(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  broken_dir = tmp_path / "broken"
  _write_lockfile(broken_dir, "garbage")
  good_dir = tmp_path / "good"
  _write_lockfile(good_dir, f"riot:1:60111:{_TOKEN}:https")
  processes = [
    _ux_process(f"--install-directory={broken_dir}", "--app-port=60022", "--remoting-auth-token=cmdline-token"),
    _ux_process(f"--install-directory={good_dir}", "--app-port=60033", "--remoting-auth-token=cmdline-token"),
  ]

  client = _client(monkeypatch, processes)

  assert client.refresh().port == 60111


def test_refresh_reports_attempted_sources_without_token(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  install_dir = tmp_path / "LeagueClient"
  install_dir.mkdir()
  processes = [
    _ux_process("--remoting-auth-token=cmdline-secret", f"--install-directory={install_dir}"),
  ]

  client = _client(monkeypatch, processes)

  with pytest.raises(LcuUnavailable) as excinfo:
    client.refresh()

  message = str(excinfo.value)
  assert "未找到可用的 LCU 连接信息" in message
  assert "LeagueClientUx" in message
  assert "cmdline-secret" not in message
  assert _TOKEN not in message


def test_refresh_skips_process_with_inaccessible_info(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
  install_dir = tmp_path / "LeagueClient"
  _write_lockfile(install_dir, f"riot:1:61222:{_TOKEN}:https")
  processes = [
    _InaccessibleProcess(9001),
    _ux_process(f"--install-directory={install_dir}", "--app-port=61333", "--remoting-auth-token=cmdline-token"),
  ]

  client = _client(monkeypatch, processes)

  assert client.refresh().port == 61222


# ---------------------------------------------------------------------------
# LcuClient._request 错误翻译
# ---------------------------------------------------------------------------


def _install_mock_transport(
  monkeypatch: pytest.MonkeyPatch,
  handler: Callable[[httpx.Request], httpx.Response],
) -> None:
  """让 LcuClient 内部创建的 httpx.Client 走 MockTransport。"""

  real_client = httpx.Client

  def _factory(*args: object, **kwargs: object) -> httpx.Client:
    kwargs["transport"] = httpx.MockTransport(handler)
    return real_client(*args, **kwargs)  # type: ignore[arg-type]

  monkeypatch.setattr(lcu_module.httpx, "Client", _factory)


def _ready_client(tmp_path: Path) -> LcuClient:
  """用显式 lockfile 建立连接的客户端，供 _request 错误翻译测试。"""

  path = _write_lockfile(tmp_path, _VALID_LOCKFILE)
  client = LcuClient(BridgeConfig(lcu_lockfile_path=path))
  client.refresh()
  return client


def test_request_translates_connect_error_and_resets_connection(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  client = _ready_client(tmp_path)
  calls = {"count": 0}

  def _handler(_request: httpx.Request) -> httpx.Response:
    calls["count"] += 1
    if calls["count"] == 1:
      raise httpx.ConnectError("[WinError 10061] 由于目标计算机积极拒绝，无法连接")
    return httpx.Response(200, json="ChampSelect")

  _install_mock_transport(monkeypatch, _handler)

  with pytest.raises(LcuUnavailable, match="连接失败") as excinfo:
    client.get_phase()

  assert _TOKEN not in str(excinfo.value)
  assert client._lockfile is None
  assert client._authorization == ""

  # 下一次请求惰性重新发现连接信息，恢复后可直接成功
  assert client.get_phase() is GameflowPhase.CHAMP_SELECT
  assert client._lockfile is not None
  assert client._authorization != ""


def test_request_translates_http_error_status_without_token(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  client = _ready_client(tmp_path)
  _install_mock_transport(monkeypatch, lambda _request: httpx.Response(500, json={"error": "boom"}))

  with pytest.raises(LcuUnavailable, match="HTTP 500") as excinfo:
    client.get_phase()

  assert excinfo.value.status_code == 500
  assert _TOKEN not in str(excinfo.value)
  # 客户端仍可达，只丢弃本次请求；连接缓存保留
  assert client._lockfile is not None
  assert client._authorization != ""


def test_request_translates_invalid_json_response_without_body(
  tmp_path: Path,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  client = _ready_client(tmp_path)
  _install_mock_transport(monkeypatch, lambda _request: httpx.Response(200, content=b"<html>not json</html>"))

  with pytest.raises(LcuUnavailable, match="合法 JSON") as excinfo:
    client.get_phase()

  assert "<html>" not in str(excinfo.value)
  assert client._lockfile is not None
