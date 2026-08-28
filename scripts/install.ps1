#Requires -Version 5.1
<#
==============================================================================
agy-bridge & OMO Cross-Platform Installer (Windows PowerShell)
==============================================================================
Sets up agy-bridge MCP server, OpenCode configuration, OMO plugin,
delegate guard plugin, model routing rules, and CLI utilities on Windows.

Idempotent and safe:
- Existing configurations are preserved; new versions written to *.new
- Plugin files backed up with timestamps before updates
- Generates CMD and PowerShell shims in %USERPROFILE%\.local\bin
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

function Log-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor Red
}

# ------------------------------------------------------------------------------
# Resolve Script and Repository Roots
# ------------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoDirJson = $RepoDir.Replace('\', '/')

Log-Info "agy-bridge repository detected at: $RepoDir"

# ------------------------------------------------------------------------------
# Configuration Target Paths
# ------------------------------------------------------------------------------
$UserProfile = [Environment]::GetFolderPath("UserProfile")

$OpenCodeConfigDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $UserProfile ".config\opencode" }
$PluginsDir = Join-Path $OpenCodeConfigDir "plugins"
$OmoConfigDir = if ($env:OMO_CONFIG_DIR) { $env:OMO_CONFIG_DIR } else { Join-Path $UserProfile ".omo" }
$GeminiConfigDir = if ($env:GEMINI_CONFIG_DIR) { $env:GEMINI_CONFIG_DIR } else { Join-Path $UserProfile ".gemini\config" }
$LocalBinDir = if ($env:LOCAL_BIN_DIR) { $env:LOCAL_BIN_DIR } else { Join-Path $UserProfile ".local\bin" }

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

# ------------------------------------------------------------------------------
# Dependency Pre-flight Verification
# ------------------------------------------------------------------------------
Log-Info "Verifying prerequisites..."

# 1. Node.js (>= 18 required)
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    try {
        $NodeVerRaw = (node -v).Trim().TrimStart('v')
        $NodeMajor = [int]($NodeVerRaw.Split('.')[0])
        if ($NodeMajor -ge 18) {
            Log-Ok "Node.js $NodeVerRaw detected."
        } else {
            Log-Warn "Node.js version is $NodeVerRaw. Node.js 18+ is recommended."
        }
    } catch {
        Log-Ok "Node.js detected at: $($NodeCmd.Source)"
    }
} else {
    Log-Warn "Node.js not found. Please install Node.js 18+ from https://nodejs.org"
}

# 2. Bun Runtime (required for agy-live TUI)
$BunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($BunCmd) {
    Log-Ok "Bun detected at: $($BunCmd.Source)"
} else {
    Log-Warn "Bun not found. Install via PowerShell: irm bun.sh/install.ps1 | iex"
}

# 3. Antigravity CLI (agy)
$AgyCmd = Get-Command agy -ErrorAction SilentlyContinue
$AgyBinPath = ""
if ($AgyCmd) {
    $AgyBinPath = $AgyCmd.Source
    Log-Ok "Antigravity CLI (agy) detected at: $AgyBinPath"
} else {
    $DefaultAgy = Join-Path $LocalBinDir "agy.exe"
    $AltAgy = Join-Path $UserProfile "AppData\Local\Google\Antigravity\agy.exe"
    if (Test-Path $DefaultAgy) {
        $AgyBinPath = $DefaultAgy
        Log-Ok "Antigravity CLI (agy) found at: $AgyBinPath"
    } elseif (Test-Path $AltAgy) {
        $AgyBinPath = $AltAgy
        Log-Ok "Antigravity CLI (agy) found at: $AgyBinPath"
    } else {
        $AgyBinPath = (Join-Path $LocalBinDir "agy.exe")
        Log-Warn "Antigravity CLI (agy) not found in PATH."
        Log-Warn "Defaulting binary path to: $AgyBinPath"
        Log-Warn "Install Antigravity CLI via PowerShell: irm https://antigravity.google/cli/install.ps1 | iex"
    }
}
$AgyPathJson = $AgyBinPath.Replace('\', '/')

# 4. OpenCode CLI
$OpenCodeCmd = Get-Command opencode -ErrorAction SilentlyContinue
if ($OpenCodeCmd) {
    Log-Ok "OpenCode CLI detected at: $($OpenCodeCmd.Source)"
} else {
    Log-Warn "OpenCode CLI not found in PATH."
    Log-Warn "Install OpenCode CLI via: irm https://opencode.ai/install.ps1 | iex"
}

# ------------------------------------------------------------------------------
# Create Target Directories
# ------------------------------------------------------------------------------
Log-Info "Creating destination directories..."
$TargetDirs = @($OpenCodeConfigDir, $PluginsDir, $OmoConfigDir, $GeminiConfigDir, $LocalBinDir)
foreach ($Dir in $TargetDirs) {
    if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    }
}

# ------------------------------------------------------------------------------
# Install Component 1: Agy Delegate Guard Plugin
# ------------------------------------------------------------------------------
$GuardSrc = Join-Path $RepoDir "config\agy-delegate-guard.js.example"
$GuardDst = Join-Path $PluginsDir "agy-delegate-guard.js"

if (Test-Path $GuardSrc) {
    if (Test-Path $GuardDst) {
        $GuardBak = "$GuardDst.bak.$Timestamp"
        Copy-Item -Path $GuardDst -Destination $GuardBak -Force
        Log-Info "Existing guard plugin backed up to: $GuardBak"
    }
    Copy-Item -Path $GuardSrc -Destination $GuardDst -Force
    Log-Ok "Installed guard plugin: $GuardDst"
} else {
    Log-Error "Source file not found: $GuardSrc"
}

# ------------------------------------------------------------------------------
# Install Component 2: Model Routing Config (agy_bridge.jsonc)
# ------------------------------------------------------------------------------
$RolesSrc = Join-Path $RepoDir "config\agy_bridge.jsonc.example"
$RolesDst = Join-Path $GeminiConfigDir "agy_bridge.jsonc"

if (Test-Path $RolesSrc) {
    if (Test-Path $RolesDst) {
        $RolesNew = "$RolesDst.new"
        Copy-Item -Path $RolesSrc -Destination $RolesNew -Force
        Log-Warn "Configuration already exists: $RolesDst"
        Log-Info "Wrote updated template to: $RolesNew"
        Log-Info "Please review and merge custom role chains manually if needed."
    } else {
        Copy-Item -Path $RolesSrc -Destination $RolesDst -Force
        Log-Ok "Created model routing config: $RolesDst"
    }
} else {
    Log-Error "Source file not found: $RolesSrc"
}

# ------------------------------------------------------------------------------
# Install Component 3: OMO Configuration (omo.jsonc)
# ------------------------------------------------------------------------------
$OmoSrc = Join-Path $RepoDir "config\omo.jsonc.example"
$OmoDst = Join-Path $OmoConfigDir "omo.jsonc"

if (Test-Path $OmoSrc) {
    if (Test-Path $OmoDst) {
        $OmoNew = "$OmoDst.new"
        Copy-Item -Path $OmoSrc -Destination $OmoNew -Force
        Log-Warn "Configuration already exists: $OmoDst"
        Log-Info "Wrote updated template to: $OmoNew"
        Log-Info "Please review and merge OMO agent definitions manually if needed."
    } else {
        Copy-Item -Path $OmoSrc -Destination $OmoDst -Force
        Log-Ok "Created OMO config: $OmoDst"
    }
} else {
    Log-Error "Source file not found: $OmoSrc"
}

# ------------------------------------------------------------------------------
# Install Component 4: OpenCode Config with Path Placeholder Replacement
# ------------------------------------------------------------------------------
$OpenCodeSrc = Join-Path $RepoDir "config\opencode.jsonc.example"
$OpenCodeDst = Join-Path $OpenCodeConfigDir "opencode.jsonc"

if (Test-Path $OpenCodeSrc) {
    $TemplateContent = Get-Content -Raw -Path $OpenCodeSrc -Encoding UTF8
    $ResolvedContent = $TemplateContent.Replace('{{AGY_BRIDGE_DIR}}', $RepoDirJson).Replace('{{AGY_PATH}}', $AgyPathJson)

    if (Test-Path $OpenCodeDst) {
        $OpenCodeNew = "$OpenCodeDst.new"
        Set-Content -Path $OpenCodeNew -Value $ResolvedContent -Encoding UTF8
        Log-Warn "Configuration already exists: $OpenCodeDst"
        Log-Info "Wrote resolved configuration to: $OpenCodeNew"
        Log-Info "Merge Instructions:"
        Log-Info "  1. Add the 'agy-bridge' MCP entry from $OpenCodeNew into your 'mcp' block in $OpenCodeDst."
        Log-Info "  2. Ensure './plugins/agy-delegate-guard.js' is included in your 'plugin' array."
    } else {
        Set-Content -Path $OpenCodeDst -Value $ResolvedContent -Encoding UTF8
        Log-Ok "Created OpenCode config with resolved paths: $OpenCodeDst"
    }
} else {
    Log-Error "Source file not found: $OpenCodeSrc"
}

# ------------------------------------------------------------------------------
# Install Component 5: Shims & Toggle Utilities (%USERPROFILE%\.local\bin)
# ------------------------------------------------------------------------------
Log-Info "Setting up CLI utilities and shims..."

$ToggleScript = Join-Path $RepoDir "scripts\agy-bridge-toggle"
$LiveRunner = Join-Path $RepoDir "bin\agy-live-runner.js"

# 1. agy-bridge-toggle CMD & PS1
$ToggleCmdContent = "@echo off`r`nnode `"$ToggleScript`" %*"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-toggle.cmd") -Value $ToggleCmdContent -Encoding ASCII

$TogglePs1Content = "& node `"$ToggleScript`" `$args"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-toggle.ps1") -Value $TogglePs1Content -Encoding UTF8

# 2. agy-bridge-on shortcut
$OnCmdContent = "@echo off`r`nnode `"$ToggleScript`" on %*"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-on.cmd") -Value $OnCmdContent -Encoding ASCII

$OnPs1Content = "& node `"$ToggleScript`" on `$args"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-on.ps1") -Value $OnPs1Content -Encoding UTF8

# 3. agy-bridge-off shortcut
$OffCmdContent = "@echo off`r`nnode `"$ToggleScript`" off %*"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-off.cmd") -Value $OffCmdContent -Encoding ASCII

$OffPs1Content = "& node `"$ToggleScript`" off `$args"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-off.ps1") -Value $OffPs1Content -Encoding UTF8

# 4. agy-bridge-status shortcut
$StatusCmdContent = "@echo off`r`nnode `"$ToggleScript`" status %*"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-status.cmd") -Value $StatusCmdContent -Encoding ASCII

$StatusPs1Content = "& node `"$ToggleScript`" status `$args"
Set-Content -Path (Join-Path $LocalBinDir "agy-bridge-status.ps1") -Value $StatusPs1Content -Encoding UTF8

# 5. agy-live runner shortcut
if (Test-Path $LiveRunner) {
    $LiveCmdContent = "@echo off`r`nnode `"$LiveRunner`" %*"
    Set-Content -Path (Join-Path $LocalBinDir "agy-live.cmd") -Value $LiveCmdContent -Encoding ASCII

    $LivePs1Content = "& node `"$LiveRunner`" `$args"
    Set-Content -Path (Join-Path $LocalBinDir "agy-live.ps1") -Value $LivePs1Content -Encoding UTF8
    Log-Ok "Installed agy-live CLI runner: $LocalBinDir\agy-live.cmd"
}

Log-Ok "Installed shortcuts: agy-bridge-on, agy-bridge-off, agy-bridge-status in $LocalBinDir"

# ------------------------------------------------------------------------------
# Verification & PATH Advisory
# ------------------------------------------------------------------------------
$EnvPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($EnvPath -notlike "*$LocalBinDir*") {
    Log-Warn "$LocalBinDir is not currently in your User PATH environment variable."
    Log-Warn "To add it to your PATH in PowerShell, run:"
    Log-Warn "  [Environment]::SetEnvironmentVariable('PATH', `"`$EnvPath;$LocalBinDir`", 'User')"
}

# Check build artifact status
$DistIndex = Join-Path $RepoDir "dist\index.js"
if (-not (Test-Path $DistIndex)) {
    Log-Warn "Build artifact '$DistIndex' was not detected."
    Log-Warn "Before launching OpenCode or MCP sessions, run: npm run build (or bun run build)"
}

Log-Ok "agy-bridge installation and setup completed successfully."
Log-Info "Next Steps:"
Log-Info "  1. Verify Antigravity CLI models: agy models"
Log-Info "  2. Check integration state: agy-bridge-status"
Log-Info "  3. Start OpenCode session: opencode"
