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
from sona_ltk.models.events import (
  AuthMessage,
  InstallLtkManager,
  ServerStatus,
  SkinSelection,
  parse_client_message,
)
from sona_ltk.models.lcu import ChampSelectSession, GameflowPhase
from sona_ltk.models.ltk_manager import ManagerInstallStatus


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


def test_parse_install_manager_command() -> None:
  message = parse_client_message('{"type":"install-ltk-manager"}')
  assert isinstance(message, InstallLtkManager)


def test_server_status_uses_camel_case_aliases() -> None:
  status = ServerStatus(
    phase="ChampSelect",
    injection_status="applied",
    message="ok",
    skin_name="Lux",
    patcher_running=True,
    ltk_manager_status="not-installed",
    ltk_manager_progress=42,
    ltk_manager_message="未检测到 LTK Manager",
    capabilities=["ltk-manager-install"],
    timestamp_ms=1,
  )
  payload = status.model_dump_json(by_alias=True)
  assert '"injectionStatus":"applied"' in payload
  assert '"patcherRunning":true' in payload
  assert '"ltkManagerStatus":"not-installed"' in payload
  assert '"ltkManagerProgress":42' in payload
  assert '"capabilities":["ltk-manager-install"]' in payload


def test_server_status_manager_fields_default() -> None:
  status = ServerStatus(
    phase="",
    injection_status="idle",
    message="",
    timestamp_ms=1,
  )
  assert status.ltk_manager_status == ManagerInstallStatus.UNKNOWN
  assert status.ltk_manager_progress == 0
  assert status.capabilities == []


def test_server_status_rejects_unknown_manager_status() -> None:
  with pytest.raises(ValidationError):
    ServerStatus(
      phase="",
      injection_status="idle",
      message="",
      ltk_manager_status="bogus",
      timestamp_ms=1,
    )


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
    '{"ltkLauncherPath":"","ltkManagerPath":"  ","lcuLockfilePath":"",'
    '"ltkManagerVersion":"","ltkManagerDownloadUrl":"","ltkManagerSha256":"","ltkManagerSize":0}',
  )
  assert config.ltk_launcher_path is None
  assert config.ltk_manager_path is None
  assert config.lcu_lockfile_path is None
  assert config.ltk_manager_version is None
  assert config.ltk_manager_download_url is None
  assert config.ltk_manager_sha256 is None
  assert config.ltk_manager_size is None
  assert config.ltk_manager_download_timeout_s == 300.0
  assert config.ltk_manager_install_timeout_s == 600.0


def test_config_rejects_invalid_manager_sha() -> None:
  with pytest.raises(ValidationError):
    BridgeConfig(ltk_manager_sha256="not-a-hash")


def test_config_rejects_non_https_manager_url() -> None:
  with pytest.raises(ValidationError):
    BridgeConfig(ltk_manager_download_url="http://example.com/setup.exe")


def test_config_rejects_invalid_manager_version() -> None:
  with pytest.raises(ValidationError):
    BridgeConfig(ltk_manager_version="v1.33")


def test_config_rejects_invalid_manager_size() -> None:
  with pytest.raises(ValidationError):
    BridgeConfig(ltk_manager_size=-1)


def test_config_rejects_too_small_timeout() -> None:
  with pytest.raises(ValidationError):
    BridgeConfig(ltk_manager_download_timeout_s=5)


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
