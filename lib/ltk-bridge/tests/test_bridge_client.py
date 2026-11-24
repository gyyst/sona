"""LTF bridge 客户端协议测试（本地假服务器）。"""

from __future__ import annotations

import json
import socket
import threading
from collections.abc import Iterator

import pytest

from sona_ltk.models.bridge import BridgeHello
from sona_ltk.services.bridge_client import BridgeUnavailable, LtkBridge
from sona_ltk.services.bridge_discovery import BridgeEndpoint


class FakeBridgeServer:
  """接受单行 JSON 请求并回复单行 JSON。"""

  def __init__(self, token: str) -> None:
    self.token = token
    self.requests: list[dict[str, object]] = []
    self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    self._socket.bind(("127.0.0.1", 0))
    self._socket.listen(5)
    self.port = self._socket.getsockname()[1]
    self._thread = threading.Thread(target=self._serve, daemon=True)
    self._thread.start()

  def _serve(self) -> None:
    while True:
      try:
        connection, _ = self._socket.accept()
      except OSError:
        return
      with connection:
        buffer = b""
        while b"\n" not in buffer:
          chunk = connection.recv(4096)
          if not chunk:
            break
          buffer += chunk
        if b"\n" not in buffer:
          continue
        request = json.loads(buffer.split(b"\n", 1)[0])
        assert isinstance(request, dict)
        self.requests.append(request)
        connection.sendall((json.dumps(self._respond(request)) + "\n").encode())

  def _respond(self, request: dict[str, object]) -> dict[str, object]:
    command = request.get("cmd")
    if command == "hello":
      return {"ok": True, "service": "LTKBridge", "pid": 123, "port": self.port}
    if command == "ping":
      return {"ok": True, "pong": 1}
    if request.get("token") != self.token:
      return {"ok": False, "error": "unauthorized: missing or wrong token"}
    if command == "list":
      return {"ok": True, "library": [{"id": "m1", "name": "Skin", "enabled": True}]}
    if command == "import":
      return {
        "ok": True,
        "response": {"value": {"kind": "installed", "mod": {"id": "m2", "name": "New", "enabled": False}}},
      }
    return {"ok": True}

  def close(self) -> None:
    self._socket.close()


@pytest.fixture
def server() -> Iterator[FakeBridgeServer]:
  instance = FakeBridgeServer("good-token")
  try:
    yield instance
  finally:
    instance.close()


def _endpoint(server: FakeBridgeServer, token: str = "good-token") -> BridgeEndpoint:
  hello = BridgeHello(ok=True, service="LTKBridge", pid=server.port, port=server.port)
  return BridgeEndpoint(port=server.port, hello=hello, token=token)


def test_ping(server: FakeBridgeServer) -> None:
  assert LtkBridge(_endpoint(server)).ping() is True


def test_list_mods(server: FakeBridgeServer) -> None:
  mods = LtkBridge(_endpoint(server)).list_mods()
  assert len(mods) == 1
  assert mods[0].id == "m1"
  assert mods[0].enabled is True


def test_import_response_is_parsed(server: FakeBridgeServer) -> None:
  response = LtkBridge(_endpoint(server)).import_skin("/tmp/skin.zip", "Sona_Test")
  assert response.ok is True
  assert response.response is not None
  assert response.response.value is not None


def test_retries_with_another_published_token(
  server: FakeBridgeServer,
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  monkeypatch.setattr(
    "sona_ltk.services.bridge_client.read_token_candidates",
    lambda: ["bad-token", "good-token"],
  )
  bridge = LtkBridge(_endpoint(server, token="bad-token"))
  assert bridge.ping() is True
  mods = bridge.list_mods()
  assert mods[0].id == "m1"
  assert [request["token"] for request in server.requests if "token" in request] == [
    "bad-token",
    "good-token",
  ]


def test_missing_endpoint_raises(monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr("sona_ltk.services.bridge_client.discover_bridge", lambda pid=None: None)
  bridge = LtkBridge()
  assert bridge.ping() is False
  with pytest.raises(BridgeUnavailable, match="not reachable"):
    bridge.list_mods()
