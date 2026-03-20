$ErrorActionPreference = "Stop"

$source = "D:\Nullcalw\nullclaw-main\nullclaw-main\zig-out\bin\nullclaw.exe"
$target = Join-Path $PSScriptRoot "..\runtime\bin\nullclaw.exe"

if (-not (Test-Path $source)) {
  Write-Host "未找到已构建的 nullclaw.exe：$source"
  exit 1
}

New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
Copy-Item -Force $source $target
Write-Host "已同步 runtime 二进制到 $target"

