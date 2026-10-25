$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root '.webview2\voice-venv2'
$python = Join-Path $venv 'Scripts\python.exe'
$site = Join-Path $venv 'Lib\site-packages'
$temp = Join-Path $root '.tmp'

New-Item -ItemType Directory -Force -Path $temp | Out-Null
if (-not (Test-Path $python)) {
  Write-Host "Creating voice virtual environment: $venv"
  python -m venv --without-pip $venv
}
New-Item -ItemType Directory -Force -Path $site | Out-Null

$env:TEMP = $temp
$env:TMP = $temp
$env:PIP_CACHE_DIR = Join-Path $temp 'pip-cache'
python -m pip install --no-cache-dir --timeout 30 --retries 2 --index-url https://pypi.tuna.tsinghua.edu.cn/simple --target $site -r (Join-Path $root 'voice\requirements.txt')
Write-Host "Voice dependencies installed."
Write-Host "Python: $python"
Write-Host "Next: open the pet settings -> Voice, choose Edge TTS (default) or configure GPT-SoVITS."

