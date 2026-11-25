"""LTK 启动失败提示：把错误类别映射为可操作的中文说明。"""

from __future__ import annotations

from ..models.bridge import BridgeResponse, PatcherFailureValue, bridge_error_kind

# 权限链路（Manager 不提升，只提升 patcher host，见 LTK Manager ADR-0081）
LEAGUE_ELEVATED_HINT = (
  "英雄联盟以管理员权限运行。支持提权注入的 LTK Manager 会请求提升 patcher host，"
  "请在 UAC 弹窗中选择「是」；如果仍然报这个错误，说明当前 LTK Manager 版本会直接拒绝"
  "管理员权限的 League，请升级并把它安装在 Program Files 下后重试"
)
MANAGER_ELEVATED_HINT = "LTK Manager 以管理员权限运行，请改为普通权限启动后再重试"
CDP_UNAVAILABLE_HINT = (
  "LTK Manager 的调试端口不可用（CDP unavailable）：请关闭 LTK Manager，再由 Sona 重新启动；"
  "仍然失败时查看 ltk_launcher 日志"
)
STAGING_REFUSED_HINT = (
  "LTK Manager 无法在安装目录安全暂存 patcher：请把它安装在 Program Files 下，"
  "接受 UAC 授权后重试"
)
UAC_CANCELLED_HINT = "UAC 授权被取消，请重新选择皮肤并在弹窗中允许"
STAGING_VERIFY_FAILED_HINT = (
  "patcher 暂存校验失败（复制不完整或摘要不一致）；请重新选择皮肤重试，"
  "仍然失败时重新安装 LTK Manager"
)
BUILD_FAILED_HINT = (
  "换肤资源准备失败（overlay 构建未完成）；请检查游戏路径、皮肤包与 LTK Manager 日志后重试"
)
DLL_UNAVAILABLE_HINT = "patcher DLL 不可用，请检查网络连接，或更新 LTK Manager 后重试"
HOST_FAILED_HINT = "注入进程启动失败，请查看 LTK Manager 日志后重试"
INJECTION_FAILED_HINT = "DLL 注入失败，请查看 LTK Manager 日志后重试"

# patcher 错误文本里能识别出的提权/取消信号
_UAC_MARKERS = (
  "user account control",
  "uac",
  "requires elevation",
  "os error 740",
  "os error 1223",
  "elevated helper",
  "run elevated",
)


def _escalation_for(kind: str, text: str) -> str | None:
  if "MANAGER_ELEVATED" in kind or "MANAGER_ELEVATED" in text:
    return MANAGER_ELEVATED_HINT
  if "STAGING_REFUSED" in kind or "STAGING_REFUSED" in text:
    return STAGING_REFUSED_HINT
  if "LEAGUE_ELEVATED" in kind or "LEAGUE_ELEVATED" in text:
    return LEAGUE_ELEVATED_HINT

  lowered = text.lower()
  if "cdp unavailable" in lowered:
    return CDP_UNAVAILABLE_HINT
  if any(marker in lowered for marker in _UAC_MARKERS):
    return UAC_CANCELLED_HINT
  if "staging the elevated patcher" in lowered or "does not match its digest" in lowered:
    return STAGING_VERIFY_FAILED_HINT
  return None


def escalation_hint(response: BridgeResponse) -> str | None:
  """识别一条失败响应里的提权/取消信号；其他错误返回 None。"""

  return _escalation_for(bridge_error_kind(response) or "", response.error_text)


def failure_hint(failure: PatcherFailureValue) -> str | None:
  """识别 patcher 状态里记录的失败类别；无法归类时返回 None。"""

  hint = _escalation_for(failure.kind or "", failure.message or "")
  if hint:
    return hint

  kind = failure.kind or ""
  if kind == "BUILD_FAILED":
    return BUILD_FAILED_HINT
  if kind == "DLL_UNAVAILABLE":
    return DLL_UNAVAILABLE_HINT
  if kind == "INJECTION_FAILED":
    return HOST_FAILED_HINT if (failure.stage or "").upper() == "HOST" else INJECTION_FAILED_HINT
  return None


def patcher_failure_message(response: BridgeResponse) -> str:
  """patcher 启动失败的对外文案：提权错误给出建议，其余错误带中文前缀。"""

  return escalation_hint(response) or f"patcher 启动失败：{response.error_text}"
