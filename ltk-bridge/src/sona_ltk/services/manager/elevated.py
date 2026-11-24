"""以管理员权限启动安装器并等待退出（Windows UAC）。

`subprocess` / `CreateProcess` 不会为带 requireAdministrator 清单的安装器
触发 UAC，只会返回 WinError 740。这里使用 ShellExecuteExW + runas。
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from pathlib import Path

ERROR_CANCELLED = 1223
SEE_MASK_NOCLOSEPROCESS = 0x00000040
SEE_MASK_NOASYNC = 0x00000100
SW_HIDE = 0
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
COINIT_MULTITHREADED = 0x0


class ElevationCancelled(RuntimeError):
  """用户在 UAC 中取消授权。"""


class ElevationError(RuntimeError):
  """无法启动或等待安装程序。"""


class _SHELLEXECUTEINFOW(ctypes.Structure):
  _fields_ = [
    ("cbSize", wintypes.DWORD),
    ("fMask", ctypes.c_ulong),
    ("hwnd", wintypes.HWND),
    ("lpVerb", wintypes.LPCWSTR),
    ("lpFile", wintypes.LPCWSTR),
    ("lpParameters", wintypes.LPCWSTR),
    ("lpDirectory", wintypes.LPCWSTR),
    ("nShow", ctypes.c_int),
    ("hInstApp", wintypes.HINSTANCE),
    ("lpIDList", ctypes.c_void_p),
    ("lpClass", wintypes.LPCWSTR),
    ("hkeyClass", wintypes.HKEY),
    ("dwHotKey", wintypes.DWORD),
    ("hIcon", wintypes.HANDLE),
    ("hProcess", wintypes.HANDLE),
  ]


def run_elevated(executable: Path, parameters: str, timeout_s: float) -> int:
  """弹 UAC 启动 `executable`，等待结束并返回退出码。"""

  if sys.platform != "win32":
    raise ElevationError("LTK Manager 安装仅支持 Windows")

  shell32 = ctypes.WinDLL("shell32", use_last_error=True)
  kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
  ole32 = ctypes.WinDLL("ole32", use_last_error=True)

  # 调用来自 asyncio.to_thread 的工作线程：没有消息循环，按微软文档
  # 同时使用 SEE_MASK_NOASYNC 并初始化 COM，避免 ShellExecuteEx 提前返回。
  ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
  ole32.CoInitializeEx.restype = ctypes.c_long
  ole32.CoUninitialize.argtypes = []
  com_result = ole32.CoInitializeEx(None, COINIT_MULTITHREADED)
  com_initialized = com_result in (0, 1)  # S_OK / S_FALSE

  info = _SHELLEXECUTEINFOW()
  info.cbSize = ctypes.sizeof(info)
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC
  info.lpVerb = "runas"
  info.lpFile = str(executable)
  info.lpParameters = parameters
  info.lpDirectory = str(executable.parent)
  info.nShow = SW_HIDE

  try:
    shell32.ShellExecuteExW.argtypes = [ctypes.POINTER(_SHELLEXECUTEINFOW)]
    shell32.ShellExecuteExW.restype = wintypes.BOOL
    if not shell32.ShellExecuteExW(ctypes.byref(info)):
      error = ctypes.get_last_error()
      if error == ERROR_CANCELLED:
        raise ElevationCancelled("已取消 UAC 授权，LTK Manager 未安装")
      raise ElevationError(f"无法启动安装程序（WinError {error}）")
    if not info.hProcess:
      raise ElevationError("安装程序未返回进程句柄")

    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    try:
      wait_ms = max(1, int(timeout_s * 1000))
      result = kernel32.WaitForSingleObject(info.hProcess, wait_ms)
      if result == WAIT_TIMEOUT:
        raise ElevationError(
          "安装程序超时未结束，安装器可能仍在运行；请检查 UAC 弹窗或安全软件，"
          "等待其结束后再重试",
        )
      if result != WAIT_OBJECT_0:
        error = ctypes.get_last_error()
        raise ElevationError(f"等待安装程序失败（WinError {error}）")

      exit_code = wintypes.DWORD()
      if not kernel32.GetExitCodeProcess(info.hProcess, ctypes.byref(exit_code)):
        raise ElevationError("无法获取安装程序退出码")
      return int(exit_code.value)
    finally:
      kernel32.CloseHandle(info.hProcess)
  finally:
    if com_initialized:
      ole32.CoUninitialize()
