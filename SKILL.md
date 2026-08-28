---
name: agy-delegation
description: Offload heavy analysis, multi-file edits, git archaeology, code review, and testing to Antigravity CLI via agy-bridge MCP tools.
---

# AGY-BRIDGE DELEGATION PROTOCOL

agy-bridge is an MCP server that bridges OpenCode to the Antigravity CLI (agy). It offloads heavy
execution, analysis, and research to agy subagents so your primary context window stays small —
only the answers come back, never the intermediate files or tool spam.

**Hard rules** (from the server):
- All prompt content sent to agy-bridge tools MUST be written in **English**.
- NEVER pass a `model` parameter — the server resolves models automatically from the roles block
  in `~/.gemini/config/agy_bridge.jsonc` (per-role chains, `AGY_DEFAULT_MODEL` fallback).
- On quota exhaustion (HTTP 429) the server auto-detects the cooldown and falls back to the next
  model in the configured chain. You do not need to do anything.

---

## MCP TOOL REFERENCE

### 1. `delegate` — autonomous execution (timeout 600s default, env-overridable)

Full autonomous delegation with OMO sub-agent roles. agy has full tool access (shell, file edits,
web) in the given `cwd`. **The primary workhorse tool.**

**Parameters:**

| Field | Description |
| :---- | :---------- |
| `task` / `prompt` | Core objective (Section 1). One of the two is REQUIRED. |
| `role` | Subagent role (list below). Defaults to `git-master` when omitted. |
| `expected_outcome` / `outcome` | Deliverable, success criteria, acceptance test (Section 2). |
| `required_tools` / `tools` | Explicit tool whitelist (Section 3). |
| `must_do` / `requirements` | Exhaustive mandatory requirements (Section 4). |
| `must_not_do` / `forbidden` | Forbidden actions / architectural boundaries (Section 5). |
| `context` | Background, error messages, file hints (Section 6). |
| `skills` / `skill` | Skill name(s) to inject full SKILL.md content into the prompt. |
| `load_memories` | Concept(s)/query to recall from agentmemory BEFORE work (mandatory recall). |
| `save_memory` | Instruction to persist findings to agentmemory BEFORE final answer. |
| `cwd` | Working directory for the subagent (defaults to server cwd). |

**Supported roles (20):** `git-master`, `oracle`, `librarian`, `explore`, `momus`, `metis`,
`multimodal-looker`, `sisyphus-junior`, `ultrabrain`, `deep`, `visual-engineering`, `artistry`,
`writing`, `quick`, `tester`, `reviewer`, `security`, `researcher`, `devops`, `product`.

**Recommended role by task:**

| Task | Role |
| :--- | :--- |
| Commit / branch / PR / git conflict | `git-master` |
| Architecture, hard logic, design decisions | `ultrabrain`, `oracle` |
| Adversarial critique, hidden bugs | `momus`, `reviewer` |
| Goal-oriented deep research + implementation | `deep` |
| UI / Compose / styling | `visual-engineering` |
| Security audit / vulnerability | `security` |
| Unit / integration tests & QA | `tester`, `qa` |
| Technical writing / ADR / PRD | `writing`, `product` |
| Build / Gradle / CI-CD | `devops` |
| Fast, low-effort task | `quick` |
| Creative / unconventional solution | `artistry` |
| Broad repo exploration | `explore` |

**Canonical 6-section example:**

```json
{
  "role": "deep",
  "task": "Refactor AuthService token rotation and add unit tests",
  "expected_outcome": "Zero regression; token rotation works; all unit tests pass",
  "required_tools": ["view_file", "replace_file_content", "run_command"],
  "must_do": [
    "Preserve backward compatibility with existing token endpoints",
    "Run the test suite before finalizing"
  ],
  "must_not_do": [
    "Never bypass type safety with `any` casting",
    "Do not modify files outside the auth module"
  ],
  "context": "Legacy token TTL is 3600s. See src/auth/TokenManager.kt:45",
  "skills": ["programming", "git-master"],
  "load_memories": ["tuya-dp-mapping", "auth-session-management"],
  "save_memory": {
    "type": "architecture",
    "concepts": ["auth", "token-rotation"],
    "project": "reiwa-access",
    "summary": "Documented AuthService token rotation mechanism"
  },
  "cwd": "/path/to/project/root"
}
```

**Memory directives** — these are MANDATORY when provided:
- `load_memories`: subagent MUST query `agentmemory` via `memory_recall`/`memory_smart_search`
  before any other work. If tools unavailable or zero results, it MUST state
  `"MEMORY RECALL: 0 results"` explicitly. Silently skipping is a protocol violation.
- `save_memory`: subagent MUST call `memory_save`/`memory_lesson_save` (with the `project` field)
  before the final answer. Skipping counts as an incomplete task. If unavailable, state
  `"MEMORY SAVE: unavailable"`.

**Skill injection:** `skills: ["name", ...]` — the server resolves and injects the FULL SKILL.md
content (frontmatter stripped) via `resolveSkillContent()`. Resolution order: project dirs
(`.agents`, `.opencode`, `.claude`, `skills`), then `~/.gemini/config/skills/<name>`, then OMO
builtin package skills. When no explicit skills are requested, the prompt gets an
`## AVAILABLE SKILLS` section (capped at 40; `agy-delegation` is always guaranteed the first
slot) so the subagent can pick matching skills for its next delegation.

### 2. `follow_up` — continue a session (timeout 600s default)

Resume prior work WITHOUT re-sending context — the full prior context stays on agy's side.

**Parameters:** `session_id` (or omit / pass `"latest"` to auto-continue the last session for the
cwd), `question` / `instruction` (required), `context`, `load_memories`, `save_memory`, `cwd`.

```json
{
  "session_id": "ses_abc123",
  "instruction": "Fix the compilation error on line 42 in ViewModel.kt",
  "context": "Unresolved reference: RobotVacuumRepository"
}
```

### 3. `analyze_files` — large-file analysis (timeout 300s default)

Read and analyze files WITHOUT pulling them into your context. Use when a file is >200 lines or
the task spans more than 3 files: logs, DB dumps, generated code, cross-file reviews, comparisons.

**Parameters:** `files[]` (relative or absolute), `question`, `cwd`.

```json
{
  "files": ["logs/error-2026-08.log", "dist/index.js", "src/server.ts"],
  "question": "Find the root cause of the crash on startup and any duplicate symbols."
}
```

### 4. `deep_search` — codebase archaeology (timeout 180s default)

Git log/diff/blame spelunking and wide greps: "when/why did X change", "where is Y used".
Use instead of running many search commands yourself.

**Parameters:** `query`, `cwd`. Findings reported with commit hashes.

```json
{
  "query": "when was the auth middleware refactored and why"
}
```

### 5. `web_lookup` — web / docs lookup (timeout 120s default)

Current library docs, API references, error messages, versions, external knowledge newer than your
training data. Source URLs included for key claims.

**Parameters:** `query`, `cwd`.

```json
{
  "query": "current stable version of React Navigation v7 and its migration guide"
}
```

### 6. `adversarial_review` — second opinion (timeout 300s default)

Adversarial critique from a different model family (Gemini Pro). ALWAYS use for plan critiques,
design reviews, and pre-merge code review. Hunts for real flaws: bugs, edge cases, security issues,
performance traps, unstated assumptions, simpler alternatives. Findings ranked
critical/major/minor — no padding or praise.

**Parameters:** `content` (inline) XOR `files[]` (one is REQUIRED), optional `focus` (e.g.
`security`, `concurrency`), `cwd`.

```json
{
  "content": "The full plan or diff to review",
  "focus": "security, concurrency"
}
```

### 7. `get_session_status` — active session info (timeout 10s)

Current/latest session ID, status, and directory binding for the cwd. Use when a prior call timed
out or you need the session ID to resume.

### 8. `list_sessions` — session registry (timeout 10s)

All recorded sessions across directories: session IDs, project paths, last activity, step counts.
Find a session ID to pass to `follow_up`.

---

## DECISION TREE (quick pick)

| Situation | Tool |
| :-------- | :--- |
| Heavy multi-step implementation / refactor / test | `delegate` (role `deep` / `ultrabrain` / `tester`) |
| Large files or >3 files | `analyze_files` |
| Git history / repo-wide grep | `deep_search` |
| Docs / API / current info | `web_lookup` |
| Plan / design / pre-merge review | `adversarial_review` |
| Continue / fix / iterate previous work | `follow_up` |
| Find or inspect a session | `list_sessions` / `get_session_status` |

## SESSION TRAILER

Every working tool response ends with a metadata trailer so you can resume:
`[agy-bridge] model: <model> | session: <session_id>`
Capture the `session_id` — pass it to `follow_up` for iterative work without resending context.

## ERROR RECOVERY

On ANY error, timeout, stalled process, or rate-limit notice:
1. Do NOT abandon or hallucinate.
2. Call `follow_up` with the same `session_id` and an instruction to resume/retry.
3. The server handles model failover automatically (e.g. Gemini 3.7 Flash -> Claude Sonnet 4.6).

## GUARDRAILS

- Timeouts are env-configurable per tool (`AGY_TIMEOUT_<TOOL>`, e.g. `AGY_TIMEOUT_DELEGATE`);
  the defaults above are the in-code values. Stalls are auto-detected by an idle watchdog
  (default 90s).
- Output is capped (`AGY_MAX_OUTPUT_CHARS`, default 50000) to protect your context.
- `delegate`/`follow_up` accept `cwd` — subagents operate in that directory with full tool access.
