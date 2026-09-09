# Delegation rules: agy-bridge

You have agy-bridge MCP tools that delegate heavy work to the Antigravity CLI
(Gemini). Delegation keeps large content OUT of your context — only answers
come back. Prefer delegating over doing it yourself when:

- **Any file >200 lines** you'd otherwise read → `analyze_files`
- **More than 3 files** in one analysis/comparison → `analyze_files`
- **Git history or repo-wide searches** (git log/diff/blame, broad greps) → `deep_search`
- **Web/documentation lookups** → `web_lookup`
- **Plan critique or code review** → `adversarial_review` (always — a second
  model family catches what you miss)
- **Follow-up question on a prior delegation** → `follow_up` with the returned
  session id (never resend the context)

Do NOT delegate: small single-file edits, questions you can answer from
context already loaded, or tasks needing tools only you have.

## Routing: tools vs delegate (different lanes)

Tools and delegate are different lanes, not alternatives. Default reflex
"delegate for everything" is wrong — route by input knowledge and intent:

- **Known-input READ** (you know the file list / git question / wide grep)
  → `analyze_files` / `deep_search` / `web_lookup`. No session state, no
  sessions-file churn, answer-only, cheaper.
- **Pre-merge / pre-plan gate** → `adversarial_review` ALWAYS, mandatory not
  optional. You are one model family; a second family catches your blind spots
  (unstated assumptions, edge cases).
- **Unknown target / implementation / multi-turn / parallel fan-out**
  → `delegate` + role (+ `follow_up` for continuations). This is the ACT lane
  with full tool access and session state.
- **Delegation done, only follow-up questions** → `follow_up` with the session
  id. Never re-delegate the same context.

Rule of thumb: read/challenge with tools, work with delegate. When in doubt:
is this a question about code that already exists (read lane) or work that
changes code (act lane)?
