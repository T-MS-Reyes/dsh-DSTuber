param([switch]$Release)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = Join-Path $root '.rustup'
$env:CARGO_HOME = Join-Path $root '.cargo'
$env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
$env:TEMP = Join-Path $root '.tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null

Push-Location (Join-Path $root 'shell\src-tauri')
try {
  $cargoArgs = @('build')
  if ($Release) { $cargoArgs += '--release' }
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$profile = if ($Release) { 'release' } else { 'debug' }
Write-Host "built: $(Join-Path $root "shell\src-tauri\target\$profile\dsh-dstuber-shell.exe")"
