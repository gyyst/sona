"""协议模型测试。"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sona_ltk.models.bridge import (
  BridgeInner,
  BridgeResponse,
  LibraryMod,
  parse_install_value,
)
from sona_ltk.models.config import BridgeConfig
from sona_ltk.models.events import AuthMessage, ServerStatus, SkinSelection, parse_client_message
from sona_ltk.models.lcu import ChampSelectSession, GameflowPhase


def test_parse_skin_selection_camel_case() -> None:
  message = parse_client_message(
    '{"type":"skin-selection","championId":99,"skinId":99007,"baseSkinId":99007,'
    '"chromaId":null,"formId":null,"skinName":"Elementalist Lux","owned":false,'
    '"source":"manual","timestampMs":1770000000000}',
  )
  assert isinstance(message, SkinSelection)
  assert message.champion_id == 99
  assert message.base_skin_id == 99007
  assert message.chroma_id is None


def test_rejects_invalid_champion_id() -> None:
  with pytest.raises(ValidationError):
    SkinSelection(
      champion_id=0,
      skin_id=1,
      base_skin_id=1,
      skin_name="x",
      owned=False,
      source="manual",
      timestamp_ms=1,
    )


def test_parse_auth() -> None:
  message = parse_client_message('{"type":"auth","token":"sona-test-token"}')
  assert isinstance(message, AuthMessage)
  assert message.token == "sona-test-token"


def test_server_status_uses_camel_case_aliases() -> None:
  status = ServerStatus(
    phase="ChampSelect",
    injection_status="applied",
    message="ok",
    skin_name="Lux",
    patcher_running=True,
    timestamp_ms=1,
  )
  payload = status.model_dump_json(by_alias=True)
  assert '"injectionStatus":"applied"' in payload
  assert '"patcherRunning":true' in payload


def test_parse_install_value() -> None:
  response = BridgeResponse.model_validate(
    {
      "ok": True,
      "response": {
        "value": {
          "kind": "installed",
          "mod": {"id": "m1", "name": "Sona_99", "enabled": False},
        },
      },
    },
  )
  install = parse_install_value(response)
  assert install is not None
  assert install.kind == "installed"
  assert install.mod is not None
  assert install.mod.id == "m1"


def test_bridge_error_text() -> None:
  response = BridgeResponse.model_validate(
    {"ok": False, "error": {"code": "PATCHER", "kind": "BUSY", "message": "stop it"}},
  )
  assert "PATCHER" in response.error_text
  assert "BUSY" in response.error_text


def test_unknown_phase_falls_back_to_none() -> None:
  assert GameflowPhase.from_api("SomethingNew") is GameflowPhase.NONE
  assert GameflowPhase.from_api("ChampSelect") is GameflowPhase.CHAMP_SELECT


def test_bridge_inner_accepts_unknown_fields() -> None:
  inner = BridgeInner.model_validate({"value": {"kind": "installed"}, "extra": {"x": 1}})
  assert inner.value is not None


def test_config_reads_camel_case_json() -> None:
  config = BridgeConfig.model_validate_json(
    '{"websocketPort":50123,"authToken":"another-token","autoStartLtk":false,'
    '"skinLibraryMode":"local","skinLibraryRoot":"C:/skins"}',
  )
  assert config.websocket_port == 50123
  assert config.auth_token == "another-token"
  assert config.auto_start_ltk is False
  assert config.skin_library_mode == "local"


def test_config_empty_paths_become_none() -> None:
  config = BridgeConfig.model_validate_json(
    '{"ltkLauncherPath":"","ltkManagerPath":"  ","lcuLockfilePath":""}',
  )
  assert config.ltk_launcher_path is None
  assert config.ltk_manager_path is None
  assert config.lcu_lockfile_path is None


def test_library_mod_coerces_numeric_id() -> None:
  mod = LibraryMod.model_validate({"id": 123, "name": None, "enabled": True})
  assert mod.id == "123"
  assert mod.name == ""


def test_lcu_session_ignores_unknown_fields() -> None:
  session = ChampSelectSession.model_validate(
    {
      "localPlayerCellId": 1,
      "myTeam": [{"cellId": 1, "championId": 99, "selectedSkinId": 99007, "puuid": "x"}],
      "actions": [[[{"actorCellId": 1, "type": "pick", "completed": True, "id": 9}]]],
      "timer": {"phase": "BAN_PICK"},
    },
  )
  assert session.local_player() is not None
  assert session.local_player_locked() is True
