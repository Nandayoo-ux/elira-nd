$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DshDir = Join-Path $Root '.runtime\deepseek-harness'
$Patch = Join-Path $Root 'profiles\local\cordis.patch.yml'

if (-not (Test-Path $DshDir)) {
  throw "ELARA local runtime is not bootstrapped. Run .\scripts\bootstrap-local.ps1 first."
}

if (-not (Test-Path $Patch)) {
  throw "ELARA patch file is missing: $Patch"
}

$RuntimeBin = Join-Path $Root '.runtime\bin'
$env:PATH = "$RuntimeBin;$env:PATH"
$env:ELARA_ROOT = $Root

Push-Location $DshDir
try {
  pnpm dsh web --patch "$Patch"
} finally {
  Pop-Location
}
