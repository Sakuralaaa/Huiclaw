$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$uiRoot = Join-Path $projectRoot "ui"
$sourceIndex = Join-Path $uiRoot ".svelte-kit\output\prerendered\pages\index.html"
$targetIndex = Join-Path $uiRoot "build\index.html"

if (-not (Test-Path $sourceIndex)) {
  throw "Prerendered UI entry not found at $sourceIndex"
}

Copy-Item -Force $sourceIndex $targetIndex

$raw = Get-Content -Path $targetIndex -Raw
$raw = $raw -replace 'href="/', 'href="./'
$raw = $raw -replace 'import\("/', 'import("./'

Set-Content -Path $targetIndex -Value $raw -NoNewline
