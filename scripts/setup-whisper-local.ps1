$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root '.runtime\whisper'
$VenvDir = Join-Path $RuntimeDir '.venv'
$Python = Join-Path $VenvDir 'Scripts\python.exe'
$Requirements = Join-Path $Root 'services\whisper-local\requirements.txt'
$Model = if ($env:ELARA_WHISPER_MODEL) { $env:ELARA_WHISPER_MODEL } else { 'small' }

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw 'uv is required to create the isolated Whisper environment'
}

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

if (-not (Test-Path $Python)) {
  Write-Host '[ELARA-WHISPER] Creating Python 3.11 environment'
  uv venv --python 3.11 $VenvDir
}

Write-Host '[ELARA-WHISPER] Installing pinned dependencies'
uv pip install --python $Python --requirements $Requirements

$env:ELARA_ROOT = $Root
$env:ELARA_WHISPER_MODEL = $Model
Write-Host "[ELARA-WHISPER] Preparing model $Model"
& $Python (Join-Path $Root 'services\whisper-local\download_model.py')

Write-Host '[ELARA-WHISPER] Local transcription is ready'
Write-Host '[ELARA-WHISPER] It will start automatically with npm run run:local'
