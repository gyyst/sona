@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "sona-ltk.exe" (
  echo [错误] 未找到 sona-ltk.exe，请先解压完整的 Sona LTK 运行包。
  pause
  exit /b 1
)

if not exist "config.json" if exist "config.example.json" (
  copy "config.example.json" "config.json" >nul
)

start "Sona LTK Bridge" "%~dp0sona-ltk.exe"
echo Sona LTK 后台已启动。日志：%~dp0logs\sona-ltk.log
