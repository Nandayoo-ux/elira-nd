$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root '.runtime'
$DshDir = Join-Path $Runtime 'deepseek-harness'
$Patch = Join-Path $Root 'profiles\local\cordis.patch.yml'
$ElaraNodeModules = Join-Path $Root 'node_modules'
$DshNodeModules = Join-Path $DshDir 'node_modules'

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Test-NodeVersion([string]$VersionText) {
  $parts = $VersionText.Split('.')
  $major = [int]$parts[0]
  $minor = [int]$parts[1]

  # DSH documents Node 22.19+ and 24+; Node 23 is intentionally not accepted.
  $supported = (($major -eq 22) -and ($minor -ge 19)) -or ($major -ge 24)
  if (-not $supported) {
    throw "ELARA requires Node 22.19+ or 24+. Detected $VersionText"
  }
}

Require-Command git
Require-Command node

$nodeVersionText = (& node -p "process.versions.node").Trim()
Test-NodeVersion $nodeVersionText
Write-Host "[ELARA] Node $nodeVersionText"

Require-Command corepack

$RuntimeBin = Join-Path $Runtime 'bin'
if (-not (Test-Path $RuntimeBin)) {
  New-Item -ItemType Directory -Force -Path $RuntimeBin | Out-Null
}
corepack enable --install-directory $RuntimeBin
$env:PATH = "$RuntimeBin;$env:PATH"

if (-not (Test-Path $DshDir)) {
  New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
  Write-Host "[ELARA] Cloning official DeepSeek Harness..."
  git clone https://github.com/deepseek-ai/deepseek-harness.git $DshDir
} else {
  Write-Host "[ELARA] Using existing DSH checkout: $DshDir"
}

Push-Location $DshDir
try {
  Write-Host "[ELARA] Installing DSH dependencies with pnpm 11.7.0..."
  pnpm install

  Write-Host "[ELARA] Building DSH..."
  pnpm run build

  $upstreamCommit = (& git rev-parse HEAD).Trim()
  Set-Content -Path (Join-Path $Root '.runtime\dsh-commit.txt') -Value $upstreamCommit -Encoding utf8
  Write-Host "[ELARA] Upstream DSH commit: $upstreamCommit"
} finally {
  Pop-Location
}

# Plugins live in the ELARA repository but import DSH runtime packages.
# A junction exposes the DSH dependency tree to standard Node module resolution
# without copying or modifying DSH source.
if (Test-Path $ElaraNodeModules) {
  $item = Get-Item $ElaraNodeModules -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $children = @(Get-ChildItem $ElaraNodeModules -Force)
    if ($children.Count -eq 0 -or ($children.Count -eq 1 -and $children[0].Name -eq '.pnpm-workspace-state-v1.json')) {
      Remove-Item -Recurse -Force $ElaraNodeModules
      New-Item -ItemType Junction -Path $ElaraNodeModules -Target $DshNodeModules | Out-Null
    } else {
      throw "$ElaraNodeModules already exists and is not a junction. Remove it before bootstrap."
    }
  }
} else {
  New-Item -ItemType Junction -Path $ElaraNodeModules -Target $DshNodeModules | Out-Null
}

function To-AbsoluteYamlPath([string]$Path) {
  $full = (Resolve-Path $Path).Path
  return $full.Replace('\', '/')
}

$corePath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\elara-core.ts')
$windowsPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\windows-tools.ts')
$whatsappPath = To-AbsoluteYamlPath (Join-Path $Root 'channels\whatsapp-baileys\plugin.ts')
$dashboardPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\dashboard-api.ts')

$patchText = Get-Content $Patch -Raw
$patchText = $patchText.Replace('__ELARA_CORE_PLUGIN_PATH__', $corePath)
$patchText = $patchText.Replace('__ELARA_WINDOWS_PLUGIN_PATH__', $windowsPath)
$patchText = $patchText.Replace('__ELARA_WHATSAPP_PLUGIN_PATH__', $whatsappPath)
$patchText = $patchText.Replace('__ELARA_DASHBOARD_PLUGIN_PATH__', $dashboardPath)
Set-Content -Path $Patch -Value $patchText -Encoding utf8

Write-Host "[ELARA] Local bootstrap complete."
Write-Host "[ELARA] DSH runtime: $DshDir"
Write-Host "[ELARA] DSH commit: $(Get-Content (Join-Path $Root '.runtime\dsh-commit.txt'))"
Write-Host "[ELARA] Patch: $Patch"
Write-Host "[ELARA] Run: .\scripts\run-local.ps1"
