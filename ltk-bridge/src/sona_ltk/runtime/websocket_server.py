"""仅监听 127.0.0.1 的 WebSocket 服务。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from urllib.parse import urlparse

from pydantic import ValidationError
from websockets.asyncio.server import ServerConnection, serve

from ..models.events import AuthMessage, InstallLtkManager, ServerStatus, SkinSelection, parse_client_message

SelectionHandler = Callable[[SkinSelection], Awaitable[None]]
StatusProvider = Callable[[], ServerStatus]
CommandHandler = Callable[[], Awaitable[None]]


class WebSocketServer:
  """首条消息认证；Origin 与 loopback 双重限制。"""

  def __init__(
    self,
    port: int,
    token: str,
    on_selection: SelectionHandler,
    status_provider: StatusProvider,
    on_install_manager: CommandHandler,
  ) -> None:
    self._port = port
    self._token = token
    self._on_selection = on_selection
    self._status_provider = status_provider
    self._on_install_manager = on_install_manager
    self._clients: set[ServerConnection] = set()
    self._server = None

  async def start(self) -> None:
    self._server = await serve(self._handle, "127.0.0.1", self._port)

  async def stop(self) -> None:
    if self._server is not None:
      self._server.close()
      await self._server.wait_closed()
      self._server = None
    for client in list(self._clients):
      await client.close()
    self._clients.clear()

  async def broadcast(self, status: ServerStatus | None = None) -> None:
    payload = (status or self._status_provider()).model_dump_json(by_alias=True)
    for client in list(self._clients):
      try:
        await client.send(payload)
      except Exception:  # noqa: BLE001 - 断连客户端从集合移除即可
        self._clients.discard(client)

  async def _handle(self, websocket: ServerConnection) -> None:
    if not self._origin_allowed(websocket.request.headers.get("Origin")):
      await websocket.close(code=1008, reason="origin not allowed")
      return

    try:
      first = parse_client_message(await websocket.recv())
    except (ValidationError, TypeError):
      await websocket.close(code=1008, reason="authentication required")
      return
    if not isinstance(first, AuthMessage) or first.token != self._token:
      await websocket.close(code=1008, reason="invalid token")
      return

    self._clients.add(websocket)
    try:
      await websocket.send(self._status_provider().model_dump_json(by_alias=True))
      async for raw in websocket:
        try:
          message = parse_client_message(raw)
        except (ValidationError, TypeError):
          continue
        if isinstance(message, SkinSelection):
          await self._on_selection(message)
        elif isinstance(message, InstallLtkManager):
          await self._on_install_manager()
    finally:
      self._clients.discard(websocket)

  @staticmethod
  def _origin_allowed(origin: str | None) -> bool:
    if origin is None or origin == "null":
      return True
    parsed = urlparse(origin)
    return parsed.scheme in {"http", "https"} and parsed.hostname in {
      "127.0.0.1",
      "localhost",
      "::1",
    }
