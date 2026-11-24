"""协议与配置的强类型模型。"""

from .bridge import BridgeHello, BridgeInner, BridgeResponse, InstallValue, LibraryMod
from .config import BridgeConfig, load_config
from .events import AuthMessage, ClientMessage, ServerStatus, SkinSelection, parse_client_message
from .lcu import ChampSelectAction, ChampSelectPlayer, ChampSelectSession, GameflowPhase, LockfileData

__all__ = [
  "AuthMessage",
  "BridgeConfig",
  "BridgeHello",
  "BridgeInner",
  "BridgeResponse",
  "ChampSelectAction",
  "ChampSelectPlayer",
  "ChampSelectSession",
  "ClientMessage",
  "GameflowPhase",
  "InstallValue",
  "LibraryMod",
  "LockfileData",
  "ServerStatus",
  "SkinSelection",
  "load_config",
  "parse_client_message",
]
