$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$vendor = Join-Path $root "vendor"
$chatUiSource = "D:\Nullcalw\nullclaw-chat-ui-main\nullclaw-chat-ui-main"

New-Item -ItemType Directory -Force $vendor | Out-Null

Write-Host "同步 chat-ui 协议层快照..."
robocopy $chatUiSource (Join-Path $vendor "nullclaw-chat-ui") src docs package.json package-lock.json /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
Write-Host "同步完成。"

