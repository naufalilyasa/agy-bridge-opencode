import { describe, it, expect } from "vitest";
import { sanitizeProgress, detectExecutionEcho, CooldownRegistry } from "../src/quota.js";
import { runAgy, type ChildHandle, type RunnerDeps } from "../src/runner.js";
import { TOOLS } from "../src/tools.js";
import { createToolHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  idleTimeoutSec: 90,
  roleModels: {},
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
  toolModels: {},
};

function fakeRunnerDeps(stdout: string) {
  const child: ChildHandle = {
    stdout: () => stdout,
    stderr: () => "",
    wait: () => Promise.resolve({ code: 0 }),
    kill: () => {},
  };
  const deps: RunnerDeps = {
    spawnChild: () => child,
    readRoleFile: async () => "",
    writeRoleFile: async () => {},
    readLog: async () => "",
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ "/x/ag1s": "sess-ag1s" }),
    makeLogPath: () => "/tmp/test.log",
  };
  return deps;
}

describe("WS-D ergonomics and project auto-injection", () => {
  it("(a) 3 progress lines + a real report → 0 progress lines, report intact", () => {
    const raw =
      "Waiting for background task to complete... (5s elapsed)\n" +
      "Waiting for subagent notification…\n" +
      "Waiting on task to finished...\n" +
      "# Final Report\n" +
      "Everything completed successfully.";

    const sanitized = sanitizeProgress(raw);
    expect(sanitized).toBe("# Final Report\nEverything completed successfully.");
    expect(sanitized).not.toMatch(/waiting (?:for|on)/i);
  });

  it("(b) all-progress stdout → output NOT emptied", () => {
    const raw =
      "Waiting for background task to complete...\n" +
      "Waiting for subagent notification... (10s elapsed)";

    const sanitized = sanitizeProgress(raw);
    expect(sanitized).toBe(raw);
    expect(sanitized.length).toBeGreaterThan(0);
  });

  it("(c) trailer contains out: counting SANITIZED length, and model: still present", async () => {
    const progressAndReport =
      "Waiting for background task to complete...\n" +
      "Waiting on task to finished...\n" +
      "Real report."; // 12 chars sanitized
    const deps = fakeRunnerDeps(progressAndReport);
    const tool = TOOLS.find((t) => t.name === "analyze_files")!;
    const handler = createToolHandler(
      tool,
      cfg,
      new ModelRegistry(async () => "gemini-3.7-flash-high\nclaude-sonnet-4-6\n"),
      deps,
      new CooldownRegistry(),
    );

    const res = await handler({ files: ["a.ts"], question: "analyze", cwd: "/x/ag1s" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("model: gemini-3.7-flash-high");
    expect(text).toContain("out: 12 chars");
    expect(text).toContain("session: sess-ag1s (use follow_up to continue)");
  });

  it("(d) progress-then-error stdout → detectExecutionEcho still returns true", async () => {
    const progressThenError =
      "Waiting for background task to complete...\n" +
      "Error ID: abc-12345\n" +
      "Agent execution terminated due to error";

    const sanitized = sanitizeProgress(progressThenError);
    expect(detectExecutionEcho(sanitized)).toBe(true);

    const deps = fakeRunnerDeps(progressThenError);
    const tool = TOOLS.find((t) => t.name === "analyze_files")!;
    const handler = createToolHandler(
      tool,
      cfg,
      new ModelRegistry(async () => "gemini-3.7-flash-high\n"),
      deps,
      new CooldownRegistry(),
    );

    const res = await handler({ files: ["a.ts"], question: "analyze", cwd: "/x/ag1s" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[agy-bridge execution error detected]");
  });

  it("(e) delegating with cwd=/x/ag1s and a save_memory lacking project → prompt contains Project: ag1s in BOTH delegate and server protocol", async () => {
    const delegateTool = TOOLS.find((t) => t.name === "delegate")!;
    const pDelegate = delegateTool.buildPrompt(
      {
        role: "tester",
        task: "Verify endpoints",
        save_memory: {
          type: "quality",
          summary: "endpoint tests verified",
        },
      },
      "/x/ag1s",
    );

    expect(pDelegate).toContain("- Project: ag1s");

    let capturedPrompt = "";
    const deps = fakeRunnerDeps("done");
    deps.spawnChild = (_file, args) => {
      const pIdx = args.indexOf("-p");
      if (pIdx !== -1) {
        capturedPrompt = args[pIdx + 1];
      }
      return {
        stdout: () => "done",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
    };

    const handler = createToolHandler(
      delegateTool,
      cfg,
      new ModelRegistry(async () => "gemini-3.7-flash-high\n"),
      deps,
      new CooldownRegistry(),
    );

    await handler({
      role: "tester",
      task: "Verify endpoints",
      save_memory: {
        type: "quality",
        summary: "endpoint tests verified",
      },
      cwd: "/x/ag1s",
    });

    expect(capturedPrompt).toContain("- Project: ag1s");
    expect(capturedPrompt).toContain("## MEMORY PROTOCOL");
    expect(capturedPrompt).toMatch(/Project: ag1s/);
  });

  it("(f) explicit project preserved verbatim", () => {
    const delegateTool = TOOLS.find((t) => t.name === "delegate")!;
    const pDelegate = delegateTool.buildPrompt(
      {
        role: "tester",
        task: "Verify endpoints",
        save_memory: {
          type: "quality",
          project: "explicit-project-name",
          summary: "endpoint tests verified",
        },
      },
      "/x/ag1s",
    );

    expect(pDelegate).toContain("- Project: explicit-project-name");
    expect(pDelegate).not.toContain("- Project: ag1s");

    const followUpTool = TOOLS.find((t) => t.name === "follow_up")!;
    const pFollowUpExplicit = followUpTool.buildPrompt(
      {
        instruction: "Continue fixing",
        save_memory: {
          project: "explicit-project-name",
        },
      },
      "/x/ag1s",
    );
    expect(pFollowUpExplicit).toContain("- Project: explicit-project-name");
    expect(pFollowUpExplicit).not.toContain("- Project: ag1s");

    const pFollowUpDerived = followUpTool.buildPrompt(
      {
        instruction: "Continue fixing",
        save_memory: {
          summary: "summary without project",
        },
      },
      "/x/ag1s",
    );
    expect(pFollowUpDerived).toContain("- Project: ag1s");
  });
});
