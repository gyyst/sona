"""WebSocket 认证、Origin 与消息分发测试。"""

from __future__ import annotations

import asyncio
import json
import socket

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from sona_ltk.models.events import ServerStatus, SkinSelection
from sona_ltk.runtime.websocket_server import WebSocketServer


def _free_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    return sock.getsockname()[1]


def _status() -> ServerStatus:
  return ServerStatus(
    phase="ChampSelect",
    injection_status="idle",
    message="idle",
    timestamp_ms=1,
  )


def _selection_json() -> str:
  return json.dumps(
    {
      "type": "skin-selection",
      "championId": 99,
      "skinId": 99007,
      "baseSkinId": 99007,
      "chromaId": None,
      "formId": None,
      "skinName": "Elementalist Lux",
      "owned": False,
      "source": "manual",
      "timestampMs": 1,
    },
  )


@pytest.mark.asyncio
async def test_authenticates_and_dispatches_selection() -> None:
  received: list[SkinSelection] = []

  async def on_selection(selection: SkinSelection) -> None:
    received.append(selection)

  port = _free_port()
  server = WebSocketServer(port, "test-token", on_selection, _status)
  await server.start()
  try:
    async with connect(
      f"ws://127.0.0.1:{port}",
      additional_headers={"Origin": "https://127.0.0.1:12345"},
    ) as websocket:
      await websocket.send('{"type":"auth","token":"test-token"}')
      first = json.loads(await websocket.recv())
      assert first["type"] == "status"

      await websocket.send(_selection_json())
      await asyncio.sleep(0.05)
      assert len(received) == 1
      assert received[0].skin_id == 99007
  finally:
    await server.stop()


@pytest.mark.asyncio
async def test_rejects_wrong_token() -> None:
  async def on_selection(selection: SkinSelection) -> None:
    raise AssertionError("不应收到未认证消息")

  port = _free_port()
  server = WebSocketServer(port, "test-token", on_selection, _status)
  await server.start()
  try:
    with pytest.raises(ConnectionClosed):
      async with connect(f"ws://127.0.0.1:{port}") as websocket:
        await websocket.send('{"type":"auth","token":"wrong-token"}')
        await websocket.recv()
  finally:
    await server.stop()


@pytest.mark.asyncio
async def test_rejects_non_loopback_origin() -> None:
  async def on_selection(selection: SkinSelection) -> None:
    raise AssertionError("不应收到外部 Origin 消息")

  port = _free_port()
  server = WebSocketServer(port, "test-token", on_selection, _status)
  await server.start()
  try:
    with pytest.raises((InvalidStatus, ConnectionClosed)):
      async with connect(
        f"ws://127.0.0.1:{port}",
        additional_headers={"Origin": "https://evil.example.com"},
      ) as websocket:
        await websocket.recv()
  finally:
    await server.stop()
