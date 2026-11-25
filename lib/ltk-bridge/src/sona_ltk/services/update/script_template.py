"""PowerShell 替换脚本模板（固定内容，仅替换健康检查秒数占位符）。"""

from __future__ import annotations

SCRIPT_TEMPLATE = r"""$ErrorActionPreference = 'Stop'
$script:planPath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'sona-ltk-update.json'
$script:target = $null
$script:staged = $null
$script:exe = 'sona-ltk.exe'
$script:logPath = $null
$script:arguments = ''
$script:replaced = New-Object 'System.Collections.Generic.List[string]'

function Write-UpdateLog([string]$message) {
  try {
    if ([string]::IsNullOrWhiteSpace($script:logPath)) { return }
    $parent = Split-Path -Parent $script:logPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Add-Content -LiteralPath $script:logPath -Value ((Get-Date).ToString('s') + ' ' + $message) -Encoding utf8
  } catch { }
}

function Resolve-SafeChild([string]$base, [string]$relative) {
  if ([string]::IsNullOrWhiteSpace($base)) { throw '根目录为空' }
  if ([string]::IsNullOrWhiteSpace($relative)) { throw '文件路径为空' }
  if ($relative -match '^[\\/]') { throw "拒绝绝对路径：$relative" }
  if ($relative -match '\\') { throw "拒绝反斜杠路径：$relative" }
  if ($relative -match ':') { throw "拒绝冒号路径：$relative" }
  if ($relative -match '(^|/)\.\.(/|$)') { throw "拒绝上级路径：$relative" }
  foreach ($part in $relative.Split('/')) {
    # Windows 会去掉路径段末尾的空格与点；`.. ` 等价于 `..`，必须按段拒绝
    if ($part -eq '' -or $part -eq '.' -or $part -eq '..') { throw "拒绝非法路径：$relative" }
    if ($part -ne $part.Trim() -or $part.EndsWith('.')) { throw "拒绝非法路径：$relative" }
  }
  $baseFull = [System.IO.Path]::GetFullPath($base).TrimEnd('\')
  $full = [System.IO.Path]::GetFullPath((Join-Path $baseFull $relative))
  if (-not $full.StartsWith($baseFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝越界路径：$relative"
  }
  return $full
}

function ConvertTo-CommandLine([object[]]$items) {
  # Windows 命令行引用算法（CommandLineToArgvW）：重启时保留旧进程的 --port/--token。
  $builder = New-Object System.Text.StringBuilder
  foreach ($item in $items) {
    $text = [string]$item
    if ($builder.Length -gt 0) { [void]$builder.Append(' ') }
    if ($text.Length -eq 0) { [void]$builder.Append('""'); continue }
    if ($text -notmatch '[\s"]') { [void]$builder.Append($text); continue }
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($char in $text.ToCharArray()) {
      if ($char -eq '\') { $slashes += 1; continue }
      if ($char -eq '"') {
        [void]$builder.Append(('\' * (2 * $slashes + 1)))
        [void]$builder.Append('"')
      } else {
        if ($slashes -gt 0) { [void]$builder.Append(('\' * $slashes)) }
        [void]$builder.Append($char)
      }
      $slashes = 0
    }
    if ($slashes -gt 0) { [void]$builder.Append(('\' * (2 * $slashes))) }
    [void]$builder.Append('"')
  }
  return $builder.ToString()
}

function Restore-ReplacedFiles {
  for ($index = $script:replaced.Count - 1; $index -ge 0; $index--) {
    $relative = $script:replaced[$index]
    try {
      $destination = Resolve-SafeChild $script:target $relative
      $backup = $destination + '.old'
      if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
      if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination -Force }
    } catch {
      Write-UpdateLog ("回滚失败 {0}: {1}" -f $relative, $_.Exception.Message)
    }
  }
  $script:replaced.Clear()
}

function Start-Backend {
  if ([string]::IsNullOrWhiteSpace($script:target)) { return }
  try {
    $exePath = Resolve-SafeChild $script:target $script:exe
    if (Test-Path -LiteralPath $exePath) {
      if ($script:arguments) {
        Start-Process -FilePath $exePath -WorkingDirectory $script:target `
          -ArgumentList $script:arguments | Out-Null
      } else {
        Start-Process -FilePath $exePath -WorkingDirectory $script:target | Out-Null
      }
    }
  } catch {
    Write-UpdateLog ("启动后台失败：{0}" -f $_.Exception.Message)
  }
}

try {
  $plan = Get-Content -LiteralPath $script:planPath -Raw -Encoding utf8 | ConvertFrom-Json
  $script:target = [string]$plan.target
  $script:staged = [string]$plan.staged
  $script:exe = [string]$plan.exe
  $script:logPath = [string]$plan.log
  if ($plan.PSObject.Properties.Name -contains 'args' -and $null -ne $plan.args) {
    $script:arguments = ConvertTo-CommandLine @($plan.args)
  }
  $files = @($plan.files)
  if (-not [System.IO.Path]::IsPathRooted($script:target)) { throw '目标目录必须是绝对路径' }
  if (-not [System.IO.Path]::IsPathRooted($script:staged)) { throw '暂存目录必须是绝对路径' }
  if ($files.Count -eq 0) { throw '更新文件列表为空' }
  if ([string]::IsNullOrWhiteSpace($script:exe)) { throw '可执行文件名称为空' }

  $pendingPid = [int]$plan.pid
  if ($pendingPid -gt 0) {
    try { Wait-Process -Id $pendingPid -Timeout 60 -ErrorAction Stop } catch { }
    if (Get-Process -Id $pendingPid -ErrorAction SilentlyContinue) { throw '旧后台仍在运行，取消替换' }
  }

  Write-UpdateLog ("开始替换 {0} 个文件" -f $files.Count)
  foreach ($relative in $files) {
    $source = Resolve-SafeChild $script:staged $relative
    $destination = Resolve-SafeChild $script:target $relative
    if (-not (Test-Path -LiteralPath $source)) { throw "暂存文件缺失：$relative" }
    $parent = Split-Path -Parent $destination
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $backup = $destination + '.old'
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    if (Test-Path -LiteralPath $destination) {
      Move-Item -LiteralPath $destination -Destination $backup -Force
      $script:replaced.Add($relative) | Out-Null
    }
    Move-Item -LiteralPath $source -Destination $destination -Force
    if (-not $script:replaced.Contains($relative)) { $script:replaced.Add($relative) | Out-Null }
  }

  Write-UpdateLog '文件替换完成，启动新版本'
  $exePath = Resolve-SafeChild $script:target $script:exe
  if ($script:arguments) {
    $newProcess = Start-Process -FilePath $exePath -WorkingDirectory $script:target `
      -ArgumentList $script:arguments -PassThru
  } else {
    $newProcess = Start-Process -FilePath $exePath -WorkingDirectory $script:target -PassThru
  }
  Start-Sleep -Seconds __HEALTH_CHECK_SECONDS__
  if ($newProcess.HasExited) { throw ("新版本启动后退出，退出码 {0}" -f $newProcess.ExitCode) }

  foreach ($relative in $files) {
    $destination = Resolve-SafeChild $script:target $relative
    $backup = $destination + '.old'
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue }
  }
  $script:replaced.Clear()
  Write-UpdateLog '后台更新成功'
  Remove-Item -LiteralPath $script:staged -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $script:planPath) 'sona-update.zip') -Force -ErrorAction SilentlyContinue
} catch {
  Write-UpdateLog ("后台更新失败：{0}" -f $_.Exception.Message)
  if ([string]::IsNullOrWhiteSpace($script:target)) {
    # 计划文件读取失败时脚本仍与 exe 同目录，至少把旧版本重新拉起来
    $script:target = Split-Path -Parent $script:planPath
  }
  Restore-ReplacedFiles
  Start-Backend
  exit 1
}
exit 0
"""
