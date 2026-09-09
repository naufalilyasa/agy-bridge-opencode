import { describe, it, expect, vi } from "vitest";
import { createToolHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { OMO_ROLES, TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import type { Config } from "../src/config.js";
import { IdleStallError, type ChildHandle, type RunnerDeps } from "../src/runner.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  idleTimeoutSec: 90,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  toolModels: {},
  roleModels: {},
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const LISTING = "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngemini-3.8-flash-high\n";

const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

interface Run {
  args: string[];
}

/**
 * Fake runner deps: `quotaModels` lists models whose runs hit a 429 in the log;
 * everything else answers normally. Records every spawn's args.
 */
function fakeDeps(quotaModels: string[] = []) {
  const runs: Run[] = [];
  let currentQuota = false;
  let roleFile: Record<string, { sessionId: string; role: string }> = {};

  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      runs.push({ args });
      const i = args.indexOf("--model");
      currentQuota = i !== -1 && quotaModels.includes(args[i + 1]);
      const quota = currentQuota;
      const child: ChildHandle = {
        stdout: () => (quota ? "" : "the answer"),
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => (currentQuota ? LOG_429 : ""),
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
    readRoleFile: async () => JSON.stringify(roleFile),
    writeRoleFile: async (content: string) => {
      roleFile = JSON.parse(content) as Record<string, { sessionId: string; role: string }>;
    },
    makeLogPath: () => "/tmp/agy-bridge-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return {
    deps,
    runs,
    modelOf: (r: Run) => r.args[r.args.indexOf("--model") + 1],
    roleFileRef: () => roleFile,
    clearRoles: () => {
      roleFile = {};
    },
  };
}

function handlerFor(
  name: string,
  f: ReturnType<typeof fakeDeps>,
  overrides: Partial<Config> = {},
  cooldowns = new CooldownRegistry(),
) {
  return createToolHandler(
    TOOLS.find((t) => t.name === name)!,
    { ...cfg, ...overrides },
    new ModelRegistry(async () => LISTING),
    f.deps,
    cooldowns,
  );
}

describe("createToolHandler", () => {
  it("runs delegate and appends model + session footer", async () => {
    const f = fakeDeps();
    const res = await handlerFor("delegate", f)({ prompt: "do x" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("the answer");
    expect(text).toContain("gemini-3.7-flash-high");
    expect(text).toContain("sess-1");
    expect(f.runs[0].args).toContain("--model");
  });

  it("follow_up passes --conversation and resolves model chain", async () => {
    const f = fakeDeps();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "more?" });
    expect(f.runs[0].args).toContain("--conversation");
    expect(f.runs[0].args).toContain("abc");
    expect(f.runs[0].args).toContain("--model");
  });

  it("follow_up without role inherits the original delegate's role chain", async () => {
    const f = fakeDeps();
    await handlerFor(
      "delegate",
      f,
    )({
      task: "build it",
      role: "tester",
      expected_outcome: "tests pass",
    });
    const savedRole = f.roleFileRef()[path.resolve(process.cwd())]?.role;
    expect(savedRole).toBe("tester");

    await handlerFor("follow_up", f)({ session_id: "sess-1", question: "continue" });
    const chain = cfg.roleModels["tester"] ?? OMO_ROLES["tester"].chain;
    expect(chain[0]).toBeDefined();
    expect(f.modelOf(f.runs[1])).toBe(chain[0]);
  });

  it("follow_up with explicit role overrides the remembered one", async () => {
    const f = fakeDeps();
    f.clearRoles?.();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "go", role: "tester" });
    const chain = cfg.roleModels["tester"] ?? OMO_ROLES["tester"].chain;
    expect(f.modelOf(f.runs[0])).toBe(chain[0]);
  });

  it("follow_up without remembered role falls back to builtin chain (backward compat)", async () => {
    const f = fakeDeps();
    f.clearRoles?.();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "go" });
    expect(f.modelOf(f.runs[0])).toBe(TOOLS.find((t) => t.name === "follow_up")!.chain[0]);
  });

  it("uses the per-tool timeout for --print-timeout", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f)({ query: "docs" });
    const args = f.runs[0].args;
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe(`${tool.timeoutSec}s`);
  });

  it("explicit AGY_TIMEOUT overrides per-tool timeouts", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f, { timeoutSec: 900, timeoutExplicit: true })({ query: "q" });
    const args = f.runs[0].args;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("900s");
  });

  it("per-tool AGY_TIMEOUT_<TOOL> overrides only that tool", async () => {
    const f = fakeDeps();
    const cfg = { perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
    // a tool without an override keeps its default
    await handlerFor("web_lookup", f, cfg)({ query: "q" });
    const tool = TOOLS.find((t) => t.name === "web_lookup")!;
    expect(f.runs[1].args[f.runs[1].args.indexOf("--print-timeout") + 1]).toBe(
      `${tool.timeoutSec}s`,
    );
  });

  it("per-tool override wins over explicit global AGY_TIMEOUT", async () => {
    const f = fakeDeps();
    const cfg = { timeoutSec: 900, timeoutExplicit: true, perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
  });

  it("fails over to the next chain model on quota exhaustion", async () => {
    const f = fakeDeps(["gemini-3.7-flash-high"]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    const text = (res.content[0] as { text: string }).text;
    expect(res.isError).toBeUndefined();
    expect(f.runs).toHaveLength(2);
    expect(f.modelOf(f.runs[0])).toBe("gemini-3.7-flash-high");
    expect(f.modelOf(f.runs[1])).toBe("claude-sonnet-4-6");
    expect(text).toContain("the answer");
    expect(text).toContain("model: claude-sonnet-4-6");
    expect(text).toMatch(/failover.*gemini-3\.7-flash-high.*quota/i);
  });

  it("skips cooled-down models on subsequent calls without spawning them", async () => {
    const f = fakeDeps(["gemini-3.7-flash-high"]);
    const cooldowns = new CooldownRegistry();
    const handler = handlerFor("web_lookup", f, {}, cooldowns);
    await handler({ query: "first" });
    expect(f.runs).toHaveLength(2);
    await handler({ query: "second" });
    expect(f.runs).toHaveLength(3);
    expect(f.modelOf(f.runs[2])).toBe("claude-sonnet-4-6");
  });

  it("errors with reset times when every chain model is quota-exhausted", async () => {
    const f = fakeDeps(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
    const res = await handlerFor("web_lookup", f)({ query: "docs" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/quota/i);
    expect(text).toContain("gemini-3.7-flash-high");
    expect(text).toContain("claude-sonnet-4-6");
    expect(text).toContain("4h24m");
  });

  it("returns isError content on failure instead of throwing", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f)({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).not.toContain("Do NOT perform this work yourself");
  });

  it("strict mode appends do-not-fallback instruction to errors", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new Error("kaboom");
    };
    const res = await handlerFor("delegate", f, { onFailure: "strict" })({ prompt: "x" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("kaboom");
    expect(text).toContain("Do NOT perform this work yourself");
  });

  it("forwards the MCP abort signal to the runner", async () => {
    const f = fakeDeps();
    const ac = new AbortController();
    ac.abort();
    const res = await handlerFor("delegate", f)({ prompt: "x" }, { signal: ac.signal });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/cancelled/i);
  });

  it("selects Claude Sonnet first for deep reasoning role (oracle)", async () => {
    const f = fakeDeps();
    const handler = handlerFor("delegate", f);
    await handler({ role: "oracle", task: "Adversarial plan review" });
    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("claude-sonnet-4-6");
  });

  it("selects Gemini Flash first for fast execution role (git-master)", async () => {
    const f = fakeDeps();
    const handler = handlerFor("delegate", f);
    await handler({ role: "git-master", task: "Create atomic commit" });
    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("gemini-3.7-flash-high");
  });

  it("allows cfg.roleModels to override the default model chain for a role", async () => {
    const f = fakeDeps();
    const handler = handlerFor("delegate", f, {
      roleModels: { oracle: ["Gemini 3.7 Flash (High)"] },
    });
    await handler({ role: "oracle", task: "Adversarial plan review" });
    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("Gemini 3.7 Flash (High)");
  });

  it("attempts explicit model even when cooling in registry", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    cooldowns.set("gemini-3.8-flash-high", 9999);
    expect(cooldowns.cooling("gemini-3.8-flash-high")).toBe(true);

    const handler = handlerFor("delegate", f, {}, cooldowns);
    await handler({ prompt: "do work", model: "gemini-3.8-flash-high" });

    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("gemini-3.8-flash-high");
  });

  it("skips non-explicit models currently cooling", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    cooldowns.set("gemini-3.7-flash-high", 9999);

    const handler = handlerFor("web_lookup", f, {}, cooldowns);
    await handler({ query: "docs" });

    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("claude-sonnet-4-6");
  });

  it("includes actual model names dynamically in quota error message", async () => {
    const f = fakeDeps(["Claude Sonnet 4.6 (Thinking)"]);
    const handler = handlerFor("delegate", f, {
      roleModels: { custom: ["Claude Sonnet 4.6 (Thinking)"] },
    });
    const res = await handler({ prompt: "hi", role: "custom" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Candidate models (Claude Sonnet 4.6 (Thinking))");
    expect(text).not.toContain("Gemini 3.7 Flash & Claude Sonnet 4.6");
  });

  it("clears cooling models when CooldownRegistry.clear() is invoked", () => {
    const cooldowns = new CooldownRegistry();
    cooldowns.set("gemini-3.8-flash-high", 9999);
    expect(cooldowns.cooling("gemini-3.8-flash-high")).toBe(true);

    cooldowns.clear();
    expect(cooldowns.cooling("gemini-3.8-flash-high")).toBe(false);
  });

  it("cfg.toolModels overrides cfg.roleModels and builtin chain", async () => {
    const f = fakeDeps();
    // oracle role default is Claude Sonnet 4.6 (Thinking), but toolModels[delegate] specifies Gemini
    const handler = handlerFor("delegate", f, {
      roleModels: { oracle: ["Claude Sonnet 4.6 (Thinking)"] },
      toolModels: { delegate: ["Gemini 3.7 Flash (High)"] },
    });
    await handler({ role: "oracle", task: "Review architecture" });
    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("Gemini 3.7 Flash (High)");
  });

  it("explicit model overrides cfg.toolModels and bypasses cooldown", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    cooldowns.set("gemini-3.8-flash-high", 9999);

    const handler = handlerFor(
      "delegate",
      f,
      {
        toolModels: { delegate: ["Claude Sonnet 4.6 (Thinking)"] },
      },
      cooldowns,
    );
    // Explicit model overrides toolModels AND bypasses cooling status
    await handler({ prompt: "do work", model: "gemini-3.8-flash-high" });
    expect(f.runs).toHaveLength(1);
    expect(f.modelOf(f.runs[0])).toBe("gemini-3.8-flash-high");
  });

  it("returns ALL_MODELS_EXHAUSTED error with dynamic candidate list and wait quota instructions", async () => {
    const f = fakeDeps(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
    const handler = handlerFor("web_lookup", f);
    const res = await handler({ query: "docs" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("ALL_MODELS_EXHAUSTED");
    expect(text).toContain(
      "Candidate models (gemini-3.7-flash-high, claude-sonnet-4-6)",
    );
    expect(text).toMatch(/Retry after the quota resets, or pass an explicit `model`/i);
  });

  it("follow_up without explicit model restarts from beginning of chain rather than locking to session last used model", async () => {
    // delegate chain for tester: Gemini 3.7 Flash then Claude Sonnet 4.6
    // In first run, Gemini hits 429 quota, so delegate fails over to Claude Sonnet
    const quotaModels = ["Gemini 3.7 Flash (High)"];
    const f = fakeDeps(quotaModels);
    const cooldowns = new CooldownRegistry();
    const delegateHandler = handlerFor(
      "delegate",
      f,
      {
        roleModels: { tester: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"] },
      },
      cooldowns,
    );

    const res1 = await delegateHandler({ task: "run tests", role: "tester" });
    expect(res1.isError).toBeUndefined();
    expect(f.runs).toHaveLength(2);
    expect(f.modelOf(f.runs[0])).toBe("Gemini 3.7 Flash (High)"); // failed on quota
    expect(f.modelOf(f.runs[1])).toBe("Claude Sonnet 4.6 (Thinking)"); // succeeded on fallback

    // Quota resets: Gemini is working again and cooldown is cleared
    quotaModels.length = 0;
    cooldowns.clear();

    // Now call follow_up without explicit model
    const followUpHandler = handlerFor(
      "follow_up",
      f,
      {
        roleModels: { tester: ["Gemini 3.7 Flash (High)", "Claude Sonnet 4.6 (Thinking)"] },
      },
      cooldowns,
    );

    const res2 = await followUpHandler({ session_id: "sess-1", question: "continue" });
    expect(res2.isError).toBeUndefined();
    // follow_up must restart from the FIRST model in the chain (Gemini 3.7 Flash), not lock to Claude Sonnet
    expect(f.runs).toHaveLength(3);
    expect(f.modelOf(f.runs[2])).toBe("Gemini 3.7 Flash (High)");
  });

  it("follow_up respects cfg.toolModels[follow_up] over remembered role", async () => {
    const f = fakeDeps();
    // delegate saved role tester (Gemini)
    await handlerFor(
      "delegate",
      f,
    )({
      task: "build it",
      role: "tester",
      expected_outcome: "tests pass",
    });

    // follow_up has toolModels specifying Claude
    const followUpHandler = handlerFor("follow_up", f, {
      toolModels: { follow_up: ["Claude Sonnet 4.6 (Thinking)"] },
    });
    await followUpHandler({ session_id: "sess-1", question: "continue" });
    expect(f.modelOf(f.runs[1])).toBe("Claude Sonnet 4.6 (Thinking)");
  });

  it("get_session_status returns active session information when cwd is recorded", async () => {
    const f = fakeDeps();
    const handler = handlerFor("get_session_status", f);
    const res = await handler({ cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Active Session");
    expect(text).toContain("sess-1");
    expect(text).toContain("Ready for follow_up");
  });

  it("get_session_status returns no prior session message when cwd is not in session map", async () => {
    const f = fakeDeps();
    const handler = handlerFor("get_session_status", f);
    const res = await handler({ cwd: "/tmp/non-existent-session-dir" });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("No prior agy session recorded");
    expect(text).toContain("/tmp/non-existent-session-dir");
  });

  it("get_session_status handles unparseable session file gracefully", async () => {
    const f = fakeDeps();
    f.deps.readSessionsFile = async () => "corrupt json{";
    const handler = handlerFor("get_session_status", f);
    const res = await handler({ cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("No prior agy session recorded");
  });

  it("list_sessions returns no recorded sessions message when session map is empty", async () => {
    const f = fakeDeps();
    f.deps.readSessionsFile = async () => "{}";
    const handler = handlerFor("list_sessions", f);
    const res = await handler({});
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("No recorded Antigravity sessions found");
  });

  it("list_sessions formats session list with current project indicator and follow_up suggestion", async () => {
    const f = fakeDeps();
    f.deps.readSessionsFile = async () =>
      JSON.stringify({
        [process.cwd()]: "sess-current",
        "/other/project": "sess-other",
      });

    const handler = handlerFor("list_sessions", f);
    const res = await handler({ cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("### 📋 Antigravity Sessions List");
    expect(text).toContain("sess-current");
    expect(text).toContain("(CURRENT PROJECT)");
    expect(text).toContain("sess-other");
    expect(text).toContain('follow_up(session_id: "sess-current"');
  });

  it("list_sessions handles corrupted sessions file gracefully", async () => {
    const f = fakeDeps();
    f.deps.readSessionsFile = async () => "invalid json";
    const handler = handlerFor("list_sessions", f);
    const res = await handler({});
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("No recorded Antigravity sessions found");
  });

  it("detects agy execution error and returns autonomous recovery notice with isError", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      const child: ChildHandle = {
        stdout: () => "Error ID: 12345\nAgent execution terminated due to error",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    };

    const handler = handlerFor("delegate", f);
    const res = await handler({ prompt: "do work" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[agy-bridge execution error detected]");
    expect(text).toContain("AUTONOMOUS RECOVERY REQUIRED");
    expect(text).toContain("sess-1");
  });

  it("detects transient server errors (UNAVAILABLE 503 / overloaded) and returns isError with recovery notice", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      const child: ChildHandle = {
        stdout: () => "UNAVAILABLE (code 503): model is overloaded, experiencing high traffic",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    };

    const handler = handlerFor("delegate", f);
    const res = await handler({ prompt: "query" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[agy-bridge recovery notice]");
    expect(text).toContain("AUTONOMOUS ACTION");
    expect(text).toContain("sess-1");
  });

  it("handles IdleStallError in createToolHandler with stall recovery advice", async () => {
    const f = fakeDeps();
    f.deps.spawnChild = () => {
      throw new IdleStallError(
        "Gemini 3.7 Flash",
        90,
        "last activity log tail line",
        "/tmp/agy-bridge-test.log",
      );
    };

    const handler = handlerFor("delegate", f);
    const res = await handler({ prompt: "stalled task" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[agy-bridge stall detected]");
    expect(text).toContain("no log output for 90s");
    expect(text).toContain("last activity log tail line");
    expect(text).toContain("/tmp/agy-bridge-test.log");
    expect(text).toContain("AUTONOMOUS RECOVERY ACTION");
  });

  it("forwards progress notification to McpServer when progressToken is provided", async () => {
    const f = fakeDeps();
    const notificationMock = vi.fn().mockResolvedValue(undefined);
    const fakeServer = {
      server: {
        notification: notificationMock,
      },
    };

    const toolDef = TOOLS.find((t) => t.name === "delegate")!;
    const handler = createToolHandler(
      toolDef,
      cfg,
      new ModelRegistry(async () => LISTING),
      f.deps,
      new CooldownRegistry(),
      fakeServer as any,
    );

    // Provide onProgress trigger through fake runner
    f.deps.spawnChild = () => {
      const child: ChildHandle = {
        stdout: () => "done",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    };

    const res = await handler(
      { prompt: "progress test" },
      { _meta: { progressToken: "token-abc-123" } },
    );

    expect(res).toBeDefined();
    expect(res.isError).toBeUndefined();
  });
});
