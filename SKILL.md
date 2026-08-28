---
name: agy-delegation
description: Comprehensive delegation guide for AI Agents to offload heavy analysis, multi-file edits, codebase archaeology, adversarial review, git workflows, and testing to Antigravity CLI via agy-bridge MCP tools to preserve token budget.
---

# 🛸 AGY-BRIDGE DELEGATION PROTOCOL FOR AI AGENTS

Use `agy-bridge` MCP tools to offload heavy execution and analysis to the Antigravity CLI. This preserves your primary context window while leveraging Gemini 3.7 Flash & Claude Sonnet 4.6.

---

## 🛠️ TOOL MATRIX & DECISION TREE

| Situation / Task                                             | Tool to Call                       | Recommended Subagent Role         | Model Priority               |
| :----------------------------------------------------------- | :--------------------------------- | :-------------------------------- | :--------------------------- |
| **Commit, branch, PR review, git conflict**                  | `delegate`                         | `git-master`                      | Gemini Flash ➔ Claude Sonnet |
| **Adversarial review, hidden bugs, risk audit**              | `adversarial_review` or `delegate` | `oracle` / `momus` / `reviewer`   | Claude Sonnet ➔ Gemini Flash |
| **Fast execution, targeted fixes, large files (>200 lines)** | `analyze_files` or `delegate`      | `sisyphus-junior`                 | Gemini Flash ➔ Claude Sonnet |
| **Codebase archaeology, git blame, history trace**           | `deep_search`                      | `librarian`                       | Gemini Flash ➔ Claude Sonnet |
| **Broad repo exploration & multi-file impact**               | `delegate`                         | `explore` / `metis`               | Gemini Flash ➔ Claude Sonnet |
| **Complex architectural refactoring & heavy lifting**        | `delegate`                         | `ultrabrain`                      | Claude Sonnet ➔ Gemini Flash |
| **UI components, Compose tokens, styling**                   | `delegate`                         | `visual-engineering` / `artistry` | Gemini Flash ➔ Claude Sonnet |
| **Security audit, secret scan, vulnerability**               | `delegate`                         | `security`                        | Claude Sonnet ➔ Gemini Flash |
| **Unit / Integration tests & QA verification**               | `delegate`                         | `tester` / `qa`                   | Gemini Flash ➔ Claude Sonnet |
| **Quick API doc lookup & syntax search**                     | `web_lookup` or `delegate`         | `quick`                           | Gemini Flash ➔ Claude Sonnet |
| **Technical writing, ADR, PRD, docs**                        | `delegate`                         | `writing` / `product`             | Gemini Flash ➔ Claude Sonnet |
| **Build optimization, Gradle, CI/CD pipelines**              | `delegate`                         | `devops`                          | Gemini Flash ➔ Claude Sonnet |
| **Continue / Iterative work on previous task**               | `follow_up`                        | _(uses session)_                  | Previous Model Chain         |

---

## 📋 CANONICAL 6-SECTION DELEGATION USAGE (`delegate`)

When OpenCode primary orchestrators (Sisyphus, Hephaestus, Prometheus, Atlas) delegate to `agy-bridge`, prefer structured 6-section parameters:

```json
{
  "role": "tester",
  "task": "Refactor AuthService token rotation and create unit tests",
  "expected_outcome": "Zero regression, token rotation working, all unit tests passing",
  "required_tools": ["view_file", "replace_file_content", "run_command"],
  "must_do": [
    "Preserve backward compatibility with existing token endpoints",
    "Run gradle/vitest suite before finalizing"
  ],
  "must_not_do": [
    "Never bypass type safety with `any` casting",
    "Do not modify files outside the auth module"
  ],
  "context": "Legacy token TTL is 3600s. See file src/auth/TokenManager.kt:45",
  "load_memories": ["tuya-dp-mapping", "auth-session-management"],
  "save_memory": {
    "type": "architecture",
    "concepts": ["auth", "token-rotation"],
    "project": "reiwa-access",
    "summary": "Documented AuthService token rotation mechanism"
  },
  "skills": ["git-master", "programming"],
  "cwd": "/path/to/project/root"
}
```

### 💡 Supported Subagent Roles:

- **Reasoning / Review / Architecture**: `oracle`, `momus`, `ultrabrain`, `reviewer`, `security`
- **Execution / Search / Engineering**: `git-master`, `librarian`, `explore`, `metis`, `sisyphus-junior`, `visual-engineering`, `artistry`, `writing`, `quick`, `tester`, `qa`, `devops`, `product`

### 🧠 Agent Memory Management (`load_memories` & `save_memory`):

- `load_memories: ["concept1", "concept2"]` — Subagent will query `agentmemory` (`memory_recall`) to load historical patterns before starting.
- `save_memory: { type, concepts, project, summary }` — Subagent will persist key architecture/patterns into `agentmemory` (`memory_save`) upon successful completion.

### 📚 Skill Injection (`skills` / `skill`):

You can pass any installed skill name in `skills: ["..."]` (e.g. `git-master`, `programming`, `frontend`, `debugging`, `refactor`, `remove-ai-slops`, `visual-qa`). `agy-bridge` will automatically locate and inject the full `SKILL.md` instructions into Antigravity CLI.

---

## 🔄 MULTI-TURN SESSIONS (`follow_up`)

Every tool response concludes with a metadata trailer:
`[agy-bridge] model: … | session: <session_id>`

To continue the task, fix compiler errors, or give feedback without re-sending full context:

```json
{
  "sessionId": "<session_id>",
  "instruction": "Fix the compilation error on line 42 in ViewModel.kt",
  "context": "Unresolved reference: RobotVacuumRepository"
}
```

---

## ⚡ ERROR RECOVERY & RESILIENCE RULE

If a delegation encounters **ANY error**, **timeout**, **stalled process**, or **rate limit notice**:

1. Do NOT abandon or hallucinate.
2. Immediately invoke `follow_up` with the same `sessionId` and an instruction to resume or retry.
3. `agy-bridge` maintains automatic model failover (e.g. Gemini 3.7 Flash ➔ Claude Sonnet 4.6).
