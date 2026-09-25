$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root '.runtime'
$DshDir = Join-Path $Runtime 'deepseek-harness'
$Patch = Join-Path $Root 'profiles\local\cordis.patch.yml'
$ElaraNodeModules = Join-Path $Root 'node_modules'
$DshNodeModules = Join-Path $DshDir 'node_modules'
$Template = Join-Path $Root 'profiles\cordis.patch.template.yml'
$PinnedCommit = (Get-Content (Join-Path $Root 'integrations\deepseek-harness\upstream.json') -Raw | ConvertFrom-Json).commit

function Invoke-Native([string]$Name, [string[]]$Arguments) {
  & $Name @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Native command failed with exit code $LASTEXITCODE`: $Name $($Arguments -join ' ')"
  }
}

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
  Invoke-Native 'git' @('clone', 'https://github.com/deepseek-ai/deepseek-harness.git', $DshDir)
} else {
  Write-Host "[ELARA] Using existing DSH checkout: $DshDir"
}

$upstreamCommit = (& git -C $DshDir rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or -not $upstreamCommit) { throw 'Could not identify the DSH checkout revision' }
$upstreamCommit = $upstreamCommit.Trim()
if ($upstreamCommit -ne $PinnedCommit) {
  throw 'DSH checkout differs from the pinned revision; bootstrap will not reset, pull, or checkout over it'
}

Push-Location $DshDir
try {
  Write-Host "[ELARA] Installing DSH dependencies with pnpm 11.7.0..."
  Invoke-Native 'pnpm' @('install')

  Write-Host "[ELARA] Building DSH..."
  Invoke-Native 'pnpm' @('run', 'build')

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
$accessPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\elara-access.ts')
$controlPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\elara-control.ts')
$memoryPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\elara-memory.ts')
$windowsPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\windows-tools.ts')
$whatsappPath = To-AbsoluteYamlPath (Join-Path $Root 'channels\whatsapp-baileys\plugin.ts')
$dashboardPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\dashboard-api.ts')
$companionPath = To-AbsoluteYamlPath (Join-Path $Root 'plugins\companion-api.ts')
$presetRoot = To-AbsoluteYamlPath (Join-Path $Root 'profiles\local\.agent-presets')

if (-not (Test-Path $Patch)) {
  Copy-Item -LiteralPath $Template -Destination $Patch
}
$patchText = Get-Content $Patch -Raw
$newline = if ($patchText.Contains("`r`n")) { "`r`n" } else { "`n" }
$patchText = $patchText.Replace('__ELARA_ACCESS_PLUGIN_PATH__', $accessPath)
$patchText = $patchText.Replace('__ELARA_CONTROL_PLUGIN_PATH__', $controlPath)
if ($patchText -notmatch 'id:\s*elara-access' -or $patchText -notmatch 'id:\s*elara-control') {
  $inserted = $false
  foreach ($candidateNewline in @("`r`n", "`n")) {
    $coreEntry = "    - id: elara-core${candidateNewline}"
    if (-not $patchText.Contains($coreEntry)) { continue }
    $entries = ''
    if ($patchText -notmatch 'id:\s*elara-access') {
      $entries += "    - id: elara-access${candidateNewline}      name: '$accessPath'${candidateNewline}"
    }
    if ($patchText -notmatch 'id:\s*elara-control') {
      $entries += "    - id: elara-control${candidateNewline}      name: '$controlPath'${candidateNewline}"
    }
    $patchText = $patchText.Replace($coreEntry, "${entries}${coreEntry}")
    $inserted = $true
    break
  }
  if (-not $inserted) {
    throw 'Existing local Cordis patch has no elara-core insertion anchor for access and control services'
  }
}
$patchText = $patchText.Replace('__ELARA_CORE_PLUGIN_PATH__', $corePath)
$patchText = $patchText.Replace('__ELARA_MEMORY_PLUGIN_PATH__', $memoryPath)
$patchText = $patchText.Replace('__ELARA_WINDOWS_PLUGIN_PATH__', $windowsPath)
$patchText = $patchText.Replace('__ELARA_WHATSAPP_PLUGIN_PATH__', $whatsappPath)
$patchText = $patchText.Replace('__ELARA_DASHBOARD_PLUGIN_PATH__', $dashboardPath)
$patchText = $patchText.Replace('__ELARA_COMPANION_PLUGIN_PATH__', $companionPath)
$patchText = $patchText.Replace('__ELARA_PRESET_ROOT__', $presetRoot)
if ($patchText -notmatch '(?m)^- id: agent-presets\s*$') {
  $patchText += "${newline}- id: agent-presets${newline}  config:${newline}    default: elara${newline}    roots:${newline}      - path: '$presetRoot'${newline}        trust: system${newline}"
}
if ($patchText -notmatch 'id:\s*elara-access') {
  throw 'Existing local Cordis patch does not load elara-access; edit it explicitly before starting managed channels'
}
if ($patchText -notmatch 'id:\s*elara-control') {
  throw 'Existing local Cordis patch does not load elara-control; edit it explicitly before starting managed channels'
}
Set-Content -Path $Patch -Value $patchText -Encoding utf8

Write-Host "[ELARA] Local bootstrap complete."
Write-Host "[ELARA] DSH runtime: $DshDir"
Write-Host "[ELARA] DSH commit: $(Get-Content (Join-Path $Root '.runtime\dsh-commit.txt'))"
Write-Host "[ELARA] Patch: $Patch"
Write-Host "[ELARA] Run: .\scripts\run-local.ps1"
