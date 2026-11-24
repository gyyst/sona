param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "bin"
$obj = Join-Path $bin "obj"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
New-Item -ItemType Directory -Force -Path $obj | Out-Null

$cl = Get-Command cl.exe -ErrorAction SilentlyContinue
if (-not $cl) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "未找到 Visual Studio。请安装 Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载，或使用 GitHub Actions 构建。"
  }
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $devCmd = Join-Path $vsPath "Common7\Tools\VsDevCmd.bat"
  if (-not (Test-Path $devCmd)) {
    throw "未找到 VsDevCmd.bat：$devCmd"
  }
  # 导入 VsDevCmd 设置的全部环境变量（PATH / INCLUDE / LIB），
  # 仅设置 PATH 时 cl.exe 仍会找不到标准头文件。
  $envLines = & cmd.exe /c "`"$devCmd`" -arch=x64 -host_arch=x64 >nul && set"
  foreach ($line in $envLines) {
    if ($line -match '^([^=]+)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

$common = @("/nologo", "/std:c++20", "/EHsc", "/MT", "/utf-8", "/W3")
# 必须始终是数组：单元素字符串在 splatting 时会被 PowerShell 按字符拆开
$optimization = @(if ($Configuration -eq "Debug") { "/Od"; "/Zi" } else { "/O2" })

Push-Location $PSScriptRoot
try {
  & cl.exe @common @optimization /Fo:"$obj\LeagueToolFlop_dll.obj" /LD "LeagueToolFlop_dll.cpp" `
    /Fe:"$bin\LeagueToolFlop.dll" `
    /link ws2_32.lib psapi.lib user32.lib advapi32.lib shell32.lib bcrypt.lib
  if ($LASTEXITCODE -ne 0) { throw "LeagueToolFlop.dll 编译失败" }

  & cl.exe @common @optimization /Fo:"$obj\LeagueToolFlop-inj.obj" "LeagueToolFlop-inj.cpp" `
    /Fe:"$bin\ltk_launcher.exe" `
    /link advapi32.lib shell32.lib user32.lib ws2_32.lib userenv.lib
  if ($LASTEXITCODE -ne 0) { throw "ltk_launcher.exe 编译失败" }
}
finally {
  Pop-Location
}

Write-Host "构建完成：$bin\LeagueToolFlop.dll"
Write-Host "构建完成：$bin\ltk_launcher.exe"
