<div align="center">

<img src="https://raw.githubusercontent.com/sshahzaiib/agy-bridge/main/assets/banner.svg" alt="agy-bridge — delegates heavy tasks to the Antigravity CLI" width="100%">

# agy-bridge (customized fork)

**Fork: [`naufalilyasa/agy-bridge-opencode`](https://github.com/naufalilyasa/agy-bridge-opencode) — upstream: [`sshahzaiib/agy-bridge`](https://github.com/sshahzaiib/agy-bridge)**

[![CI](https://github.com/sshahzaiib/agy-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/sshahzaiib/agy-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/agy-bridge)](LICENSE)
[![node](https://img.shields.io/node/v/agy-bridge)](https://nodejs.org)

</div>

An MCP bridge that lets AI coding agents **delegate heavy tasks to the Antigravity CLI (`agy`)** — saving your context window and tokens for what matters.

Agent sends a task → the bridge routes it to the best available model via `agy` → only the answer comes back. Large files, deep git searches, and web lookups never touch your context.

```
User → OpenCode/Claude Code → agy-bridge (MCP) → agy CLI → Gemini / Claude / GPT-OSS
                   ←                     ←                ←
```

## What this fork adds over upstream

This fork is a **customized, production-hardened build** for OpenCode + Oh My OpenAgent (OMO) workflows. On top of the upstream agy-bridge server it adds:

| Addition                   | What it does                                                                                                                                                                                                                                           |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One-command installer**  | `scripts/install.sh` / `scripts/install.ps1` — installs the MCP server, OMO config, guard plugin, delegation skill, agy CLI runtime configs, toggle, and TUI shims in one run. **Merges** your `opencode.jsonc` (timestamped backups, never overrides) |
| **`agy-bridge-toggle`**    | `on` / `off` / `status` — flip the whole agy-bridge integration off and back on with byte-identical snapshot restore                                                                                                                                   |
| **Uninstaller**            | `scripts/uninstall.sh` / `scripts/uninstall.ps1` — removes every installed component and restores `opencode.jsonc` from its pre-install backup                                                                                                         |
| **`agy-delegation` skill** | Comprehensive delegation protocol (all 8 MCP tools, roles, memory directives). Installed to `~/.gemini/config/skills/agy-delegation/` and **guaranteed the first slot** in every delegated prompt's skill list                                         |
| **Hardened prompts**       | OMO-native parity: `<Category_Context>`, `EXECUTION DISCIPLINE` (anti-delegation, verification mandates, anti-optimism checkpoints, scope discipline), mandatory agentmemory recall/persist directives, English-only output                            |
| **Guard plugin**           | `agy-delegate-guard.js` — intercepts heavy `git log/diff/blame`, `grep -r`, `rg`, `cat` calls in the main context and redirects them to agy-bridge delegation                                                                                          |
| **`agy-live2` TUI**        | OpenTUI (v2) live session monitor with quota/context meters, hardened against giant-transcript OOM crashes                                                                                                                                             |
| **Config templates**       | `config/*.example` — model routing (19-role chains), OMO config, OpenCode config, guard plugin, and agy CLI runtime configs (mcp/hooks/GEMINI.md), secrets-free                                                                                        |
| **Model config SSOT**      | Role → model chains live in `~/.gemini/config/agy_bridge.jsonc` (single source of truth), validated against `agy models`                                                                                                                               |

## Requirements

- Node.js 18+
- [Antigravity CLI](https://antigravity.google/docs/cli-getting-started) (`agy`) installed and authenticated
- **OpenCode** (for the full install path) or **Claude Code** (manual MCP registration)

## Install

### Option A — full OpenCode setup (recommended)

```bash
git clone https://github.com/naufalilyasa/agy-bridge-opencode.git
cd agy-bridge-opencode
bash scripts/install.sh          # macOS/Linux — Windows: powershell -File scripts\install.ps1
```

The installer detects missing prerequisites (`node`, `bun`, `agy`, `opencode`), then installs:

- guard plugin → `~/.config/opencode/plugins/agy-delegate-guard.js`
- `agy_bridge.jsonc` → `~/.gemini/config/` (`.new` suffix if you already have one — never clobbers)
- `agy-delegation` skill → `~/.gemini/config/skills/agy-delegation/SKILL.md`
- OMO config → `~/.omo/omo.jsonc` (`.new` fallback)
- OpenCode config → **merged** into `~/.config/opencode/opencode.jsonc` (pins `oh-my-openagent@4.19.4`, adds the MCP server + per-tool timeouts; timestamped backup first)
- agy CLI runtime configs (`mcp_config.json`, `hooks.json`, `GEMINI.md`) → `~/.gemini/config/` with `{{ANDROID_HOME}}` auto-substitution
- CLI shims: `agy-bridge-toggle` / `agy-live` / `agy-live2` → `~/.local/bin`

**Restart OpenCode** to load the new MCP server and config. Full walkthrough: [docs/INSTALL.md](docs/INSTALL.md).

### Option B — manual Claude Code registration

```bash
claude mcp add-json -s user agy-bridge \
  '{"command":"npx","args":["-y","agy-bridge"],"timeout":600000}'
```

> The `"timeout": 600000` (10 min) is the **client-side** tool-call deadline — without it long `analyze_files` / `delegate` calls can hit Claude Code's default and return `timed out waiting for response` while the agy run is still going. The OpenCode config in this repo sets `timeout: 5400000` for the same reason.

### Toggling on/off

```bash
agy-bridge-toggle status   # STATE: ON / OFF / MIXED / UNINITIALIZED
agy-bridge-toggle off      # disable mcp.agy-bridge + strip OMO gating (snapshot kept)
agy-bridge-toggle on       # restore byte-identical from snapshot
```

Toggling edits config files — it applies on the **next OpenCode session restart**. `MIXED` means configs disagree (e.g. MCP disabled but OMO gating still present).

### Uninstalling

```bash
bash scripts/uninstall.sh   # Windows: powershell -File scripts\uninstall.ps1
```

Removes every component the installer added and restores `opencode.jsonc` from its merge backup. Pre-existing user configs are never deleted (installer `*.new` artifacts only). agy CLI, Node, Bun and the repo itself are shared tools — left in place.

## Tools

| Tool                 | Use for                                                         | Model routing                                                  |
| -------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `analyze_files`      | Files >200 lines, >3 files at once, logs, dumps, generated code | per-tool chain (default: Gemini 3.7 Flash → Claude Sonnet 4.6) |
| `deep_search`        | git log/diff/blame archaeology, repo-wide greps                 | per-tool chain                                                 |
| `web_lookup`         | Docs, API references, external/current knowledge                | per-tool chain                                                 |
| `adversarial_review` | Plan critiques, design and code reviews (second model family)   | per-tool chain (critic roles lead with Claude)                 |
| `follow_up`          | Continue a prior session by `session_id` — no context resend    | inherits the session                                           |
| `delegate`           | Autonomous execution with 20 subagent roles (6-section prompt)  | per-role chain (see below)                                     |
| `get_session_status` | Current/latest session ID, status, directory binding            | —                                                              |
| `list_sessions`      | All recorded sessions (find IDs to resume with `follow_up`)     | —                                                              |

All tools accept optional `cwd` (project root). `delegate`/`follow_up` also accept `load_memories` / `save_memory` (agentmemory) and `skills` (inject full SKILL.md protocols).

### Model routing (single source of truth)

Resolution order: explicit `model` arg → `roles[roleKey]` in `~/.gemini/config/agy_bridge.jsonc` → builtin `OMO_ROLES[role].chain` in `src/tools.ts` → tool chain → `AGY_DEFAULT_MODEL` → agy's own default. Override per role with `AGY_ROLE_MODEL_<ROLE>` env or the `roles` block in the config file. Models are validated against `agy models` output up front (agy silently ignores unknown `--model` values).

Every response ends with a footer:

```
---
[agy-bridge] model: gemini-3.5-flash-low | session: ae32eb4d-f2a3-49de-8165-07212be0d065 (use follow_up to continue)
```

### Quota-aware failover

agy never surfaces quota exhaustion in print mode — it silently retries the 429 until its print-timeout, then exits 0 with empty output. The bridge watches each run's log file (`--log-file`) and on `RESOURCE_EXHAUSTED (code 429)`:

1. kills the agy process group immediately (no waiting out the timeout),
2. parses the reset time ("Resets in 4h24m") into an in-process cooldown registry,
3. retries the **same prompt on the next model in the chain**, same conversation/session,
4. skips cooled-down models on subsequent calls until their quota resets.

Failovers are annotated in the response footer (`failover: <model>: quota exhausted (resets in 4h24m)`). Only when every candidate is exhausted does the call fail — in seconds, with reset times listed. The error message then instructs you to `follow_up` with the session id to resume the same conversation automatically.

### Timeouts and cancellation

Each tool has its own default timeout: `web_lookup` 120s, `deep_search` 180s, `analyze_files` / `adversarial_review` 300s, `delegate` / `follow_up` 600s. The OpenCode installer config sets generous per-tool budgets (`AGY_TIMEOUT_DELEGATE=3600`, `AGY_TIMEOUT_ANALYZE_FILES=900`, …). Set `AGY_TIMEOUT` to override all at once, or `AGY_TIMEOUT_<TOOL_NAME>` for a single tool (wins over the global). The kill path escalates SIGTERM → SIGKILL across the whole process group; cancelling the tool call from the MCP client also kills the agy run instead of orphaning it. An idle watchdog (default 90s, `AGY_IDLE_TIMEOUT`) detects stalls with no log output.

**Two timeout layers — align them.** The agy-side budget and your client's tool-call timeout are separate. If the client is shorter, it gives up first (`timed out waiting for response` — note agy-bridge's own timeout reads `agy timed out after Ns`). The work is not lost: the session persists, so `follow_up` retrieves the result. Rule of thumb: **client timeout ≥ agy budget**.

## Configuration

All optional, via environment variables:

| Variable                | Default    | Description                                                                              |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `AGY_PATH`              | `agy`      | Path to the agy binary                                                                   |
| `AGY_TIMEOUT`           | per-tool   | Seconds; overrides all per-tool timeouts at once                                         |
| `AGY_TIMEOUT_<TOOL>`    | per-tool   | Seconds; overrides one tool, e.g. `AGY_TIMEOUT_DEEP_SEARCH=300`. Wins over `AGY_TIMEOUT` |
| `AGY_IDLE_TIMEOUT`      | `90`       | Inactivity threshold (no log output) before a stall is detected and the process killed   |
| `AGY_MAX_OUTPUT_CHARS`  | `50000`    | Truncation cap for tool output                                                           |
| `AGY_DEFAULT_MODEL`     | unset      | Fallback model when no chain entry is available                                          |
| `AGY_ROLE_MODEL_<ROLE>` | unset      | Comma-separated model chain override for a role, e.g. `AGY_ROLE_MODEL_ORACLE`            |
| `AGY_SKIP_PERMISSIONS`  | `true`     | Pass `--dangerously-skip-permissions` to agy                                             |
| `AGY_SANDBOX`           | `false`    | Run agy with `--sandbox`                                                                 |
| `AGY_ON_FAILURE`        | `fallback` | `strict` tells the calling agent not to absorb failed work itself                        |

The 19-role model chains live in `~/.gemini/config/agy_bridge.jsonc` (see `config/agy_bridge.jsonc.example`). `defaultModel` defaults to `gemini-3.7-flash-high`.

## Delegation protocol

Every `delegate` call with structured parameters (`task`/`role`/`expected_outcome`/`must_do`/…) renders the canonical prompt:

```
[DELEGATED AGENT ROLE: X] + Mission
<Category_Context>                       ← role-category mindset
<Model_Family_Context>                   ← adapted to Claude (extended reasoning) or Gemini (tool-call enforcement)
## 1. TASK / OBJECTIVE
## 2. EXPECTED OUTCOME
## 3. REQUIRED TOOLS (WHITELIST)
## 4. MUST DO
## 5. MUST NOT DO
## 6. CONTEXT & BACKGROUND
## ROLE FOCUS AREAS
## AGENT MEMORY RECALL DIRECTIVE          ← mandatory when load_memories set
## AGENT MEMORY PERSISTENCE DIRECTIVE     ← mandatory when save_memory set
## AVAILABLE SKILLS                       ← capped at 40; agy-delegation always first
## INJECTED SKILL PROTOCOLS               ← full SKILL.md content for skills: [...]
## EXECUTION PROTOCOL & DELIVERABLES
## EXECUTION DISCIPLINE                   ← anti-delegation, verification, scope
[OUTPUT_RULES]                           ← English only, cite file:line
```

Supported subagent roles (19): `git-master`, `oracle`, `librarian`, `explore`, `momus`, `metis`, `multimodal-looker`, `ultrabrain`, `deep`, `visual-engineering`, `artistry`, `writing`, `quick`, `tester`, `reviewer`, `security`, `researcher`, `devops`, `product`.

The prompt is also adapted to the **resolved model family** (Claude variant: extended reasoning; Gemini variant: aggressive tool-call enforcement, anti-optimism checkpoints, repeated verification). `metis` is a plan consultant — delegate to it BEFORE planning to surface hidden intentions, ambiguities, and AI-slop patterns. `momus` is an approval-biased plan/diff verifier (OKAY or REJECT with ≤3 issues).

## Live telemetry — agy-live2

```bash
agy-live2        # OpenTUI monitor (bun) — current session live, quota/context meters, session switcher
agy-live         # lighter node runner
```

Reads the agy transcript (`~/.gemini/antigravity-cli/brain/<id>/.../transcript.jsonl`) in real time with per-step caps (256KB/tick, 50k chars/step) so even multi-MB transcripts render without OOM.

## Development

```bash
npm install
npm test           # vitest unit tests (exec mocked — no agy needed)
npm run typecheck
npm run build      # tsup → dist/index.js
```

## License

MIT — upstream: [sshahzaiib/agy-bridge](https://github.com/sshahzaiib/agy-bridge)
