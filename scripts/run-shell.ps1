param(
  [string]$StageUrl,
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = Join-Path $root '.rustup'
$env:CARGO_HOME = Join-Path $root '.cargo'
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
$env:TEMP = Join-Path $root '.tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null

if ($StageUrl) { $env:DSH_DSTUBER_STAGE_URL = $StageUrl }

$profile = if ($Release) { 'release' } else { 'debug' }
$exe = Join-Path $root "shell\src-tauri\target\$profile\dsh-dstuber-shell.exe"
if (-not (Test-Path $exe)) {
  throw "shell is not built yet: run scripts\build-shell.ps1 first ($exe)"
}

Write-Host "stage: $($env:DSH_DSTUBER_STAGE_URL ?? 'http://127.0.0.1:8099/?bg=none&hud=1&selftest=1&shell=1')"
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
