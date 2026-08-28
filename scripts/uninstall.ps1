#Requires -Version 5.1
<#
==============================================================================
agy-bridge Uninstaller (Windows PowerShell)
==============================================================================
Removes the agy-bridge integration installed by install.ps1:
  - guard plugin, model routing config, agy-delegation skill
  - agy CLI runtime configs (mcp_config.json, hooks.json, GEMINI.md, .examples)
  - omo.jsonc + ON snapshot, opencode.jsonc merge (restored from backup)
  - CLI shims (agy-bridge-toggle/on/off/status, agy-live, agy-live2)

Safe by design:
  - Never deletes user data: if the installer found a pre-existing config it
    wrote a *.new file and left the original untouched -- uninstall removes
    only that *.new artifact, never the original.
  - opencode.jsonc is restored from the timestamped backup the merge script
    created before its edit. If no backup exists, entries are NOT force
    removed -- a warning tells you what to strip manually.
==============================================================================
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# ------------------------------------------------------------------------------
# Logging Helpers (Zero Emojis)
# ------------------------------------------------------------------------------
function Log-Info {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor Cyan
}
function Log-Ok {
    param([string]$Message)
    Write-Host "[OK] $Message" -ForegroundColor Green
}
function Log-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# Resolve target paths (mirrors install.ps1)
# ------------------------------------------------------------------------------
$UserProfile = [Environment]::GetFolderPath("UserProfile")

$OpenCodeConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $UserProfile ".config\opencode" }
$PluginsDir = Join-Path $OpenCodeConfigDir "plugins"
$OmoConfigDir = if ($env:OMO_CONFIG_DIR) { $env:OMO_CONFIG_DIR } else { Join-Path $UserProfile ".omo" }
$GeminiConfigDir = if ($env:GEMINI_CONFIG_DIR) { $env:GEMINI_CONFIG_DIR } else { Join-Path $UserProfile ".gemini\config" }
$LocalBinDir = if ($env:LOCAL_BIN_DIR) { $env:LOCAL_BIN_DIR } else { Join-Path $UserProfile ".local\bin" }

Log-Info "agy-bridge uninstaller starting"

# ------------------------------------------------------------------------------
# Component 1: Delegate Guard Plugin
# ------------------------------------------------------------------------------
$GuardDst = Join-Path $PluginsDir "agy-delegate-guard.js"
if (Test-Path $GuardDst) {
    Remove-Item $GuardDst -Force
    Log-Ok "Removed guard plugin: $GuardDst"
} else {
    Log-Info "  guard plugin not present (skip)"
}

# ------------------------------------------------------------------------------
# Component 2a: Model Routing Config (agy_bridge.jsonc)
# ------------------------------------------------------------------------------
$RolesDst = Join-Path $GeminiConfigDir "agy_bridge.jsonc"
if (Test-Path "$RolesDst.new") {
    Remove-Item "$RolesDst.new" -Force
    Log-Ok "Removed template artifact: $RolesDst.new (your original config kept)"
} elseif (Test-Path $RolesDst) {
    Remove-Item $RolesDst -Force
    Log-Ok "Removed model routing config: $RolesDst"
} else {
    Log-Info "  agy_bridge.jsonc not present (skip)"
}

# ------------------------------------------------------------------------------
# Component 2b: agy-delegation SKILL.md
# ------------------------------------------------------------------------------
$SkillDir = Join-Path $GeminiConfigDir "skills\agy-delegation"
if (Test-Path $SkillDir) {
    Remove-Item $SkillDir -Recurse -Force
    Log-Ok "Removed agy-delegation skill: $SkillDir"
} else {
    Log-Info "  agy-delegation skill not present (skip)"
}

# ------------------------------------------------------------------------------
# Component 2c: agy CLI runtime configs
# ------------------------------------------------------------------------------
foreach ($cfg in @("mcp_config.json", "hooks.json", "GEMINI.md")) {
    $Dst = Join-Path $GeminiConfigDir $cfg
    if (Test-Path "$Dst.new") {
        Remove-Item "$Dst.new" -Force
        Log-Ok "Removed template artifact: $Dst.new (your original $cfg kept)"
    } elseif (Test-Path $Dst) {
        Remove-Item $Dst -Force
        Log-Ok "Removed agy CLI config: $Dst"
    }
}
foreach ($example in @("config.json.example", "settings.json.example")) {
    $Dst = Join-Path $GeminiConfigDir $example
    if (Test-Path $Dst) {
        Remove-Item $Dst -Force
        Log-Ok "Removed reference template: $Dst"
    }
}

# ------------------------------------------------------------------------------
# Component 3: OMO Configuration (omo.jsonc) + ON snapshot
# ------------------------------------------------------------------------------
$OmoDst = Join-Path $OmoConfigDir "omo.jsonc"
if (Test-Path "$OmoDst.new") {
    Remove-Item "$OmoDst.new" -Force
    Log-Ok "Removed template artifact: $OmoDst.new (your original omo.jsonc kept)"
} elseif (Test-Path $OmoDst) {
    Remove-Item $OmoDst -Force
    Log-Ok "Removed OMO config: $OmoDst"
}
$SnapDir = Join-Path $OmoConfigDir ".agy-toggle"
if (Test-Path $SnapDir) {
    Remove-Item $SnapDir -Recurse -Force
    Log-Ok "Removed toggle snapshot dir: $SnapDir"
}

# ------------------------------------------------------------------------------
# Component 4: OpenCode Config -- restore from merge backup
# ------------------------------------------------------------------------------
$OpenCodeDst = Join-Path $OpenCodeConfigDir "opencode.jsonc"
if (Test-Path $OpenCodeDst) {
    $hasAgy = Select-String -Path $OpenCodeDst -Pattern "agy-bridge" -Quiet
    if ($hasAgy) {
        $bakPattern = Join-Path $OpenCodeConfigDir "opencode.jsonc.backup-*"
        $LatestBak = Get-ChildItem -Path $bakPattern -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($LatestBak) {
            Copy-Item $LatestBak.FullName $OpenCodeDst -Force
            Log-Ok "Restored opencode.jsonc from merge backup: $($LatestBak.FullName)"
        } else {
            Log-Warn "opencode.jsonc contains agy-bridge entries but no backup was found."
            Log-Warn "  Not modifying it. Remove manually:"
            Log-Warn "    - the ""agy-bridge"" block under mcp{}"
            Log-Warn "    - ""agy-delegate-guard.js"" (and optionally the oh-my-openagent pin) under plugin[]"
        }
    } else {
        Log-Info "  opencode.jsonc has no agy-bridge entries (skip)"
    }
} else {
    Log-Info "  opencode.jsonc not present (skip)"
}

# ------------------------------------------------------------------------------
# Component 5: CLI Shims (%USERPROFILE%\.local\bin)
# ------------------------------------------------------------------------------
foreach ($shim in @("agy-bridge-toggle", "agy-bridge-on", "agy-bridge-off", "agy-bridge-status", "agy-live", "agy-live2")) {
    $ShimCmd = Join-Path $LocalBinDir "$shim.cmd"
    $ShimPs1 = Join-Path $LocalBinDir "$shim.ps1"
    foreach ($p in @($ShimCmd, $ShimPs1)) {
        if (Test-Path $p) {
            Remove-Item $p -Force
            Log-Ok "Removed shim: $p"
        }
    }
}

Log-Ok "agy-bridge uninstall complete."
Log-Info "Next Steps:"
Log-Info "  1. Restart OpenCode sessions to drop the agy-bridge MCP server."
Log-Info "  2. Optional: remove the Antigravity CLI itself from %USERPROFILE%\.local\bin\agy."
Log-Info "  3. Optional: the repo clone (this directory) is untouched and can be deleted."
