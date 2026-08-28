import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const OUTPUT_RULES =
  "Answer directly with no preamble or closing remarks. Be thorough but concise. " +
  "Cite file:line for every code-level finding. " +
  "Respond ONLY in English, regardless of the language of this prompt or any user context.";

const CATEGORY_CONTEXT: Record<string, string> = {
  engineering: `You are working on an ENGINEERING task.
Execution mindset: direct action, minimal overhead. Write code, verify it runs, and report exact file:line results.`,
  architecture: `You are working on an ARCHITECTURE task.
Reasoning mindset: weigh trade-offs, name unstated assumptions, and propose the minimal design that satisfies the goal. Back every recommendation with evidence.`,
  quality: `You are working on a QUALITY task.
Critique mindset: hunt for real flaws — bugs, edge cases, security issues, performance traps, and unstated assumptions. Rank findings by severity and justify each. No padding, no praise.`,
  security: `You are working on a SECURITY task.
Adversarial mindset: prove exploitability before claiming a finding, calibrate severity by actual risk, and never assume an attack surface is safe.`,
  research: `You are working on a RESEARCH task.
Investigation mindset: gather evidence across code and docs, verify claims, and report findings with sources and commit hashes where relevant.`,
  product: `You are working on a PRODUCT task.
Outcome mindset: focus on user value and acceptance criteria, ground decisions in the stated goal, and keep scope tight.`,
};

function isFastModel(model: string | undefined): boolean {
  return !!model && /flash|compact|mini|nano|fast/i.test(model);
}

function buildCallerWarning(firstModel: string | undefined): string {
  const model = firstModel || "a compact model";
  return (
    `THIS TASK USES ${/^[aeiou]/i.test(firstModel || "a") ? "AN" : "A"} ${model}.\n` +
    `The executing model is optimized for speed over depth. Your prompt must be EXHAUSTIVELY EXPLICIT:\n` +
    `- State the goal and acceptance criteria in one line.\n` +
    `- Give numbered, atomic MUST DO steps with explicit file paths.\n` +
    `- List MUST NOT DO boundaries and why each matters.\n` +
    `- Define the exact expected output and how it will be verified.\n` +
    `Do not rely on the model to infer scope, infer steps, or fill gaps.`
  );
}


export function resolveFiles(files: string[], cwd: string): string[] {
  return files.map((f) => (path.isAbsolute(f) ? f : path.resolve(cwd, f)));
}

export function resolveSkillContent(skillName: string, cwd: string): string | null {
  const norm = skillName.trim().replace(/^omo-/, "");
  const candidates = [
    // 1. Workspace skills
    path.join(cwd, ".agents", "skills", norm, "SKILL.md"),
    path.join(cwd, ".opencode", "skills", norm, "SKILL.md"),
    path.join(cwd, ".claude", "skills", norm, "SKILL.md"),
    path.join(cwd, "skills", norm, "SKILL.md"),
    // 2. Global Gemini skills
    path.join(os.homedir(), ".gemini", "config", "skills", norm, "SKILL.md"),
    path.join(os.homedir(), ".gemini", "config", "skills", `omo-${norm}`, "SKILL.md"),
    // 3. Builtin OMO package skills
    path.join(
      os.homedir(),
      "agy-bridge",
      "oh-my-openagent",
      "packages",
      "shared-skills",
      "skills",
      norm,
      "SKILL.md",
    ),
    path.join(os.homedir(), "agy-bridge", "oh-my-openagent", ".agents", "skills", norm, "SKILL.md"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        let raw = fs.readFileSync(p, "utf8");
        // Strip frontmatter --- ... ---
        if (raw.startsWith("---")) {
          const endIdx = raw.indexOf("---", 3);
          if (endIdx !== -1) {
            raw = raw.slice(endIdx + 3).trim();
          }
        }
        return raw.trim();
      } catch {}
    }
  }
  return null;
}

function skillDescription(p: string): string {
  try {
    const raw = fs.readFileSync(p, "utf8");
    if (!raw.startsWith("---")) return "";
    const endIdx = raw.indexOf("---", 3);
    if (endIdx === -1) return "";
    const m = raw.slice(0, endIdx).match(/^description:\s*(.+)$/im);
    return m
      ? m[1]
          .trim()
          .replace(/^["']|["']$/g, "")
          .slice(0, 120)
      : "";
  } catch {
    return "";
  }
}

export function listAvailableSkills(
  cwd: string,
  exclude: string[] = [],
): { name: string; description: string }[] {
  const MAX_SKILLS = 40;
  const seen = new Set(exclude.map((s) => s.trim().replace(/^omo-/, "").toLowerCase()));
  const out: { name: string; description: string }[] = [];

  // Guaranteed slot: agy-delegation always occupies the first entry when
  // installed, so it is never crowded out of the cap by a large skill
  // collection. Fills one of the MAX_SKILLS slots.
  const agySkillPath = path.join(
    os.homedir(),
    ".gemini",
    "config",
    "skills",
    "agy-delegation",
    "SKILL.md",
  );
  try {
    if (fs.statSync(agySkillPath).isFile()) {
      seen.add("agy-delegation");
      out.push({ name: "agy-delegation", description: skillDescription(agySkillPath) });
    }
  } catch {}

  const roots = [
    path.join(cwd, ".agents", "skills"),
    path.join(cwd, ".opencode", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, "skills"),
    path.join(os.homedir(), ".gemini", "config", "skills"),
    path.join(os.homedir(), "agy-bridge", "oh-my-openagent", "packages", "shared-skills", "skills"),
    path.join(os.homedir(), "agy-bridge", "oh-my-openagent", ".agents", "skills"),
  ];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.replace(/^omo-/, "");
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      const skillMd = path.join(root, entry, "SKILL.md");
      try {
        if (!fs.statSync(skillMd).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(key);
      out.push({ name, description: skillDescription(skillMd) });
      if (out.length >= MAX_SKILLS) return out;
    }
  }
  return out;
}

const commonShape = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the working directory / project root. Defaults to the server's cwd.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      'Override the model (exact name from `agy models`, e.g. "Gemini 3.1 Pro (High)"). ' +
        "Normally omit — the tool routes automatically.",
    ),
};

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  chain: string[];
  /** Default --print-timeout for this tool, in seconds. AGY_TIMEOUT overrides. */
  timeoutSec: number;
  buildPrompt(args: Record<string, unknown>, cwd: string): string;
}

export interface OmoRoleDefinition {
  title: string;
  category: "engineering" | "architecture" | "quality" | "security" | "research" | "product";
  mission: string;
  focus: string[];
  /** Default fallback model chain for this role (ordered by preference) */
  chain?: string[];
}

export const OMO_ROLES: Record<string, OmoRoleDefinition> = {
  // --- OMO GIT MASTER SUBAGENT ---
  "git-master": {
    title: "OMO_GIT_MASTER",
    category: "engineering",
    mission:
      "You are the Git Master. Specialize in atomic git commits, branch management, merge conflict resolution, conventional commit formatting, staged diff verification, and git history integrity.",
    focus: [
      "Conventional commit formatting (feat, fix, refactor, docs, chore, test)",
      "Atomic commit grouping and staged diff auditing",
      "Clean branch management and conflict resolution",
      "Git history cleanliness and commit integrity",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  git_master: {
    title: "OMO_GIT_MASTER",
    category: "engineering",
    mission:
      "You are the Git Master. Specialize in atomic git commits, branch management, merge conflict resolution, conventional commit formatting, staged diff verification, and git history integrity.",
    focus: [
      "Conventional commit formatting (feat, fix, refactor, docs, chore, test)",
      "Atomic commit grouping and staged diff auditing",
      "Clean branch management and conflict resolution",
      "Git history cleanliness and commit integrity",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  git: {
    title: "OMO_GIT_MASTER",
    category: "engineering",
    mission:
      "You are the Git Master. Specialize in atomic git commits, branch management, merge conflict resolution, conventional commit formatting, staged diff verification, and git history integrity.",
    focus: [
      "Conventional commit formatting (feat, fix, refactor, docs, chore, test)",
      "Atomic commit grouping and staged diff auditing",
      "Clean branch management and conflict resolution",
      "Git history cleanliness and commit integrity",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  oracle: {
    title: "OMO_ORACLE_ADVERSARIAL_CRITIC",
    category: "quality",
    mission:
      "You are the deep code reasoner and adversarial critic. Hunt for subtle bugs, race conditions, edge cases, security vulnerabilities, and unstated assumptions in plans and code.",
    focus: [
      "Adversarial analysis of code and design proposals",
      "Identifying unstated edge cases and concurrency traps",
      "Ranking findings by severity (Critical / Major / Minor)",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  librarian: {
    title: "OMO_LIBRARIAN_ARCHAEOLOGIST",
    category: "research",
    mission:
      "You are the codebase archaeologist. Conduct repo-wide git history, git blame, git diff, and grep searches, reading large files (>200 lines) to provide clear historical context.",
    focus: [
      "Git archaeology, blame, and evolution tracing",
      "Historical rationale discovery for complex subsystems",
      "Comprehensive knowledge retrieval with exact file:line citations",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  explore: {
    title: "OMO_EXPLORER_RESEARCHER",
    category: "research",
    mission:
      "You are the codebase explorer. Perform broad repository searches and external documentation lookups to understand dependencies and symbol relationships.",
    focus: [
      "Broad codebase exploration and symbol discovery",
      "External documentation and API reference lookups",
      "Dependency mapping and caller/callee tracing",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  momus: {
    title: "OMO_MOMUS_VERIFIER",
    category: "quality",
    mission:
      "You are the adversarial plan and code verifier. Inspect large diffs, audit implementation details, and verify that code changes fulfill all quality and safety criteria.",
    focus: [
      "Diff inspection and pre-merge validation",
      "Catching architectural leaks and regressions",
      "Independent second-opinion verification",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  metis: {
    title: "OMO_METIS_MULTI_FILE_ANALYST",
    category: "research",
    mission:
      "You are the multi-file analyst. Perform complex cross-file analysis, trace data flows across layers, and coordinate multi-component refactoring.",
    focus: [
      "Multi-file dependency and call graph analysis",
      "Cross-layer data flow verification",
      "Complex refactoring impact analysis",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  "multimodal-looker": {
    title: "OMO_MULTIMODAL_LOOKER",
    category: "engineering",
    mission:
      "You are the visual and asset inspector. Inspect visual asset logs, UI layouts, screenshots, and external reference documentation.",
    focus: [
      "UI asset structure and icon/theme validation",
      "Visual layout verification and asset descriptor checks",
      "External visual reference lookups",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  looker: {
    title: "OMO_MULTIMODAL_LOOKER",
    category: "engineering",
    mission:
      "You are the visual and asset inspector. Inspect visual asset logs, UI layouts, screenshots, and external reference documentation.",
    focus: [
      "UI asset structure and icon/theme validation",
      "Visual layout verification and asset descriptor checks",
      "External visual reference lookups",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  "sisyphus-junior": {
    title: "OMO_SISYPHUS_JUNIOR",
    category: "engineering",
    mission:
      "You are the fast execution assistant. Read large files (>200 lines), fetch documentation lookups, and execute targeted file updates.",
    focus: [
      "Fast file reading and log inspections",
      "Targeted code updates and fix applications",
      "Documentation lookups and verification",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  junior: {
    title: "OMO_SISYPHUS_JUNIOR",
    category: "engineering",
    mission:
      "You are the fast execution assistant. Read large files (>200 lines), fetch documentation lookups, and execute targeted file updates.",
    focus: [
      "Fast file reading and log inspections",
      "Targeted code updates and fix applications",
      "Documentation lookups and verification",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },

  // --- OMO CATEGORIES & SPECIALIZED ROLES ---
  ultrabrain: {
    title: "OMO_ULTRABRAIN_ARCHITECT",
    category: "architecture",
    mission:
      "You are the ultrabrain reasoner. Perform deep architectural analysis, heavy lifting across complex modules, and adversarial validation of critical paths.",
    focus: [
      "Deep architectural reasoning and heavy refactoring",
      "Clean Architecture boundary enforcement",
      "Complex subsystem design and integration",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  deep: {
    title: "OMO_DEEP_ANALYST",
    category: "research",
    mission:
      "You are the deep repository analyst. Execute repo-wide scans, deep multi-file analysis, and thorough code inspections across the entire codebase.",
    focus: [
      "Repository-wide scans and deep code tracing",
      "Multi-file structural audits",
      "Comprehensive impact and regression analysis",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  "visual-engineering": {
    title: "OMO_VISUAL_ENGINEER",
    category: "engineering",
    mission:
      "You are the visual engineer. Specialize in reviewing large component files (>200 lines), UI dumps, Compose Multiplatform tokens, and layout systems.",
    focus: [
      "Compose Multiplatform & UI tokens",
      "Component layout and responsiveness",
      "State hoisting and UI performance",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  artistry: {
    title: "OMO_ARTISTRY_ENGINEER",
    category: "engineering",
    mission:
      "You specialize in design systems, theme controllers, visual assets, animations, and design tokens across platforms.",
    focus: [
      "Design tokens and theme controller alignment",
      "Asset management and visual styling",
      "Animation and interactive transitions",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  writing: {
    title: "OMO_TECHNICAL_WRITER",
    category: "product",
    mission:
      "You formulate technical documentation, architecture decision records (ADRs), PRDs, and evidence descriptors.",
    focus: [
      "Technical specifications and PRD drafting",
      "Evidence and audit documentation",
      "API documentation with accurate examples",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  quick: {
    title: "OMO_QUICK_RESEARCHER",
    category: "research",
    mission:
      "You perform rapid documentation lookups, quick symbol queries, and syntax references to keep workflows fast.",
    focus: [
      "Rapid API doc and library lookups",
      "Quick syntax and symbol verification",
      "Concise factual answers",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },

  // --- CANONICAL SUBAGENT ROLES ---
  tester: {
    title: "QA_TEST_ENGINEER",
    category: "quality",
    mission:
      "Author comprehensive unit, integration, and UI test suites. Cover edge cases, test error paths, create deterministic test doubles, and ensure high test coverage.",
    focus: [
      "Unit testing (JUnit, Kotest, Compose UI tests)",
      "Edge case and negative scenario validation",
      "Mock/fake repository implementations for tests",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  qa: {
    title: "QA_TEST_ENGINEER",
    category: "quality",
    mission:
      "Author comprehensive unit, integration, and UI test suites. Cover edge cases, test error paths, create deterministic test doubles, and ensure high test coverage.",
    focus: [
      "Unit testing (JUnit, Kotest, Compose UI tests)",
      "Edge case and negative scenario validation",
      "Mock/fake repository implementations for tests",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  reviewer: {
    title: "SENIOR_CODE_REVIEWER",
    category: "quality",
    mission:
      "Perform thorough adversarial code review. Identify subtle bugs, race conditions, memory leaks, performance traps, and Clean Architecture violations.",
    focus: [
      "Adversarial critique and defect detection",
      "Clean Architecture and quarantine compliance",
      "Actionable recommendations ranked by severity",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  "code-reviewer": {
    title: "SENIOR_CODE_REVIEWER",
    category: "quality",
    mission:
      "Perform thorough adversarial code review. Identify subtle bugs, race conditions, memory leaks, performance traps, and Clean Architecture violations.",
    focus: [
      "Adversarial critique and defect detection",
      "Clean Architecture and quarantine compliance",
      "Actionable recommendations ranked by severity",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  security: {
    title: "SECURITY_AUDITOR",
    category: "security",
    mission:
      "Audit codebase and configurations for vulnerabilities, injection vectors, secret exposure, insecure SDK usage, and privilege escalation risks.",
    focus: [
      "Secret detection and credential leaks",
      "Injection flaws and input sanitization",
      "SDK permission checks and sandbox boundary validation",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  "security-auditor": {
    title: "SECURITY_AUDITOR",
    category: "security",
    mission:
      "Audit codebase and configurations for vulnerabilities, injection vectors, secret exposure, insecure SDK usage, and privilege escalation risks.",
    focus: [
      "Secret detection and credential leaks",
      "Injection flaws and input sanitization",
      "SDK permission checks and sandbox boundary validation",
    ],
    chain: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
  },
  researcher: {
    title: "CODEBASE_RESEARCHER",
    category: "research",
    mission:
      "Conduct deep codebase archaeology, symbol mapping, call graph analysis, and dependency discovery. Provide clear, structured findings with exact file and line citations.",
    focus: [
      "Codebase indexing and symbol cross-referencing",
      "Git history, blame, and evolution tracing",
      "Exact file:line citation for all findings",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  explorer: {
    title: "CODEBASE_RESEARCHER",
    category: "research",
    mission:
      "Conduct deep codebase archaeology, symbol mapping, call graph analysis, and dependency discovery. Provide clear, structured findings with exact file and line citations.",
    focus: [
      "Codebase indexing and symbol cross-referencing",
      "Git history, blame, and evolution tracing",
      "Exact file:line citation for all findings",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  devops: {
    title: "DEVOPS_ENGINEER",
    category: "engineering",
    mission:
      "Optimize build configurations, Gradle scripts, CI/CD pipelines, Docker containers, and developer tooling for speed and reliability.",
    focus: [
      "Gradle build cache, Kotlin multiplatform compilation optimization",
      "CI/CD workflows and automated quality checks",
      "Environment isolation and dependency management",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
  product: {
    title: "PRODUCT_MANAGER",
    category: "product",
    mission:
      "Formulate PRDs, technical specs, user stories with acceptance criteria, and feature breakdown plans from user requirements.",
    focus: [
      "User story formulation with Gherkin acceptance criteria",
      "Feature decomposition and milestone planning",
      "Clear success metrics and definition of done",
    ],
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: "analyze_files",
    description:
      "Delegate file analysis to the Antigravity CLI (Gemini) instead of reading files yourself. " +
      "USE THIS whenever a file is large (>200 lines) or the task spans more than 3 files: " +
      "logs, database dumps, generated code, cross-file reviews, comparisons. " +
      "The files never enter your context — only the answer does.",
    schema: {
      files: z
        .array(z.string())
        .min(1)
        .describe("File paths to analyze (relative to cwd or absolute)."),
      question: z.string().describe("What you want to know about these files."),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = resolveFiles(args.files as string[], cwd);
      return (
        `Read and analyze these files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
        `Question: ${args.question}\n\n${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "deep_search",
    description:
      "Delegate codebase archaeology to the Antigravity CLI: git log/diff/blame spelunking, " +
      "wide greps across a repo, 'when/why did X change', 'where is Y used'. " +
      "USE THIS instead of running many search commands yourself — it saves your context.",
    schema: {
      query: z
        .string()
        .describe("What to find, e.g. 'when was the auth middleware refactored and why'."),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 180,
    buildPrompt(args) {
      return (
        `Search this repository to answer the following. Use git log, git diff, git blame, ` +
        `and grep as needed.\n\nQuery: ${args.query}\n\n` +
        `Report findings with commit hashes where relevant. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "web_lookup",
    description:
      "Delegate a web/documentation lookup to the Antigravity CLI (Gemini with web access): " +
      "library docs, API references, error messages, current versions, external knowledge. " +
      "USE THIS when you need information you don't have or that may be newer than your training data.",
    schema: {
      query: z.string().describe("What to look up on the web."),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 120,
    buildPrompt(args) {
      return `Look up on the web: ${args.query}\n\nInclude source URLs for key claims. ${OUTPUT_RULES}`;
    },
  },
  {
    name: "adversarial_review",
    description:
      "Get an adversarial second opinion from a different model family (Gemini Pro). " +
      "ALWAYS use this for plan critiques, design reviews, and pre-merge code review: " +
      "it hunts for flaws, edge cases, security issues, and unstated assumptions you may have missed.",
    schema: {
      content: z
        .string()
        .optional()
        .describe("Inline content to review (plan, diff, code snippet)."),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to review instead of inline content."),
      focus: z.string().optional().describe("Optional focus area, e.g. 'security', 'concurrency'."),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 300,
    buildPrompt(args, cwd) {
      const files = args.files as string[] | undefined;
      const content = args.content as string | undefined;
      if (!content && !files?.length) {
        throw new Error("adversarial_review requires either `content` or `files`.");
      }
      const subject = content
        ? `Review the following:\n\n${content}`
        : `Read and review these files:\n${resolveFiles(files!, cwd)
            .map((f) => `- ${f}`)
            .join("\n")}`;
      const focus = args.focus ? `\nFocus especially on: ${args.focus}.` : "";
      return (
        `You are an adversarial reviewer. Find real flaws: bugs, edge cases, security issues, ` +
        `performance traps, unstated assumptions, and simpler alternatives.${focus}\n\n${subject}\n\n` +
        `Rank findings by severity (critical/major/minor) and justify each. ` +
        `Do not pad with praise or restate the input. ${OUTPUT_RULES}`
      );
    },
  },
  {
    name: "follow_up",
    description:
      "Continue a previous Antigravity session. You can provide a session_id, or omit it (or pass 'latest') " +
      "to automatically continue the last session for the current working directory (cwd). " +
      "USE THIS for follow-up questions or resuming prior work — the full prior context is already on agy's side.",
    schema: {
      session_id: z
        .string()
        .optional()
        .describe(
          "The session id. Optional: omit or pass 'latest' to automatically use the last session for this directory.",
        ),
      question: z
        .string()
        .optional()
        .describe("The follow-up question or instruction to continue the task."),
      instruction: z
        .string()
        .optional()
        .describe("Alternative alias for 'question' (Oh My OpenAgent style)."),
      context: z
        .string()
        .optional()
        .describe("Additional context or test output to provide for continuation."),
      load_memories: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Memory concepts or queries to recall from agentmemory before continuing."),
      save_memory: z
        .union([
          z.string(),
          z.boolean(),
          z.object({
            type: z.string().optional().describe("Memory type"),
            concepts: z.array(z.string()).optional().describe("Tags/concepts"),
            project: z.string().optional().describe("Project name"),
            summary: z.string().optional().describe("Summary to save"),
          }),
        ])
        .optional()
        .describe("Instruction to persist new findings to agentmemory upon finishing."),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 600,
    buildPrompt(args) {
      const q = (args.instruction as string) || (args.question as string);
      if (!q) {
        throw new Error("follow_up requires either `question` or `instruction`.");
      }
      let prompt = q;
      const context = args.context as string | undefined;
      if (context) {
        prompt += `\n\n[Additional Context & Feedback]\n${context}`;
      }

      if (args.load_memories) {
        const mems = Array.isArray(args.load_memories) ? args.load_memories : [args.load_memories];
        prompt +=
          `\n\n## RECALL MEMORY DIRECTIVE — MANDATORY\nYou MUST query \`agentmemory\` via \`memory_recall\` BEFORE starting any work, for:\n` +
          mems.map((m: string) => `- "${m}"`).join("\n") +
          `\nIf tools are unavailable or zero results, state "MEMORY RECALL: 0 results" explicitly in your final answer.`;
      }

      if (args.save_memory) {
        prompt += `\n\n## SAVE MEMORY DIRECTIVE — MANDATORY\nBefore your final answer, you MUST persist key findings via \`memory_save\` (always include the project field). Skipping counts as an incomplete task; if tools are unavailable, state "MEMORY SAVE: unavailable" explicitly.`;
      }

      return prompt;
    },
  },
  {
    name: "get_session_status",
    description:
      "Get the current/latest Antigravity session ID, status, and directory binding for the current cwd. " +
      "Use this to check the active session ID if a prior call timed out or to inspect session state.",
    schema: {
      ...commonShape,
    },
    chain: [],
    timeoutSec: 10,
    buildPrompt() {
      return "";
    },
  },
  {
    name: "list_sessions",
    description:
      "List all recorded Antigravity sessions across directories, showing session IDs, " +
      "associated project paths, last activity timestamp, and step counts. " +
      "Use this to find previous session IDs to resume work with 'follow_up'.",
    schema: {
      ...commonShape,
    },
    chain: [],
    timeoutSec: 10,
    buildPrompt() {
      return "";
    },
  },
  {
    name: "delegate",
    description:
      "Autonomous delegation to the Antigravity CLI with Oh My OpenAgent (OMO) sub-agent role capabilities. " +
      "Supports specialized subagents: 'git-master', 'oracle', 'librarian', 'explore', 'momus', 'metis', 'multimodal-looker', 'sisyphus-junior', 'ultrabrain', 'deep', 'visual-engineering', 'artistry', 'writing', 'quick', 'tester', 'reviewer', 'security', 'researcher', 'devops', 'product'. " +
      "agy has full tool access (shell, file edits, web) in the given cwd.",
    schema: {
      prompt: z
        .string()
        .optional()
        .describe("The task prompt (or use 'task' + 'role' for structured OMO-style delegation)."),
      task: z
        .string()
        .optional()
        .describe("The core objective or atomic task description (Section 1: TASK)."),
      role: z
        .string()
        .optional()
        .describe(
          "OMO subagent role: 'git-master', 'oracle', 'librarian', 'explore', 'momus', 'metis', 'multimodal-looker', 'sisyphus-junior', 'ultrabrain', 'deep', 'visual-engineering', 'artistry', 'writing', 'quick', 'tester', 'reviewer', 'security', 'researcher', 'devops', 'product'.",
        ),
      expected_outcome: z
        .string()
        .optional()
        .describe(
          "Expected deliverable, success criteria, or acceptance test (Section 2: EXPECTED OUTCOME).",
        ),
      outcome: z.string().optional().describe("Alias for expected_outcome."),
      required_tools: z
        .array(z.string())
        .optional()
        .describe("Explicit tool whitelist (Section 3: REQUIRED TOOLS)."),
      tools: z.array(z.string()).optional().describe("Alias for required_tools."),
      must_do: z
        .array(z.string())
        .optional()
        .describe("Exhaustive list of mandatory requirements and actions (Section 4: MUST DO)."),
      requirements: z
        .array(z.string())
        .optional()
        .describe(
          "Specific constraints, rules, or test commands that must be satisfied (alias for must_do).",
        ),
      must_not_do: z
        .array(z.string())
        .optional()
        .describe(
          "Forbidden actions, anti-patterns, or architectural boundaries (Section 5: MUST NOT DO).",
        ),
      forbidden: z.array(z.string()).optional().describe("Alias for must_not_do."),
      context: z
        .string()
        .optional()
        .describe(
          "Relevant background context, error messages, or file hints (Section 6: CONTEXT).",
        ),
      skills: z
        .array(z.string())
        .optional()
        .describe(
          "List of skill names (e.g. ['git-master', 'programming', 'visual-qa']) to inject into the prompt.",
        ),
      skill: z
        .string()
        .optional()
        .describe("Single skill name to inject into the prompt (e.g. 'git-master' or 'refactor')."),
      load_memories: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Memory concepts, query terms, or memory IDs to recall from agentmemory before execution (e.g. ['tuya-dp-mapping', 'auth-session']).",
        ),
      save_memory: z
        .union([
          z.string(),
          z.boolean(),
          z.object({
            type: z
              .string()
              .optional()
              .describe("Memory type (architecture, testing, bugfix, pattern, lesson)"),
            concepts: z.array(z.string()).optional().describe("Tags/concepts to index"),
            project: z.string().optional().describe("Project name"),
            summary: z.string().optional().describe("Description of what to save"),
          }),
        ])
        .optional()
        .describe(
          "Instruction for subagent to persist key learnings/architecture to agentmemory via memory_save upon completion.",
        ),
      ...commonShape,
    },
    chain: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"],
    timeoutSec: 600,
    buildPrompt(args, cwd) {
      const task = (args.task as string) || (args.prompt as string);
      if (!task) {
        throw new Error("delegate requires either `task` or `prompt`.");
      }

      const roleKey = ((args.role as string) || "").toLowerCase().trim();
      const roleDef =
        OMO_ROLES[roleKey] ||
        (args.role
          ? {
              title: (args.role as string).toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
              category: "engineering" as const,
              mission: `Execute specialized tasks as ${args.role}. Deliver complete, verified, and high-quality results.`,
              focus: ["High-quality implementation", "Verification with builds/tests"],
            }
          : OMO_ROLES["git-master"]);
      const roleCategory = roleDef.category;
      const roleFirstModel =
        roleDef.chain?.[0] ??
        (roleCategory === "quality" || roleCategory === "security"
          ? "Claude Sonnet 4.6 (Thinking)"
          : "Gemini 3.7 Flash (High)");

      const expectedOutcome = (args.expected_outcome as string) || (args.outcome as string);
      const reqTools = (args.required_tools as string[]) || (args.tools as string[]);
      const mustDo = (args.must_do as string[]) || (args.requirements as string[]);
      const mustNotDo = (args.must_not_do as string[]) || (args.forbidden as string[]);
      const context = args.context as string | undefined;

      // Extract skills to inject
      const requestedSkills: string[] = [];
      if (Array.isArray(args.skills)) {
        for (const s of args.skills) {
          if (typeof s === "string" && s.trim()) requestedSkills.push(s.trim());
        }
      }
      if (typeof args.skill === "string" && args.skill.trim()) {
        if (!requestedSkills.includes(args.skill.trim())) {
          requestedSkills.push(args.skill.trim());
        }
      }

      // Extract memory management directives
      const loadMemories: string[] = [];
      if (typeof args.load_memories === "string" && args.load_memories.trim()) {
        loadMemories.push(args.load_memories.trim());
      } else if (Array.isArray(args.load_memories)) {
        for (const m of args.load_memories) {
          if (typeof m === "string" && m.trim()) loadMemories.push(m.trim());
        }
      }
      const saveMemory = args.save_memory;

      // If structured OMO parameters are provided, format as authoritative 6-section delegation
      if (
        args.task ||
        args.role ||
        expectedOutcome ||
        (reqTools && reqTools.length > 0) ||
        (mustDo && mustDo.length > 0) ||
        (mustNotDo && mustNotDo.length > 0) ||
        context ||
        requestedSkills.length > 0 ||
        loadMemories.length > 0 ||
        saveMemory
      ) {
        let p = `[DELEGATED AGENT ROLE: ${roleDef.title}]\n`;
        p += `Mission: ${roleDef.mission}\n\n`;

        const categoryContext = CATEGORY_CONTEXT[roleCategory];
        if (categoryContext) {
          p += `<Category_Context>\n${categoryContext}\n</Category_Context>\n\n`;
        }

        if (isFastModel(roleFirstModel)) {
          p += `<Caller_Warning>\n${buildCallerWarning(roleFirstModel)}\n</Caller_Warning>\n\n`;
        }

        p += `## 1. TASK / OBJECTIVE\n${task}\n\n`;

        if (expectedOutcome) {
          p += `## 2. EXPECTED OUTCOME\n${expectedOutcome}\n\n`;
        }

        if (reqTools && reqTools.length > 0) {
          p += `## 3. REQUIRED TOOLS (WHITELIST)\n`;
          for (const t of reqTools) {
            p += `- ${t}\n`;
          }
          p += "\n";
        }

        if (mustDo && mustDo.length > 0) {
          p += `## 4. MUST DO (MANDATORY REQUIREMENTS)\n`;
          for (const m of mustDo) {
            p += `- ${m}\n`;
          }
          p += "\n";
        }

        if (mustNotDo && mustNotDo.length > 0) {
          p += `## 5. MUST NOT DO (FORBIDDEN ACTIONS)\n`;
          for (const f of mustNotDo) {
            p += `- ${f}\n`;
          }
          p += "\n";
        }

        if (context) {
          p += `## 6. CONTEXT & BACKGROUND\n${context}\n\n`;
        }

        if (roleDef.focus && roleDef.focus.length > 0) {
          p += `## ROLE FOCUS AREAS\n`;
          for (const f of roleDef.focus) {
            p += `- ${f}\n`;
          }
          p += "\n";
        }

        if (loadMemories.length > 0) {
          p += `## AGENT MEMORY RECALL DIRECTIVE — MANDATORY, NEVER SKIP\n`;
          p += `You MUST query \`agentmemory\` NOW, before doing any other work, using \`memory_recall\` and/or \`memory_smart_search\`, for every concept below:\n`;
          for (const m of loadMemories) {
            p += `- Query Concept/ID: "${m}"\n`;
          }
          p += `Incorporate recalled architectural context and established conventions into your work.\n`;
          p += `If the agentmemory tools are unavailable or return zero results, you MUST explicitly state "MEMORY RECALL: 0 results" in your final answer. Silently skipping this step is a protocol violation.\n\n`;
        }

        if (saveMemory) {
          p += `## AGENT MEMORY PERSISTENCE DIRECTIVE — MANDATORY, NEVER SKIP\n`;
          p += `Before emitting your final answer, you MUST call \`memory_save\` (or \`memory_lesson_save\`) with the fields below. Skipping this step counts as an incomplete task. If the agentmemory tools are unavailable, you MUST explicitly state "MEMORY SAVE: unavailable" in your final answer.\n`;
          if (typeof saveMemory === "object" && saveMemory !== null && !Array.isArray(saveMemory)) {
            const sm = saveMemory as Record<string, any>;
            if (sm.type) p += `- Type: ${sm.type}\n`;
            if (sm.concepts && Array.isArray(sm.concepts) && sm.concepts.length > 0) {
              p += `- Concepts: ${sm.concepts.join(", ")}\n`;
            }
            if (sm.project) p += `- Project: ${sm.project}\n`;
            if (sm.summary) p += `- Summary: ${sm.summary}\n`;
          } else if (typeof saveMemory === "string") {
            p += `- Guidance: ${saveMemory}\n`;
          } else {
            p += `- Persist a concise summary of architectural changes, patterns, or bug fixes.\n`;
          }
          p += `\n`;
        }

        const availableSkills = listAvailableSkills(
          cwd,
          requestedSkills.map((s) => String(s)),
        );
        if (availableSkills.length > 0) {
          p += `## AVAILABLE SKILLS\n`;
          p += `If one of these matches this task, pass its name via the skills parameter of your next delegate/follow_up call to inject the full protocol:\n`;
          for (const s of availableSkills) {
            p += `- ${s.name}${s.description ? ` — ${s.description}` : ""}\n`;
          }
          p += `\n`;
        }

        if (requestedSkills.length > 0) {
          p += `## INJECTED SKILL PROTOCOLS\n`;
          for (const sk of requestedSkills) {
            const content = resolveSkillContent(sk, cwd);
            if (content) {
              p += `\n### [SKILL: ${sk.toUpperCase()}]\n${content}\n`;
            } else {
              p += `\n### [SKILL: ${sk.toUpperCase()}]\n(Skill '${sk}' requested — apply its standard conventions)\n`;
            }
          }
          p += "\n";
        }

        p += `## EXECUTION PROTOCOL & DELIVERABLES\n`;
        p += `- Direct Action: Use file editing and shell tools directly to perform all work.\n`;
        p += `- No Placeholders: Write complete, functional code without TODOs or stubbed logic.\n`;
        p += `- Quality Verification: Run the relevant build or test commands to ensure clean execution.\n`;
        p += `- Deliverables: Provide a structured summary of completed work with exact file:line citations.\n\n`;

        p += `## EXECUTION DISCIPLINE — MANDATORY\n`;
        p += `- Execute directly: do the work yourself with file/shell tools. Do NOT delegate to another agent, do NOT return a plan-only response, and do NOT ask clarifying questions when the task is executable now.\n`;
        p += `- Verify, don't assume: after any change, run the relevant build/test/lint command and report the actual result — not an expectation.\n`;
        p += `- Anti-optimism checkpoint: before declaring completion, re-read the MUST DO list and confirm each item is genuinely satisfied with evidence (file:line, command output). If any item is unverified, say so explicitly.\n`;
        p += `- Scope discipline: touch only what the task requires. Do not refactor unrelated code, add speculative abstractions, or expand scope unprompted.\n\n`;
        p += OUTPUT_RULES;
        return p;
      }

      // Raw prompt passthrough
      return task;
    },
  },
];
