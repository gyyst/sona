"""patcher 就绪等待与启动失败提示测试。"""

from __future__ import annotations

import pytest

from sona_ltk.models.bridge import (
  BridgeError,
  BridgeInner,
  BridgeResponse,
  PatcherFailureValue,
)
from sona_ltk.runtime.hints import (
  BUILD_FAILED_HINT,
  CDP_UNAVAILABLE_HINT,
  DLL_UNAVAILABLE_HINT,
  HOST_FAILED_HINT,
  INJECTION_FAILED_HINT,
  LEAGUE_ELEVATED_HINT,
  MANAGER_ELEVATED_HINT,
  STAGING_REFUSED_HINT,
  STAGING_VERIFY_FAILED_HINT,
  UAC_CANCELLED_HINT,
  escalation_hint,
  failure_hint,
  patcher_failure_message,
)
from sona_ltk.runtime.patcher_status import (
  BRIDGE_LOST_HINT,
  NOT_READY_HINT,
  patcher_is_running,
  wait_for_patcher_ready,
)
from sona_ltk.services.bridge_client import BridgeCommandError, BridgeUnavailable


class FakeStatusBridge:
  def __init__(self, *statuses: dict[str, object]) -> None:
    self.statuses = list(statuses) or [{"running": True, "phase": "patching"}]
    self.polls = 0

  def patcher_status(self) -> BridgeResponse:
    self.polls += 1
    index = min(self.polls - 1, len(self.statuses) - 1)
    return BridgeResponse(ok=True, response=BridgeInner(value=self.statuses[index]))


class FakeClock:
  """替换 time.monotonic / time.sleep，避免测试真的等待。"""

  def __init__(self) -> None:
    self.now = 0.0

  def monotonic(self) -> float:
    return self.now

  def sleep(self, seconds: float) -> None:
    self.now += seconds


def _start_failure(kind: str, message: str) -> BridgeResponse:
  """LTF 把 Tauri invoke 的结果嵌在 response 内层，域错误的 kind 再嵌一层。"""

  return BridgeResponse(
    ok=False,
    response=BridgeInner(
      ok=False,
      error=BridgeError(
        code="PATCHER",
        error=BridgeError(kind=kind, message=message),
      ),
    ),
  )


@pytest.fixture(autouse=True)
def _instant_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
  monkeypatch.setattr("sona_ltk.runtime.patcher_status.time.sleep", lambda _seconds: None)


def test_waiting_returns_once_the_phase_is_patching() -> None:
  bridge = FakeStatusBridge(
    {"running": True, "phase": "building"},
    {"running": True, "phase": "building"},
    {"running": True, "phase": "patching"},
  )

  wait_for_patcher_ready(bridge, 30)

  assert bridge.polls == 3


def test_waiting_returns_without_a_phase_for_an_old_manager() -> None:
  bridge = FakeStatusBridge({"running": True})

  wait_for_patcher_ready(bridge, 30)

  assert bridge.polls == 1


@pytest.mark.parametrize(
  ("error", "expected"),
  [
    (None, NOT_READY_HINT),
    (
      {"kind": "STAGING_REFUSED", "message": "cannot stage under Program Files"},
      STAGING_REFUSED_HINT,
    ),
    (
      {
        "kind": "INJECTION_FAILED",
        "stage": "HOST",
        "message": "the user dismissed the User Account Control prompt",
      },
      UAC_CANCELLED_HINT,
    ),
    ({"kind": "BUILD_FAILED", "message": "the game path is not configured"}, BUILD_FAILED_HINT),
  ],
)
def test_an_idle_patcher_reports_the_stored_failure(
  error: dict[str, object] | None,
  expected: str,
) -> None:
  status: dict[str, object] = {"running": False, "phase": "idle"}
  if error is not None:
    status["error"] = error
  bridge = FakeStatusBridge(status)

  with pytest.raises(BridgeCommandError) as raised:
    wait_for_patcher_ready(bridge, 30)

  assert str(raised.value) == expected


def test_waiting_times_out(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  clock = FakeClock()
  monkeypatch.setattr("sona_ltk.runtime.patcher_status.time.monotonic", clock.monotonic)
  monkeypatch.setattr("sona_ltk.runtime.patcher_status.time.sleep", clock.sleep)
  bridge = FakeStatusBridge({"running": True, "phase": "building"})

  with pytest.raises(BridgeCommandError) as raised:
    wait_for_patcher_ready(bridge, 30)

  assert "超时" in str(raised.value)
  assert bridge.polls > 100


def test_an_unknown_phase_is_waited_out_not_treated_as_ready(
  monkeypatch: pytest.MonkeyPatch,
) -> None:
  clock = FakeClock()
  monkeypatch.setattr("sona_ltk.runtime.patcher_status.time.monotonic", clock.monotonic)
  monkeypatch.setattr("sona_ltk.runtime.patcher_status.time.sleep", clock.sleep)
  bridge = FakeStatusBridge({"running": True, "phase": "stopping"})

  with pytest.raises(BridgeCommandError) as raised:
    wait_for_patcher_ready(bridge, 30)

  assert "超时" in str(raised.value)
  assert bridge.polls > 100


def test_a_lost_bridge_reports_a_chinese_error() -> None:
  class LostBridge:
    def patcher_status(self) -> BridgeResponse:
      raise BridgeUnavailable("LTKBridge request failed: timed out")

  with pytest.raises(BridgeCommandError) as raised:
    wait_for_patcher_ready(LostBridge(), 30)  # type: ignore[arg-type]

  assert str(raised.value) == BRIDGE_LOST_HINT


def test_patcher_is_running_reads_the_running_field() -> None:
  assert patcher_is_running(FakeStatusBridge({"running": True, "phase": "patching"}))
  assert not patcher_is_running(FakeStatusBridge({"running": False, "phase": "idle"}))


def test_patcher_is_running_reads_the_legacy_status_field() -> None:
  assert patcher_is_running(FakeStatusBridge({"status": "running"}))
  assert not patcher_is_running(FakeStatusBridge({"status": "stopped"}))


def test_staging_refusal_points_at_the_install_directory() -> None:
  response = _start_failure("STAGING_REFUSED", "cannot stage under the install directory")

  assert escalation_hint(response) == STAGING_REFUSED_HINT


def test_manager_elevated_points_at_the_manager() -> None:
  response = _start_failure("MANAGER_ELEVATED", "")

  assert escalation_hint(response) == MANAGER_ELEVATED_HINT


def test_league_elevated_points_at_the_uac_prompt() -> None:
  response = _start_failure("LEAGUE_ELEVATED", "")

  assert escalation_hint(response) == LEAGUE_ELEVATED_HINT


def test_a_cdp_unavailable_string_error_points_at_the_launcher() -> None:
  response = BridgeResponse.model_validate(
    {"ok": False, "response": {"ok": False, "error": "CDP unavailable or timed out"}},
  )

  assert escalation_hint(response) == CDP_UNAVAILABLE_HINT


def test_a_dismissed_uac_prompt_maps_to_the_cancel_hint() -> None:
  response = _start_failure(
    "INJECTION_FAILED",
    "staging the elevated patcher failed: the user dismissed the User Account Control prompt",
  )

  assert escalation_hint(response) == UAC_CANCELLED_HINT


def test_a_host_that_needs_elevation_maps_to_the_cancel_hint() -> None:
  response = _start_failure(
    "INJECTION_FAILED",
    "Failed to spawn host 'ltk_patcher_host.exe': The requested operation requires elevation. (os error 740)",
  )

  assert escalation_hint(response) == UAC_CANCELLED_HINT


def test_a_failed_staging_verification_points_at_the_staged_copy() -> None:
  response = _start_failure(
    "INJECTION_FAILED",
    "the staged patcher DLL does not match its digest abc",
  )

  assert escalation_hint(response) == STAGING_VERIFY_FAILED_HINT


def test_a_failed_staging_copy_points_at_the_staged_copy() -> None:
  response = _start_failure(
    "INJECTION_FAILED",
    "staging the elevated patcher failed: the system cannot find the file specified",
  )

  assert escalation_hint(response) == STAGING_VERIFY_FAILED_HINT


def test_an_unrelated_failure_keeps_its_text_with_a_chinese_prefix() -> None:
  response = _start_failure("INJECTION_FAILED", "host died")

  assert escalation_hint(response) is None
  message = patcher_failure_message(response)
  assert message.startswith("patcher 启动失败：")
  assert "host died" in message


def test_a_staging_refusal_recorded_in_the_status_points_at_the_install_directory() -> None:
  failure = PatcherFailureValue(kind="STAGING_REFUSED", message="cannot stage")

  assert failure_hint(failure) == STAGING_REFUSED_HINT


def test_a_cancelled_uac_recorded_in_the_status_maps_to_the_cancel_hint() -> None:
  failure = PatcherFailureValue(
    kind="INJECTION_FAILED",
    stage="HOST",
    message="staging the elevated patcher failed: the user dismissed the User Account Control prompt",
  )

  assert failure_hint(failure) == UAC_CANCELLED_HINT


def test_a_build_failure_recorded_in_the_status_maps_to_the_build_hint() -> None:
  failure = PatcherFailureValue(kind="BUILD_FAILED", message="the game path is not configured")

  assert failure_hint(failure) == BUILD_FAILED_HINT


def test_a_failed_staging_verification_in_the_status_points_at_the_staged_copy() -> None:
  failure = PatcherFailureValue(
    kind="INJECTION_FAILED",
    stage="HOST",
    message="the staged patcher DLL does not match its digest abc",
  )

  assert failure_hint(failure) == STAGING_VERIFY_FAILED_HINT


def test_a_missing_dll_recorded_in_the_status_maps_to_the_delivery_hint() -> None:
  failure = PatcherFailureValue(kind="DLL_UNAVAILABLE", reason="NETWORK")

  assert failure_hint(failure) == DLL_UNAVAILABLE_HINT


def test_a_host_failure_recorded_in_the_status_maps_by_its_stage() -> None:
  assert failure_hint(PatcherFailureValue(kind="INJECTION_FAILED", stage="HOST")) == HOST_FAILED_HINT
  assert (
    failure_hint(PatcherFailureValue(kind="INJECTION_FAILED", stage="INJECTION"))
    == INJECTION_FAILED_HINT
  )


def test_an_unknown_failure_records_no_hint() -> None:
  assert failure_hint(PatcherFailureValue(kind="SOMETHING_NEW")) is None
