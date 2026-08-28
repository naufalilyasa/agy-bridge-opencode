# agy-bridge & OMO Installation and Setup Guide

Cross-platform installation guide for integrating the Antigravity CLI (`agy`) with OpenCode and Oh My OpenAgent (OMO) via the `agy-bridge` MCP server.

---

## 1. Overview and Architecture

`agy-bridge` is a Model Context Protocol (MCP) server that offloads heavy, token-intensive development operations from primary agent loops (such as OpenCode and Claude Code) to Google DeepMind's Antigravity CLI (`agy`).

By bridging OpenCode orchestrators to specialized `agy` subagent roles, token usage is conserved, local context exhaustion is eliminated, and tasks run on dedicated Gemini and Claude model chains.

```
+-------------------------------------------------------------------------+
|                           OpenCode Runtime                              |
|   (Sisyphus Lead Orchestrator, Hephaestus Craftsman, Prometheus, Atlas) |
+------------------------------------+------------------------------------+
                                     |
                          MCP JSON-RPC Transport
                                     |
                                     v
+-------------------------------------------------------------------------+
|                        agy-bridge MCP Server                            |
|             (dist/index.js - Model Router & Failover Engine)            |
+------------------------------------+------------------------------------+
                                     |
                          CLI Process Invocation
                                     |
                                     v
+-------------------------------------------------------------------------+
|                         Antigravity CLI (agy)                           |
|       (Gemini 3.7 Flash High/Medium, Gemini Pro, Claude Sonnet/Opus)    |
+-------------------------------------------------------------------------+
```

### Core Components

1. **agy-bridge Server**: Fast MCP server implementing 6 specialized tools (`delegate`, `analyze_files`, `deep_search`, `web_lookup`, `adversarial_review`, `follow_up`).
2. **Agy Delegate Guard Plugin**: OpenCode plugin (`agy-delegate-guard.js`) intercepting heavy bash commands (e.g. `git log`, `grep -r`, `cat` large files) and redirecting subagents to MCP tools.
3. **Model Failover Router**: Dynamic role-based routing (`agy_bridge.jsonc`) that validates available models via `agy models` and provides quota-aware failover.
4. **OMO Integration**: Disables internal OMO subagents (`disabled_agents`) and injects agy-bridge routing prompts into primary orchestrators (`omo.jsonc`).
5. **Toggle Utility**: `agy-bridge-toggle` (`agy-bridge-on`, `agy-bridge-off`, `agy-bridge-status`) for zero-friction switching between bridge mode and pure native mode.
6. **Live Monitor**: `agy-live` terminal UI for real-time telemetry, token savings metrics, and subagent session tracking.

---

## 2. Prerequisites

The following software must be installed on your machine:

| Component                   | Minimum Version | Purpose                                           |
| :-------------------------- | :-------------- | :------------------------------------------------ |
| **Node.js**                 | >= 18.0.0       | MCP server runtime and build system               |
| **Bun**                     | >= 1.0.0        | Fast execution for `agy-live` TUI                 |
| **Antigravity CLI (`agy`)** | Latest          | Core execution engine for Gemini/Claude subagents |
| **OpenCode CLI**            | Latest          | AI development orchestrator platform              |

### Installation Commands by Platform

#### macOS / Linux

```bash
# Node.js 18+ (via nvm or brew)
brew install node  # macOS
# or: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs # Ubuntu/Debian

# Bun Runtime
curl -fsSL https://bun.sh/install | bash

# Antigravity CLI (agy)
curl -fsSL https://antigravity.google/cli/install.sh | bash

# OpenCode CLI
curl -fsSL https://opencode.ai/install | bash
```

#### Windows (PowerShell)

```powershell
# Node.js 18+ (via winget or fnm)
winget install OpenJS.NodeJS.LTS

# Bun Runtime
powershell -c "irm bun.sh/install.ps1 | iex"

# Antigravity CLI (agy)
irm https://antigravity.google/cli/install.ps1 | iex

# OpenCode CLI
irm https://opencode.ai/install.ps1 | iex
```

---

## 3. Automated Installation

`agy-bridge` includes idempotent, non-destructive installer scripts that set up all configurations, plugins, model definitions, and command-line shims.

### 3.1 macOS & Linux

```bash
# 1. Clone repository (if not already cloned)
git clone https://github.com/naufalilyasa/agy-bridge-opencode.git
cd agy-bridge

# 2. Install dependencies & build the MCP bundle
npm ci
npm run build

# 3. Run automated installer
./scripts/install.sh
```

### 3.2 Windows (PowerShell)

```powershell
# 1. Clone repository (if not already cloned)
git clone https://github.com/naufalilyasa/agy-bridge-opencode.git
cd agy-bridge

# 2. Install dependencies & build the MCP bundle
npm ci
npm run build

# 3. Run automated installer
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

> Note: The installers also build `dist/index.js` automatically when it is missing, so steps 2/3 above are only required when you want to control the build yourself.

### Safety and Idempotency Guarantees

- **Never Overrides an Existing `opencode.jsonc`**: If you already have an OpenCode config, the installer **merges** into it with `scripts/merge-opencode-config.mjs` — it only pins `oh-my-openagent@4.19.4` in `plugin[]`, adds `./plugins/agy-delegate-guard.js`, and injects the `agy-bridge` MCP server block into `mcp{}`. Your own entries, providers, and API keys are preserved untouched (a timestamped backup is still written). `omo.jsonc` / `agy_bridge.jsonc` follow the same non-destructive rule: existing files get a `.new` template + merge instructions instead of being overwritten.
- **Timestamped Backups**: Existing plugin scripts (such as `agy-delegate-guard.js`) are backed up with a timestamp prefix (`.bak.<YYYYMMDD_HHMMSS>`) before being updated.
- **Path Resolution**: Placeholders `{{AGY_BRIDGE_DIR}}` and `{{AGY_PATH}}` in `opencode.jsonc.example` are automatically resolved to exact absolute filesystem paths.
- **Skill Injection**: `SKILL.md` (the `agy-delegation` skill) is copied to `~/.gemini/config/skills/agy-delegation/SKILL.md` so agy-bridge MCP auto-injects it into every `delegate` prompt.

---

## 4. What Gets Installed (File & Directory Map)

The installer establishes configuration across several target directories:

| Component            | Source in Repo                         | Target Path (macOS/Linux)                                                                         | Target Path (Windows)                                                                                                                             |
| :------------------- | :------------------------------------- | :------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenCode Config**  | `config/opencode.jsonc.example`        | `~/.config/opencode/opencode.jsonc`                                                               | `%USERPROFILE%\.config\opencode\opencode.jsonc`                                                                                                   |
| **Guard Plugin**     | `config/agy-delegate-guard.js.example` | `~/.config/opencode/plugins/agy-delegate-guard.js`                                                | `%USERPROFILE%\.config\opencode\plugins\agy-delegate-guard.js`                                                                                    |
| **OMO Config**       | `config/omo.jsonc.example`             | `~/.omo/omo.jsonc`                                                                                | `%USERPROFILE%\.omo\omo.jsonc`                                                                                                                    |
| **Model Routing**    | `config/agy_bridge.jsonc.example`      | `~/.gemini/config/agy_bridge.jsonc`                                                               | `%USERPROFILE%\.gemini\config\agy_bridge.jsonc`                                                                                                   |
| **Toggle Utility**   | `scripts/agy-bridge-toggle`            | `~/.local/bin/agy-bridge-toggle`                                                                  | `%USERPROFILE%\.local\bin\agy-bridge-toggle.cmd`                                                                                                  |
| **Toggle Shortcuts** | `scripts/install.sh` generated         | `~/.local/bin/agy-bridge-on`<br>`~/.local/bin/agy-bridge-off`<br>`~/.local/bin/agy-bridge-status` | `%USERPROFILE%\.local\bin\agy-bridge-on.cmd`<br>`%USERPROFILE%\.local\bin\agy-bridge-off.cmd`<br>`%USERPROFILE%\.local\bin\agy-bridge-status.cmd` |
| **Live Monitor**     | `bin/agy-live-runner.js`               | `~/.local/bin/agy-live`                                                                           | `%USERPROFILE%\.local\bin\agy-live.cmd`                                                                                                           |
| **Live Monitor (TUI)** | `bin/agy-live.ts`                    | alias `agy-live2` (runs via `bun`)                                                                | `%USERPROFILE%\.local\bin\agy-live2.cmd` (bun shim)                                                                                               |
| **Merge Script**     | `scripts/merge-opencode-config.mjs`    | (used by installer, not installed)                                                                 | (used by installer, not installed)                                                                                                                 |
| **Delegation Skill** | `SKILL.md`                             | `~/.gemini/config/skills/agy-delegation/SKILL.md`                                                  | `%USERPROFILE%\.gemini\config\skills\agy-delegation\SKILL.md`                                                                                      |
| **agy CLI MCP**      | `config/agy-cli-mcp-config.json.example` | `~/.gemini/config/mcp_config.json` (5 servers: agentmemory, context7, mobile-mcp, codegraph, XcodeBuildMCP) | `%USERPROFILE%\.gemini\config\mcp_config.json`                                                                                             |
| **agy CLI Hooks**    | `config/agy-cli-hooks.json.example`    | `~/.gemini/config/hooks.json` (cc-safety-net PreToolUse)                                            | `%USERPROFILE%\.gemini\config\hooks.json`                                                                                                          |
| **agy CLI Protocol** | `config/agy-cli-gemini.md.example`     | `~/.gemini/config/GEMINI.md` (Caveman + Ponytail engineering protocol)                              | `%USERPROFILE%\.gemini\config\GEMINI.md`                                                                                                           |
| **Machine-specific (example only, never auto-activated)** | `config/agy-cli-config.json.example`<br>`config/agy-cli-settings.json.example` | `~/.gemini/config/config.json.example`<br>`~/.gemini/config/settings.json.example`                  | `%USERPROFILE%\.gemini\config\config.json.example`<br>`%USERPROFILE%\.gemini\config\settings.json.example`                                          |

> **Note on machine-specific files**: `mcp_config.json`, `hooks.json` and `GEMINI.md` are generic and installed as-is (`.new` fallback if they already exist). `config.json` (contains `remoteControlHostname`) and the agy CLI `settings.json` (contains `trustedWorkspaces`, a per-machine permission allowlist and the default model) are **machine-specific** — the installer only copies them as `.example` references. Rename + edit them yourself:
> - `config.json.example` → set your hostname, rename to `config.json`.
> - `settings.json.example` → add your trusted project paths to `trustedWorkspaces`, extend `permissions.allow`, set `model` to an `agy models` entry, rename to `settings.json` (lives in `~/.gemini/antigravity-cli/`).

---

## 5. Manual Installation Walkthrough

If you prefer configuring components manually or need to merge into existing configurations:

### Step 1: Install Plugin

Copy `config/agy-delegate-guard.js.example` to `~/.config/opencode/plugins/agy-delegate-guard.js`:

```bash
mkdir -p ~/.config/opencode/plugins
cp config/agy-delegate-guard.js.example ~/.config/opencode/plugins/agy-delegate-guard.js
```

### Step 2: Configure Model Failover Chain

Copy `config/agy_bridge.jsonc.example` to `~/.gemini/config/agy_bridge.jsonc`:

```bash
mkdir -p ~/.gemini/config
cp config/agy_bridge.jsonc.example ~/.gemini/config/agy_bridge.jsonc
```

### Step 3: Configure OMO Agents

Copy `config/omo.jsonc.example` to `~/.omo/omo.jsonc`:

```bash
mkdir -p ~/.omo
cp config/omo.jsonc.example ~/.omo/omo.jsonc
```

### Step 3b: Configure agy CLI Runtime (MCP Servers, Hooks, Protocol)

The agy CLI reads its own MCP servers, safety hooks, and engineering protocol from `~/.gemini/config/`. These are generic and safe to install as-is:

```bash
# MCP servers (agentmemory, context7, mobile-mcp, codegraph, XcodeBuildMCP)
cp config/agy-cli-mcp-config.json.example ~/.gemini/config/mcp_config.json

# Safety hook (cc-safety-net PreToolUse guard)
cp config/agy-cli-hooks.json.example ~/.gemini/config/hooks.json

# Engineering protocol (Caveman + Ponytail)
cp config/agy-cli-gemini.md.example ~/.gemini/config/GEMINI.md
```

**ANDROID_HOME**: The mobile-mcp entry in `mcp_config.json` contains `{{ANDROID_HOME}}`. The installer auto-detects it; if doing manual install, set it explicitly:
```bash
# macOS default:
sed -i '' 's|{{ANDROID_HOME}}|/Users/yourname/Library/Android/sdk|g' ~/.gemini/config/mcp_config.json
```

**Machine-specific configs** (not auto-installed, reference only):
- `config/agy-cli-config.json.example` → review `remoteControlHostname`, rename to `config.json`.
- `config/agy-cli-settings.json.example` → add your project paths to `trustedWorkspaces`, extend `permissions.allow`, set `model` to an `agy models` entry, rename to `settings.json` (lives in `~/.gemini/antigravity-cli/`).

### Step 4: Register MCP Server in OpenCode

Add the `agy-bridge` MCP server and guard plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oh-my-openagent@4.19.4", "./plugins/agy-delegate-guard.js"],
  "mcp": {
    "agy-bridge": {
      "type": "local",
      "command": ["node", "/ABSOLUTE/PATH/TO/agy-bridge/dist/index.js"],
      "enabled": true,
      "timeout": 5400000,
      "environment": {
        "AGY_PATH": "/ABSOLUTE/PATH/TO/agy",
        "AGY_MAX_OUTPUT_CHARS": "50000",
        "AGY_ON_FAILURE": "fallback",
        "AGY_IDLE_TIMEOUT": "600",
        "AGY_TIMEOUT_DELEGATE": "3600",
        "AGY_TIMEOUT_FOLLOW_UP": "3600",
        "AGY_TIMEOUT_ANALYZE_FILES": "900",
        "AGY_TIMEOUT_ADVERSARIAL_REVIEW": "900",
        "AGY_TIMEOUT_DEEP_SEARCH": "600",
        "AGY_TIMEOUT_WEB_LOOKUP": "180",
      },
    },
  },
}
```

_Note on Windows:_ Use forward slashes (e.g. `C:/Users/username/agy-bridge/dist/index.js`) in JSON files to avoid escape errors.

---

## 6. Verification and Health Check

Perform these checks to confirm proper configuration:

### 1. Check Antigravity Authentication and Models

```bash
agy models
```

Expected output: A list of active Gemini and Claude models available in your account.

### 2. Verify agy-bridge Build

Ensure `dist/index.js` is generated:

```bash
# In agy-bridge repo root:
npm run build
# or: bun run build
```

### 3. Check Toggle State

```bash
agy-bridge-status
# or: agy-bridge-toggle status
```

Expected output:

```
mcp.agy-bridge.enabled : true
omo gating rules       : present
ON snapshot available  : false (or true)
STATE: ON
```

### 4. Verify OpenCode Integration

Start OpenCode in your project workspace:

```bash
opencode
```

OpenCode will initialize OMO orchestrators (Sisyphus, Hephaestus, Prometheus, Atlas) connected to the `agy-bridge` MCP server.

### 5. Verify agy CLI Runtime Configs

```bash
ls ~/.gemini/config/mcp_config.json ~/.gemini/config/hooks.json ~/.gemini/config/GEMINI.md
```

Expected: all three exist. `mcp_config.json` should contain the 5 MCP servers (agentmemory, context7, mobile-mcp, codegraph, XcodeBuildMCP) with a resolved `ANDROID_HOME` (no leftover `{{ANDROID_HOME}}` placeholder unless you opted out of the mobile-mcp SDK detection). Restart the agy CLI session so the new MCP servers load.

---

## 7. Mode Switching (`agy-bridge-toggle`)

The `agy-bridge-toggle` utility allows seamless toggling between full `agy-bridge` delegation mode (ON) and native OpenCode/OMO execution (OFF).

### Commands

| Command             | Action                                                                              |
| :------------------ | :---------------------------------------------------------------------------------- |
| `agy-bridge-status` | Displays current state (ON, OFF, or MIXED)                                          |
| `agy-bridge-off`    | Disables agy-bridge MCP, clears prompt gating rules, re-enables internal OMO agents |
| `agy-bridge-on`     | Restores agy-bridge MCP and OMO delegation rules from snapshot                      |

### How It Works

- **Switching OFF**:
  1. Sets `"enabled": false` for the `agy-bridge` entry in `opencode.jsonc`.
  2. Saves a complete ON-state snapshot to `~/.omo/.agy-toggle/omo.jsonc.on-snapshot`.
  3. Empties `prompt_append` gating rules in `omo.jsonc`.
  4. Resets `disabled_agents` to `[]` so OMO native subagents run locally.
- **Switching ON**:
  1. Sets `"enabled": true` in `opencode.jsonc`.
  2. Restores `omo.jsonc` from `~/.omo/.agy-toggle/omo.jsonc.on-snapshot`.

---

## 8. Live Telemetry (`agy-live`)

`agy-live` is a Terminal UI built with OpenTUI and Bun that monitors subagent delegations in real time.

```bash
agy-live
```

### Key Features

- **Real-Time Stream**: Live view of subagent prompt dispatches, execution status, and tool responses.
- **Token Analytics**: Breakdown of characters and tokens offloaded to Antigravity CLI vs. local context.
- **Model Distribution**: Visual representation of model routing across tasks (Gemini 3.7 Flash, Claude Sonnet, Gemini Pro).
- **Active Sessions**: Inspect ongoing and past multi-turn session identifiers (`sessionId`).

---

## 9. Alternative MCP Clients (Claude Code)

To use `agy-bridge` directly within Claude Code instead of or in addition to OpenCode:

```bash
# Register MCP server with a 10-minute client deadline
claude mcp add-json -s user agy-bridge \
  '{"command":"npx","args":["-y","agy-bridge"],"timeout":600000}'

# Add delegation rules to project or global config
curl -fsSL https://raw.githubusercontent.com/sshahzaiib/agy-bridge/main/CLAUDE.md -o CLAUDE.md
```

---

## 10. Troubleshooting and Diagnostics

### 1. `agy` command not found

- **Symptom**: Error `Command failed: agy ...` or `ENOENT`.
- **Solution**: Confirm Antigravity CLI is installed (`which agy`). If installed in `~/.local/bin/agy`, ensure `~/.local/bin` is in your `PATH` or set `AGY_PATH` explicitly in `opencode.jsonc`.

### 2. Client Timeout (`timed out waiting for response`)

- **Symptom**: Client aborts before long task finishes.
- **Cause**: Client-side tool timeout is lower than agy execution budget.
- **Solution**: Increase `timeout` in `opencode.jsonc` or Claude Code MCP configuration (e.g. `5400000` ms). Set `MCP_TOOL_TIMEOUT=600000` in your shell environment.

### 3. Resource Exhaustion (HTTP 429)

- **Symptom**: Model rate limit or quota exceeded.
- **Behavior**: `agy-bridge` automatically detects 429 errors from agy logs, parses cooldown duration (e.g. "Resets in 4h"), and seamlessly falls back to the next model configured in `~/.gemini/config/agy_bridge.jsonc`.

### 4. Existing Configuration Notice (`.new` files)

- **Symptom**: Installer prints `[WARN] Configuration already exists: ... Wrote updated template to: ...new`.
- **Explanation**: `opencode.jsonc` is **merged** automatically by `merge-opencode-config.mjs` (pins OMO plugin, injects agy-bridge MCP block, preserves everything else). The other configs (`omo.jsonc`, `agy_bridge.jsonc`, `mcp_config.json`, `hooks.json`, `GEMINI.md`) are not auto-merged — they're written as `.new` next to your existing file. If you see `.new` warnings, open both files and merge the agy-bridge entries into your active configuration.

### 4b. `{{ANDROID_HOME}}` placeholder left in `mcp_config.json`

- **Symptom**: agy CLI fails to start the `mobile-mcp` server; the `mcp_config.json` still contains the literal `{{ANDROID_HOME}}`.
- **Cause**: Installer could not detect an Android SDK (`ANDROID_HOME` env, `~/Library/Android/sdk`, `~/Android/Sdk`, `%LOCALAPPDATA%\Android\Sdk`).
- **Solution**: Set the absolute SDK path manually (e.g. `sed -i '' 's|{{ANDROID_HOME}}|/Users/yourname/Library/Android/sdk|g' ~/.gemini/config/mcp_config.json`), or set `ANDROID_HOME` and re-run the installer.

### 5. Windows Path Formatting

- **Symptom**: OpenCode fails to parse configuration due to invalid escape sequences.
- **Solution**: In JSON/JSONC configuration files on Windows, always use forward slashes `/` (e.g. `C:/Users/...`) instead of unescaped backslashes `\`.

### 6. Permission Denied on POSIX Scripts

- **Symptom**: `permission denied: ./scripts/install.sh` or `permission denied: agy-bridge-toggle`.
- **Solution**: Run `chmod +x scripts/install.sh scripts/agy-bridge-toggle`.
