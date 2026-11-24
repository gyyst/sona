@echo off
chcp 65001 >nul
setlocal
set "EXE=%~dp0sona-ltk.exe"

if not exist "%EXE%" (
  echo [错误] 未找到 sona-ltk.exe，请先解压完整的 Sona LTK 运行包。
  pause
  exit /b 1
)

if not exist "%~dp0config.json" if exist "%~dp0config.example.json" (
  copy "%~dp0config.example.json" "%~dp0config.json" >nul
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v SonaLtkBridge /t REG_SZ /d "\"%EXE%\"" /f >nul
if errorlevel 1 (
  echo [错误] 写入开机自启失败。
  pause
  exit /b 1
)

echo 已设置开机自启：Sona LTK 后台将在每次登录 Windows 后自动运行。
echo 如需取消，请运行 uninstall-autostart.bat。
pause
