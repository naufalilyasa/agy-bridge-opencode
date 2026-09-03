# OMO vs agy-bridge — Subagent Role Mapping

> Perbandingan antara **Oh My OpenAgent (OMO)** native agent system dengan **agy-bridge OMO_ROLES**.
> OMO source: `~/.cache/opencode/packages/oh-my-openagent@4.19.4` (npm package, bukan repo workspace — oh-my-openagent/ di-hapus dari repo agy-bridge karena 1.8GB git.git).
> agy-bridge source: `src/tools.ts` OMO_ROLES (19 role, 7 alias).

---

## 1. Arsitektur Delegasi: Perbedaan Fundamental

| Aspek | OMO Native | agy-bridge |
| :---- | :--------- | :--------- |
| **Subagent dipanggil via** | `task()` → category → sisyphus-junior worker; `call_omo_agent` → role agent; `@Agent` mention | `delegate` MCP tool → role param → spawn `agy CLI` |
| **Model routing** | Category → model (buildSystemContent) | Role → chain di agy_bridge.jsonc (SSOT) |
| **Persona systemPrompt** | Compiled di binary (model-family-specific: gemini, gpt, claude, kimi, glm variants) | Hardcoded di `OMO_ROLES` → mission + focus → di-inject ke prompt |
| **Prompt construction** | 3-layer: Agent systemPrompt (binary) + buildSystemContent (skill + category prompt_append + plan) + buildTaskPrompt (user wrapper) | 1-layer: `buildPrompt()` di tools.ts → semua di-inject ke satu prompt string |
| **Category_Context** | `<Category_Context>` di system message worker | Ada di delegate prompt |
| **EXECUTION DISCIPLINE** | Ada di sisyphus-junior persona (tergantung model: gemini punya anti-optimism, claude punya anti-delegation) | Ada di delegate prompt — **kini model-family-aware**: `<Model_Family_Context model="claude|gemini|gpt">` menyuntik variant sesuai model ter-resolusi |
| **Agent memory** | Via agentmemory MCP (sama) | Via memory directives di prompt + default memory protocol di server.ts |
| **Skill injection** | buildSystemContent → skill content + category prompt_append | resolveSkillContent() + listAvailableSkills() di delegate prompt |

---

## 2. Role Mapping

| agy-bridge role | OMO native agent | Kesesuaian |
| :-------------- | :--------------- | :--------- |
| **deep** | Category `deep` (Autonomous research + execution) | **IDENTIK** — OMO category → model. agy-bridge role → chain. |
| **ultrabrain** | Category `ultrabrain` (Hard logic, architecture decisions) | **IDENTIK** — sama persis |
| **visual-engineering** | Category `visual-engineering` (Frontend, UI/UX, design) | **IDENTIK** — sama persis |
| **quick** | Category `quick` (Single-file changes, typos) | **IDENTIK** — sama persis |
| **tester** / **qa** | Tidak ada agent builtin khusus tester | **HANYA di agy-bridge** — OMO tidak punya dedicated tester agent. Testing dilakukan oleh agent utama dengan prompt. |
| **oracle** | Oracle (oracle.d.ts) | **MIRIP** — OMO Oracle = "architecture/debugging" (dari README). agy-bridge Oracle = "adversarial critic". Bedanya: OMO Oracle lebih ke architecture review, agy-bridge lebih ke adversarial code review. |
| **librarian** | Librarian (librarian.d.ts) | **MIRIP** — OMO Librarian = "docs/code search" (dari README). agy-bridge Librarian = library/package research: cari library, version compatibility dengan project stack, trade-off versi. Tools: MCP context7 + exa/web search + webfetch. Git archaeology kini di explore (researcher dihapus). |
| **explore** | Explore (explore.d.ts) | **MIRIP** — OMO Explore = "fast codebase grep" (dari README). agy-bridge Explore = "codebase scout, broad search". Sama. |
| **momus** | Momus (momus.d.ts) | **IDENTIK** (parity) — OMO Momus = "practical plan reviewer, APPROVAL BIAS, OKAY/REJECT ≤3 issues". agy-bridge Momus kini sama: approval-biased verifier, cek references/executability/kontradiksi/QA-scenarios, verdict OKAY/REJECT. |
| **metis** | Metis (metis.d.ts) | **PARITY** — OMO Metis = "Plan Consultant" (analisis SEBELUM planning: hidden intentions, ambiguities, AI-slop). agy-bridge Metis kini sama: `OMO_METIS_PLAN_CONSULTANT`, category architecture, chain [Claude, Gemini]. Fokus: extract hidden intentions, deteksi ambiguity/AI-slop, clarifying questions + planner directives. |
| **multimodal-looker** | Multimodal Looker (multimodal-looker.d.ts) | **IDENTIK** — sama persis. |
| **git-master** | git-master skill (dist/skills/git-master/agents/openai.yaml) | **IDENTIK** — OMO git-master = "Atomic Git commits, history surgery, and source archaeology". agy-bridge = "git history with surgical precision, never modify code". |
| **reviewer** | Momus (review plan) | **MIRIP** — agy-bridge Reviewer = "adversarial code review". Ini mirror fungsi Momus. OMO pakai Momus untuk review. |
| **security** | Tidak ada agent builtin khusus security | **HANYA di agy-bridge** — OMO tidak punya dedicated security agent. Ada security-research skill yang pake Team Mode. |
| **devops** | Tidak ada agent builtin khusus devops | **HANYA di agy-bridge** |
| **writing** | Tidak ada agent builtin khusus writing | **HANYA di agy-bridge** — OMO writing dilakukan oleh agent utama. |
| **product** | Tidak ada agent builtin khusus product | **HANYA di agy-bridge** |
| **researcher** | _removed_ | **DIHAPUS** — di-merge ke explore. Git archaeology + external research kini jadi tanggung jawab explore. |
| **artistry** | engineering category (tidak spesifik) | **HANYA di agy-bridge** — OMO tidak punya dedicated design/artistry agent. |

> **Catatan:** OMO punya 3 main agents (Sisyphus, Hephaestus, Prometheus) yang TIDAK ada di agy-bridge — mereka orchestrator, bukan subagent. agy-bridge hanya delegasi sub-agent (per instruksi user: sisyphus-junior dihapus, fallback = OMO_GENERIC_EXECUTOR).

---

## 3. Prompt Construction Comparison

### OMO Native (3-layer)

```
Layer 1: Agent systemPrompt (binary, model-family-specific)
  └─ Sisyphus-Junior: 9 variants (default/claude, gemini, gpt, kimi, glm...)
  └─ Oracle: createOracleAgent(model) → AgentConfig
  └─ Librarian: createLibrarianAgent(model) → AgentConfig
  └─ ... (masing-masing punya prompt sendiri)

Layer 2: buildSystemContent(BuildSystemContentInput)
  └─ Skill content (dari SKILL.md)
  └─ Category prompt_append (dari omo.jsonc)
  └─ Plan agent system prepend

Layer 3: buildTaskPrompt(prompt, agentName, tddEnabled)
  └─ User prompt wrapper
  └─ TDD note
```

### agy-bridge (1-layer, semua di `buildPrompt()`)

```
[DELEGATED AGENT ROLE: X]
Mission: ...

<Category_Context>           ← role-category mindset

## 1. TASK / OBJECTIVE
## 2. EXPECTED OUTCOME
## 3. REQUIRED TOOLS
## 4. MUST DO
## 5. MUST NOT DO
## 6. CONTEXT & BACKGROUND
## ROLE FOCUS AREAS
## AGENT MEMORY RECALL DIRECTIVE
## AGENT MEMORY PERSISTENCE DIRECTIVE
## AVAILABLE SKILLS
## INJECTED SKILL PROTOCOLS
## EXECUTION PROTOCOL & DELIVERABLES
## EXECUTION DISCIPLINE
[OUTPUT_RULES]
```

### Perbedaan Kunci

| Aspek | OMO | agy-bridge |
| :---- | :-: | :--------- |
| **Model-family adaptation** | 9 prompt variants per model (default/gemini/gpt/kimi/glm) | 1 prompt untuk semua model (tidak ada adaptasi) |
| **Persona depth** | Masing-masing agent punya systemPrompt terpisah (di binary) | Semua role pakai mission + focus (1-2 kalimat) |
| **Skill injection** | buildSystemContent → gabung dengan prompt_append | resolveSkillContent() + listAvailableSkills() sebagai section terpisah |
| **Memory** | Via agentmemory MCP (external) | Directives di prompt (recall before / save before final) |
| **Tool whitelist** | Lewat permission config | explicit `required_tools` parameter |
| **Output rules** | Di systemPrompt masing-masing agent | `OUTPUT_RULES` global (English only, no preamble, cite file:line) |

---

## 4. Gaps & Recommendations

> Status: Gap 1, 3, 6 sudah diimplementasi (commit model-family variants + metis/momus parity + hapus sisyphus-junior). Gap 2, 4, 5 keputusan desain — lihat catatan masing-masing.

### Gap 1: Tidak ada model-family-specific prompt adaptation — ✅ DIIMPLEMENTASI
- **Masalah**: agy-bridge pakai 1 prompt untuk semua model. OMO punya variants per model family.
- **Dampak**: Gemini butuh anti-optimism checkpoints, Claude butuh anti-delegation.
- **Solusi (implemented)**: `delegate` kini menerima model ter-resolusi (dari `resolution.models[0]`, yang sudah memperhitungkan override agy_bridge.jsonc + chain). `buildPrompt(args, cwd, model)` menyuntik `<Model_Family_Context model="claude|gemini|gpt">` setelah `<Category_Context>`:
  - **Claude variant** (mirror OMO sisyphus-junior default.d.ts): extended reasoning, blocking delegation attempts.
  - **Gemini variant** (mirror OMO gemini.d.ts): aggressive tool-call enforcement, anti-optimism checkpoints, repeated verification mandates, stronger scope discipline.
  - Chain & override agy_bridge.jsonc dipertahankan penuh — model config tetap SSOT di config file.

### Gap 2: OMO Oracle ≠ agy-bridge Oracle
- **Masalah**: OMO Oracle = architecture/debugging consultant. agy-bridge Oracle = adversarial critic. Fungsi beda.
- **Saran**: Tergantung kebutuhan. Yang sekarang lebih cocok untuk code review. Kalau mau architecture review, perlu role baru.
- **Keputusan user (poin 4)**: dijawab di pembahasan — fungsi beda konteks, dipertahankan.

### Gap 3: OMO Metis = plan consultant, agy-bridge Metis = multi-file analyst — ✅ DIIMPLEMENTASI
- **Masalah**: Fungsi beda total. OMO Metis menganalisis SEBELUM planning.
- **Solusi (implemented)**: Metis ditulis ulang jadi OMO-parity **plan consultant** — title `OMO_METIS_PLAN_CONSULTANT`, category architecture, chain [Claude Sonnet 4.6 (Thinking), Gemini 3.7 Flash (High)]. Mission/focus: analisis request SEBELUM planning (hidden intentions, ambiguities, AI-slop patterns, clarifying questions). Ditambah instruksi "Pre-plan step" di omo.jsonc prompt_append sisyphus/hephaestus/prometheus: sebelum bikin plan/to-do OPTIONAL delegate ke metis dulu.

### Gap 4: Role yang hanya ada di agy-bridge (tester, security, devops, writing, product, artistry)
- **Masalah**: OMO tidak punya dedicated agents untuk ini.
- **Saran**: Ini justru kelebihan agy-bridge — lebih granular. Tapi perlu dipastikan prompt persona-nya cukup dalam.
- **Keputusan user (poin 3)**: TIDAK dihapus — dipertahankan.

### Gap 5: Prompt persona terlalu pendek
- **Masalah**: Mission agy-bridge cuma 1-2 kalimat. OMO systemPrompt puluhan line.
- **Saran**: Untuk role penting (oracle, security, tester), perluas mission jadi lebih detail dengan verification criteria spesifik.
- **Progress**: metis & momus sudah diperdalam ke persona OMO-grade (parity). Oracle/librarian/explore sudah detail dari iterasi sebelumnya. Role lain bisa menyusul.

### Gap 6: Default role = sisyphus-junior — ✅ DIHAPUS (per instruksi user)
- **Keputusan user**: sisyphus-junior DIHAPUS dari agy-bridge karena agy-bridge difokuskan sebagai sub-agent saja (seperti OMO delegate sub-agent). Role fallback saat `args.role` kosong → inline `OMO_GENERIC_EXECUTOR`. Jumlah role kini **19** (sisyphus-junior & alias junior hilang dari OMO_ROLES, role list, description, schema, omo.jsonc catalog, docs).

---

## 5. Ringkasan

| Metrik | OMO | agy-bridge |
| :----- | :-: | :--------- |
| Jumlah role subagent | ~8 (oracle, librarian, explore, momus, metis, multimodal-looker, git-master) | 18 (tester, security, devops, writing, product, artistry, reviewer, deep, ultrabrain, visual-engineering, dll) |
| Jumlah main agent | 4 (Sisyphus, Hephaestus, Prometheus, Atlas) | 0 (agy-bridge = sub-agent-only; orchestrator di OpenCode/OMO) |
| Model-family adaptation | 9 variants per agent | 3 variants (claude/gemini/gpt) via `<Model_Family_Context>` di delegate prompt |
| Persona depth | Full systemPrompt (puluhan line, di binary) | Mission 1-2 kalimat |
| Category system | 4 categories (visual-engineering, deep, quick, ultrabrain) | 6 categories (engineering, architecture, quality, security, research, product) |
| Prompt construction | 3-layer | 1-layer (semua di buildPrompt) |
| Skill injection | buildSystemContent | resolveSkillContent + listAvailableSkills |
| Memory protocol | Via agentmemory MCP external | Directives di prompt (mandatory) |
| Quota failover | Tidak ada (pake model fallback OMO) | Ada (CooldownRegistry + model chain iteration) |