# Build a distributable plugin directory: only runtime files (no node_modules,
# no .git, no .tmp, no user data), with the release shell executable included.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist\dsh-dstuber'

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Force $dist | Out-Null

$items = @('src', 'client', 'stage', 'voice', 'scripts', 'locale', 'dev', 'assets', 'personas',
  'cordis.patch.yml', 'icon.svg', 'package.json', 'README.md', 'LICENSE')
foreach ($item in $items) {
  Copy-Item (Join-Path $root $item) (Join-Path $dist $item) -Recurse -Force
}

# Never ship the worker bytecode cache.
$pycache = Join-Path $dist 'voice\__pycache__'
if (Test-Path $pycache) { Remove-Item $pycache -Recurse -Force }

# scripts/ mixes runtime tools with development probes; keep only what a user
# can actually run.
$keepScripts = @('build-model.mjs', 'build-shell.ps1', 'package.ps1', 'setup-voice.ps1', 'run-shell.ps1')
$scriptsDir = Join-Path $dist 'scripts'
Get-ChildItem $scriptsDir -File | Where-Object { $keepScripts -notcontains $_.Name } | Remove-Item -Force

$exe = Join-Path $root 'shell\src-tauri\target\release\dsh-dstuber-shell.exe'
if (-not (Test-Path $exe)) { throw "release shell missing: $exe (run scripts/build-shell.ps1 -Release)" }
$target = Join-Path $dist 'shell\src-tauri\target\release'
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item $exe $target

$size = [math]::Round(((Get-ChildItem $dist -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "packed: $dist ($size MB)"
