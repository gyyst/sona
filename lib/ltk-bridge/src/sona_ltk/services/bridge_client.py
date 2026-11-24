"""LTF newline-delimited JSON TCP 客户端。"""

from __future__ import annotations

import json
import socket
from collections.abc import Mapping

from ..models.bridge import BridgeHello, BridgeResponse, JsonValue, LibraryMod
from .bridge_discovery import BridgeEndpoint, discover_bridge, read_token_candidates

FAST_TIMEOUT_S = 5.0
DEFAULT_TIMEOUT_S = 60.0
IMPORT_TIMEOUT_S = 200.0


class BridgeUnavailable(RuntimeError):
  """bridge 不可达或响应无法解析。"""


class BridgeCommandError(RuntimeError):
  """bridge 返回 ok=false。"""


class LtkBridge:
  """每次请求新建连接；不重发可能已执行的 import/toggle 请求。"""

  def __init__(self, endpoint: BridgeEndpoint | None = None) -> None:
    self._endpoint = endpoint
    self._token = endpoint.token if endpoint else ""
    self._pid = endpoint.hello.pid if endpoint else None

  @property
  def pid(self) -> int | None:
    return self._pid

  def _ensure_endpoint(self) -> BridgeEndpoint:
    if self._endpoint is None:
      endpoint = discover_bridge(self._pid)
      if endpoint is None:
        raise BridgeUnavailable("LTKBridge API is not reachable")
      self._endpoint = endpoint
      self._token = endpoint.token
      self._pid = endpoint.hello.pid
    return self._endpoint

  def _send(self, payload: Mapping[str, JsonValue], timeout_s: float) -> BridgeResponse:
    endpoint = self._ensure_endpoint()
    try:
      with socket.create_connection(("127.0.0.1", endpoint.port), timeout=1.0) as sock:
        sock.settimeout(timeout_s)
        sock.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        buffer = b""
        while b"\n" not in buffer:
          chunk = sock.recv(65536)
          if not chunk:
            raise ConnectionError("bridge closed the connection")
          buffer += chunk
      return BridgeResponse.model_validate_json(buffer.split(b"\n", 1)[0])
    except (OSError, ValueError) as exc:
      raise BridgeUnavailable(f"LTKBridge request failed: {exc}") from exc

  def request(
    self,
    command: str,
    fields: Mapping[str, JsonValue] | None = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
  ) -> BridgeResponse:
    payload: dict[str, JsonValue] = {"cmd": command, **(fields or {})}
    if command in {"hello", "ping"}:
      return self._send(payload, timeout_s)

    response = self._send({**payload, "token": self._token}, timeout_s)
    if not self._is_unauthorized(response):
      return response

    tried = {self._token}
    for token in read_token_candidates():
      if token in tried:
        continue
      tried.add(token)
      retry = self._send({**payload, "token": token}, timeout_s)
      if not self._is_unauthorized(retry):
        self._token = token
        return retry
      response = retry
    return response

  def hello(self) -> BridgeHello:
    response = self.request("hello", timeout_s=FAST_TIMEOUT_S)
    if not response.ok:
      raise BridgeCommandError(response.error_text)
    return BridgeHello.model_validate(response.model_dump())

  def ping(self) -> bool:
    try:
      return self.request("ping", timeout_s=FAST_TIMEOUT_S).ok
    except BridgeUnavailable:
      return False

  def list_mods(self) -> list[LibraryMod]:
    response = self.request("list")
    if response.library is None:
      raise BridgeCommandError(response.error_text)
    return response.library

  def import_skin(self, path: str, name: str) -> BridgeResponse:
    return self.request(
      "import",
      {"path": path, "name": name},
      timeout_s=IMPORT_TIMEOUT_S,
    )

  def toggle(self, mod_id: str, enabled: bool) -> BridgeResponse:
    return self.request("toggle", {"target": mod_id, "enabled": enabled})

  def uninstall(self, mod_id: str) -> BridgeResponse:
    return self.request("uninstall", {"target": mod_id})

  def start_patcher(self) -> BridgeResponse:
    return self.request("start_patcher")

  def stop_patcher(self) -> BridgeResponse:
    return self.request("stop_patcher")

  def patcher_status(self) -> BridgeResponse:
    return self.request("patcher_status")

  def kill(self) -> BridgeResponse:
    try:
      return self.request("kill", timeout_s=FAST_TIMEOUT_S)
    except BridgeUnavailable:
      return BridgeResponse(ok=True, note="connection dropped")

  @staticmethod
  def _is_unauthorized(response: BridgeResponse) -> bool:
    return not response.ok and response.error_text.startswith("unauthorized")
