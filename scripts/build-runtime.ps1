param(
  [string]$SourceRoot = (Join-Path $PSScriptRoot "..\vendor\nullclaw-source"),
  [string]$OutputDir = (Join-Path $PSScriptRoot "..\runtime\bin")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceRoot)) {
  throw "NullClaw source not found at $SourceRoot"
}

if (-not (Get-Command zig -ErrorAction SilentlyContinue)) {
  throw "zig is required to build the bundled runtime."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Push-Location $SourceRoot
try {
  zig build -Doptimize=ReleaseSmall
  $builtBinary = Join-Path $SourceRoot "zig-out\bin\nullclaw.exe"
  if (-not (Test-Path $builtBinary)) {
    throw "Expected built binary not found at $builtBinary"
  }
  Copy-Item -Force -Path $builtBinary -Destination (Join-Path $OutputDir "nullclaw.exe")
}
finally {
  Pop-Location
}

Write-Host "Bundled runtime copied to $OutputDir"
