import { describe, it, expect } from "vitest";
import { TOOLS, resolveFiles } from "../src/tools.js";

describe("TOOLS", () => {
  it("defines the eight tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "adversarial_review",
      "analyze_files",
      "deep_search",
      "delegate",
      "follow_up",
      "get_session_status",
      "list_sessions",
      "web_lookup",
    ]);
  });

  it("every tool except get_session_status and list_sessions has a non-empty model chain", () => {
    for (const t of TOOLS) {
      if (t.name === "get_session_status" || t.name === "list_sessions")
        expect(t.chain).toEqual([]);
      else expect(t.chain.length).toBeGreaterThan(0);
    }
  });

  it("every tool has a sane per-tool timeout", () => {
    for (const t of TOOLS) {
      expect(t.timeoutSec).toBeGreaterThan(0);
      expect(t.timeoutSec).toBeLessThanOrEqual(600);
    }
  });

  it("web_lookup fails fast (well under the old 20-minute default)", () => {
    expect(TOOLS.find((t) => t.name === "web_lookup")!.timeoutSec).toBeLessThanOrEqual(180);
  });
});

describe("resolveFiles", () => {
  it("resolves relative paths against cwd, keeps absolute", () => {
    expect(resolveFiles(["a.ts", "/abs/b.ts"], "/repo")).toEqual(["/repo/a.ts", "/abs/b.ts"]);
  });
});

describe("prompt templates", () => {
  const get = (name: string) => TOOLS.find((t) => t.name === name)!;

  it("analyze_files lists absolute paths and the question", () => {
    const p = get("analyze_files").buildPrompt(
      { files: ["x.log"], question: "find errors" },
      "/repo",
    );
    expect(p).toContain("/repo/x.log");
    expect(p).toContain("find errors");
    expect(p).toMatch(/file:line/);
  });

  it("adversarial_review accepts inline content", () => {
    const p = get("adversarial_review").buildPrompt(
      { content: "plan text", focus: "security" },
      "/repo",
    );
    expect(p).toContain("plan text");
    expect(p).toContain("security");
    expect(p).toMatch(/severity/i);
  });

  it("adversarial_review requires content or files", () => {
    expect(() => get("adversarial_review").buildPrompt({}, "/repo")).toThrow(/content.*files/i);
  });

  it("follow_up passes the question through verbatim", () => {
    expect(get("follow_up").buildPrompt({ question: "and then?" }, "/repo")).toBe("and then?");
  });

  it("delegate passes the prompt through verbatim when no role/context is provided", () => {
    expect(get("delegate").buildPrompt({ prompt: "do x" }, "/repo")).toBe("do x");
  });

  it("delegate generates structured OMO prompt when role and task are provided", () => {
    const p = get("delegate").buildPrompt(
      {
        role: "tester",
        task: "Write unit tests for ViewModelModule.kt",
        context: "Verify all ViewModel definitions are correctly bound in Koin",
        requirements: ["Must follow Clean Architecture", "Run gradlew test to verify"],
      },
      "/repo",
    );
    expect(p).toContain("[DELEGATED AGENT ROLE: QA_TEST_ENGINEER]");
    expect(p).toContain("Write unit tests for ViewModelModule.kt");
    expect(p).toContain("Verify all ViewModel definitions are correctly bound in Koin");
    expect(p).toContain("Must follow Clean Architecture");
    expect(p).toContain("Run gradlew test to verify");
    expect(p).toContain("EXECUTION PROTOCOL");
  });

  it("delegate injects OMO-native parity blocks (Category_Context, Caller_Warning for fast roles, EXECUTION DISCIPLINE)", () => {
    const pFast = get("delegate").buildPrompt(
      { role: "git-master", task: "Commit staged changes atomically" },
      "/repo",
    );
    expect(pFast).toContain("<Category_Context>");
    expect(pFast).toContain("<Caller_Warning>");
    expect(pFast).toContain("EXECUTION DISCIPLINE");
    expect(pFast).toContain("Execute directly");

    const pCritic = get("delegate").buildPrompt(
      { role: "oracle", task: "Critique the plan" },
      "/repo",
    );
    expect(pCritic).toContain("<Category_Context>");
    expect(pCritic).not.toContain("<Caller_Warning>");
    expect(pCritic).toContain("EXECUTION DISCIPLINE");
  });

  it("delegate supports visual-engineering role", () => {
    const p = get("delegate").buildPrompt(
      {
        role: "visual-engineering",
        task: "Review large Compose UI component for performance",
      },
      "/repo",
    );
    expect(p).toContain("[DELEGATED AGENT ROLE: OMO_VISUAL_ENGINEER]");
    expect(p).toContain("Review large Compose UI component for performance");
  });

  it("delegate supports exact OMO worker subagents like git-master, oracle, librarian, momus, metis", () => {
    const pGit = get("delegate").buildPrompt(
      {
        role: "git-master",
        task: "Create atomic conventional commits for task 18 and clean branch history",
      },
      "/repo",
    );
    expect(pGit).toContain("[DELEGATED AGENT ROLE: OMO_GIT_MASTER]");
    expect(pGit).toContain(
      "Create atomic conventional commits for task 18 and clean branch history",
    );

    const pOracle = get("delegate").buildPrompt(
      {
        role: "oracle",
        task: "Adversarial review on clean architecture decoupling",
      },
      "/repo",
    );
    expect(pOracle).toContain("[DELEGATED AGENT ROLE: OMO_ORACLE_ADVERSARIAL_CRITIC]");

    const pLib = get("delegate").buildPrompt(
      {
        role: "librarian",
        task: "Trace when DP 28 fault bitmask was introduced",
      },
      "/repo",
    );
    expect(pLib).toContain("[DELEGATED AGENT ROLE: OMO_LIBRARIAN_ARCHAEOLOGIST]");

    const pMomus = get("delegate").buildPrompt(
      {
        role: "momus",
        task: "Inspect git diff before merging task 18 branch",
      },
      "/repo",
    );
    expect(pMomus).toContain("[DELEGATED AGENT ROLE: OMO_MOMUS_VERIFIER]");
  });

  it("delegate supports specialized OMO subagents: ultrabrain, tester, sisyphus-junior, metis", () => {
    const pUltrabrain = get("delegate").buildPrompt(
      {
        role: "ultrabrain",
        task: "Deep architectural reasoning and heavy refactoring across modules",
      },
      "/repo",
    );
    expect(pUltrabrain).toContain("[DELEGATED AGENT ROLE: OMO_ULTRABRAIN_ARCHITECT]");

    const pJunior = get("delegate").buildPrompt(
      {
        role: "sisyphus-junior",
        task: "Execute targeted file updates and fixes",
      },
      "/repo",
    );
    expect(pJunior).toContain("[DELEGATED AGENT ROLE: OMO_SISYPHUS_JUNIOR]");

    const pMetis = get("delegate").buildPrompt(
      {
        role: "metis",
        task: "Multi-file dependency and call graph analysis",
      },
      "/repo",
    );
    expect(pMetis).toContain("[DELEGATED AGENT ROLE: OMO_METIS_MULTI_FILE_ANALYST]");

    const pTester = get("delegate").buildPrompt(
      {
        role: "tester",
        task: "Author unit tests covering edge cases",
      },
      "/repo",
    );
    expect(pTester).toContain("[DELEGATED AGENT ROLE: QA_TEST_ENGINEER]");
  });

  it("delegate renders full canonical 6-section prompt format", () => {
    const p = get("delegate").buildPrompt(
      {
        role: "tester",
        task: "Refactor AuthService token refresh mechanism",
        expected_outcome: "Clean token rotation, all unit tests passing, zero regression",
        required_tools: ["view_file", "replace_file_content", "run_command"],
        must_do: ["Preserve backward compatibility", "Run test suite before completing"],
        must_not_do: ["Never use `any` type casting", "Do not modify files outside auth/"],
        context: "Legacy token expiry is 3600s. See file auth/TokenManager.kt:45",
      },
      "/repo",
    );

    expect(p).toContain("[DELEGATED AGENT ROLE: QA_TEST_ENGINEER]");
    expect(p).toContain("## 1. TASK / OBJECTIVE\nRefactor AuthService token refresh mechanism");
    expect(p).toContain(
      "## 2. EXPECTED OUTCOME\nClean token rotation, all unit tests passing, zero regression",
    );
    expect(p).toContain(
      "## 3. REQUIRED TOOLS (WHITELIST)\n- view_file\n- replace_file_content\n- run_command",
    );
    expect(p).toContain(
      "## 4. MUST DO (MANDATORY REQUIREMENTS)\n- Preserve backward compatibility\n- Run test suite before completing",
    );
    expect(p).toContain(
      "## 5. MUST NOT DO (FORBIDDEN ACTIONS)\n- Never use `any` type casting\n- Do not modify files outside auth/",
    );
    expect(p).toContain(
      "## 6. CONTEXT & BACKGROUND\nLegacy token expiry is 3600s. See file auth/TokenManager.kt:45",
    );
  });

  it("delegate injects skill instructions into prompt when skills array or skill is specified", () => {
    const p = get("delegate").buildPrompt(
      {
        role: "git-master",
        task: "Stage, commit and push changes",
        skills: ["git-master"],
      },
      "/repo",
    );
    expect(p).toContain("[DELEGATED AGENT ROLE: OMO_GIT_MASTER]");
    expect(p).toContain("## INJECTED SKILL PROTOCOLS");
    expect(p).toContain("### [SKILL: GIT-MASTER]");
    expect(p).toContain("Atomic");
  });

  it("delegate renders agentmemory recall and persistence directives", () => {
    const p = get("delegate").buildPrompt(
      {
        role: "ultrabrain",
        task: "Implement RoomManagementRepositoryImpl",
        load_memories: ["tuya-dp-mapping", "clean-architecture-rules"],
        save_memory: {
          type: "architecture",
          concepts: ["room-management", "repository-pattern"],
          project: "reiwa-access",
          summary: "Documented Tuya Room Bean to domain Room model mapper structure",
        },
      },
      "/repo",
    );

    expect(p).toContain("## AGENT MEMORY RECALL DIRECTIVE");
    expect(p).toContain('- Query Concept/ID: "tuya-dp-mapping"');
    expect(p).toContain('- Query Concept/ID: "clean-architecture-rules"');

    expect(p).toContain("## AGENT MEMORY PERSISTENCE DIRECTIVE");
    expect(p).toContain("- Type: architecture");
    expect(p).toContain("- Concepts: room-management, repository-pattern");
    expect(p).toContain("- Project: reiwa-access");
    expect(p).toContain(
      "- Summary: Documented Tuya Room Bean to domain Room model mapper structure",
    );
  });

  it("follow_up supports instruction alias and context", () => {
    const p = get("follow_up").buildPrompt(
      {
        instruction: "Continue fixing test cases",
        context: "3 tests failed with exit code 1",
      },
      "/repo",
    );
    expect(p).toContain("Continue fixing test cases");
    expect(p).toContain("3 tests failed with exit code 1");
  });
});
