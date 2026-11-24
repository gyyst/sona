@echo off
chcp 65001 >nul
setlocal

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v SonaLtkBridge /f >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Sona LTK 开机自启项。
) else (
  echo 已取消 Sona LTK 开机自启。
)
pause
