"""发现 LTKBridge 的端口与 token。"""

from __future__ import annotations

import errno
import os
import select
import socket
import time
from dataclasses import dataclass
from pathlib import Path

from ..models.bridge import BridgeHello

PORT_RANGE_START = 46321
PORT_RANGE_END = 46340
REG_PATH = r"Software\LTKBridge"
REG_PORT_VALUE = "ApiPort"
REG_TOKEN_VALUE = "ApiToken"
PUBLIC_PORT_FILE = Path(r"C:\Users\Public\LTKBridge.port")


@dataclass(frozen=True)
class BridgeEndpoint:
  port: int
  hello: BridgeHello
  token: str


def _bridge_dirs() -> list[Path]:
  local_appdata = os.environ.get("LOCALAPPDATA")
  if not local_appdata:
    return []
  return [Path(local_appdata) / "LTKBridge"]


def read_token_candidates() -> list[str]:
  """读取 token 文件与注册表；按可信度去重。"""

  found: list[str] = []

  def add(value: str | None) -> None:
    cleaned = (value or "").strip()
    if cleaned and cleaned not in found:
      found.append(cleaned)

  for directory in _bridge_dirs():
    try:
      add((directory / "token.txt").read_text(encoding="ascii", errors="ignore"))
    except OSError:
      continue

  try:
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH) as key:
      value, _ = winreg.QueryValueEx(key, REG_TOKEN_VALUE)
      add(str(value))
  except (ImportError, OSError):
    pass

  return found


def _read_port_file(path: Path) -> int | None:
  try:
    value = int(path.read_text(encoding="ascii", errors="ignore").strip())
    return value if PORT_RANGE_START <= value <= PORT_RANGE_END else None
  except (OSError, ValueError):
    return None


def read_published_ports() -> list[int]:
  ports: list[int] = []

  def add(port: int | None) -> None:
    if port is not None and port not in ports:
      ports.append(port)

  for directory in _bridge_dirs():
    add(_read_port_file(directory / "port.txt"))
  add(_read_port_file(PUBLIC_PORT_FILE))

  try:
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_PATH) as key:
      value, _ = winreg.QueryValueEx(key, REG_PORT_VALUE)
      add(int(value))
  except (ImportError, OSError, ValueError):
    pass

  return ports


def probe(port: int, timeout_s: float = 0.3) -> BridgeHello | None:
  """向端口发送 hello；不是 LTKBridge 时返回 None。"""

  try:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout_s) as sock:
      sock.settimeout(2.0)
      sock.sendall(b'{"cmd":"hello"}\n')
      buffer = b""
      while b"\n" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
          return None
        buffer += chunk
      hello = BridgeHello.model_validate_json(buffer.split(b"\n", 1)[0])
      if hello.ok and hello.service == "LTKBridge":
        return hello
  except (OSError, ValueError):
    return None
  return None


def _listening_ports(timeout_s: float = 0.3) -> list[int]:
  """并行探测端口范围，避免 Windows 上逐个连接超时。"""

  pending: dict[socket.socket, int] = {}
  in_progress = {0, errno.EINPROGRESS, errno.EWOULDBLOCK, errno.EALREADY, 10035}
  for port in range(PORT_RANGE_START, PORT_RANGE_END + 1):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setblocking(False)
    try:
      code = sock.connect_ex(("127.0.0.1", port))
      if code in in_progress:
        pending[sock] = port
      else:
        sock.close()
    except OSError:
      sock.close()

  listening: list[int] = []
  deadline = time.monotonic() + timeout_s
  try:
    while pending:
      remaining = deadline - time.monotonic()
      if remaining <= 0:
        break
      _, writable, failed = select.select([], list(pending), list(pending), remaining)
      for sock in set(writable) | set(failed):
        port = pending.pop(sock)
        try:
          if sock in writable and sock.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0:
            listening.append(port)
        except OSError:
          pass
        sock.close()
  finally:
    for sock in pending:
      sock.close()
  return sorted(listening)


def discover_bridge(expected_pid: int | None = None) -> BridgeEndpoint | None:
  """发现 bridge，并返回端口、hello 与可用 token。"""

  tokens = read_token_candidates()

  def accept(port: int) -> BridgeEndpoint | None:
    hello = probe(port)
    if hello is None:
      return None
    if expected_pid is not None and hello.pid != expected_pid:
      return None
    return BridgeEndpoint(port=port, hello=hello, token=tokens[0] if tokens else "")

  for port in read_published_ports():
    endpoint = accept(port)
    if endpoint:
      return endpoint

  for port in _listening_ports():
    endpoint = accept(port)
    if endpoint:
      return endpoint

  return None
