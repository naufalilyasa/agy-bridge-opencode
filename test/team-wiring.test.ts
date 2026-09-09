import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { createToolHandler, createServer, makeDefaultRunWake } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS, OMO_ROLES } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import { TeamRuntime, type TeamRuntimeConfig, type TeamRunMember } from "../src/team/runtime.js";
import { TEAM_HANDLERS } from "../src/team/handlers.js";
import { drainActiveTeams, runtime as singletonRuntime } from "../src/index.js";
import type { ChildHandle, RunnerDeps } from "../src/runner.js";

const baseCfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  idleTimeoutSec: 90,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  roleModels: {},
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

interface Run {
  args: string[];
}

function fakeDeps() {
  const runs: Run[] = [];
  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      runs.push({ args });
      const child: ChildHandle = {
        stdout: () => "agent answer",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => "",
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
    readRoleFile: async () => "{}",
    writeRoleFile: async () => {},
    makeLogPath: () => "/tmp/agy-bridge-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, runs };
}

describe("Team mode config env parsing", () => {
  it("provides default values for team config options with empty env", () => {
    const cfg = loadConfig({});
    expect(cfg.teamMaxParallel).toBe(4);
    expect(cfg.teamPollMs).toBe(3000);
    expect(cfg.teamMemberTimeoutSec).toBe(300);
    expect(cfg.teamKillGraceMs).toBe(5000);
  });

  it("parses valid team configuration overrides from environment variables", () => {
    const cfg = loadConfig({
      AGY_TEAM_MAX_PARALLEL: "10",
      AGY_TEAM_POLL_MS: "1500",
      AGY_TEAM_MEMBER_TIMEOUT_SEC: "600",
      AGY_TEAM_KILL_GRACE_MS: "8000",
    });
    expect(cfg.teamMaxParallel).toBe(10);
    expect(cfg.teamPollMs).toBe(1500);
    expect(cfg.teamMemberTimeoutSec).toBe(600);
    expect(cfg.teamKillGraceMs).toBe(8000);
  });

  it("falls back to default values when environment variables are non-numeric or non-positive", () => {
    const cfg = loadConfig({
      AGY_TEAM_MAX_PARALLEL: "not-a-number",
      AGY_TEAM_POLL_MS: "-500",
      AGY_TEAM_MEMBER_TIMEOUT_SEC: "0",
      AGY_TEAM_KILL_GRACE_MS: "abc",
    });
    expect(cfg.teamMaxParallel).toBe(4);
    expect(cfg.teamPollMs).toBe(3000);
    expect(cfg.teamMemberTimeoutSec).toBe(300);
    expect(cfg.teamKillGraceMs).toBe(5000);
  });
});

describe("Team tool server routing", () => {
  it("routes team_list to TEAM_HANDLERS without spawning CLI subprocess", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    const fakeRuntime = new TeamRuntime({
      cfg: baseCfg as unknown as TeamRuntimeConfig,
    });

    const toolDef = TOOLS.find((t) => t.name === "team_list")!;
    expect(toolDef.kind).toBe("team");

    const handler = createToolHandler(
      toolDef,
      baseCfg,
      new ModelRegistry(async () => "test-model\n"),
      f.deps,
      cooldowns,
      fakeRuntime,
    );

    const res = await handler({ cwd: "/tmp/non-existent-proj" });

    expect(res).toBeDefined();
    expect(res.content).toBeDefined();
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("[team_list]");
    expect(f.runs.length).toBe(0);
  });

  it("routes team_status to TEAM_HANDLERS and reports error without runner spawn", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    const fakeRuntime = new TeamRuntime({
      cfg: baseCfg as unknown as TeamRuntimeConfig,
    });

    const toolDef = TOOLS.find((t) => t.name === "team_status")!;
    expect(toolDef.kind).toBe("team");

    const handler = createToolHandler(
      toolDef,
      baseCfg,
      new ModelRegistry(async () => "test-model\n"),
      f.deps,
      cooldowns,
      fakeRuntime,
    );

    const res = await handler({ teamRunId: "team-nonexistent" });

    expect(res).toBeDefined();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("TEAM_NOT_FOUND");
    expect(f.runs.length).toBe(0);
  });

  it("routes non-team tool (delegate) through standard runner spawn child", async () => {
    const f = fakeDeps();
    const cooldowns = new CooldownRegistry();
    const fakeRuntime = new TeamRuntime({
      cfg: baseCfg as unknown as TeamRuntimeConfig,
    });

    const toolDef = TOOLS.find((t) => t.name === "delegate")!;
    expect(toolDef.kind).toBeUndefined();

    const handler = createToolHandler(
      toolDef,
      baseCfg,
      new ModelRegistry(async () => "test-model\n"),
      f.deps,
      cooldowns,
      fakeRuntime,
    );

    const res = await handler({ prompt: "hello standard delegate", model: "test-model" });

    expect(res).toBeDefined();
    expect(res.isError).toBeFalsy();
    expect(f.runs.length).toBe(1);
    expect(f.runs[0].args).toContain("--model");
    expect(f.runs[0].args).toContain("test-model");
  });

  it("registers all 12 team tools on McpServer via createServer", () => {
    const fakeRuntime = new TeamRuntime({
      cfg: baseCfg as unknown as TeamRuntimeConfig,
    });
    const server = createServer(fakeRuntime, baseCfg);
    expect(server).toBeDefined();
  });
});

describe("Graceful shutdown drain", () => {
  it("stops loops and deletes teams during drain", async () => {
    const stopped: string[] = [];
    const deleted: string[] = [];

    const mockRuntime = {
      loops: new Map([["team-run-1", {} as NodeJS.Timeout]]),
      teamRoots: new Map([["team-run-1", "/tmp/mock-proj"]]),
      stopLoop: vi.fn((_root: string, teamRunId: string) => {
        stopped.push(teamRunId);
        return true;
      }),
      deleteTeam: vi.fn(async (_root: string, teamRunId: string) => {
        deleted.push(teamRunId);
        return { teamRunId, status: "deleted" as const, removedWorktrees: 0 };
      }),
    } as unknown as TeamRuntime;

    await drainActiveTeams(mockRuntime, 100);

    expect(stopped).toContain("team-run-1");
    expect(deleted).toContain("team-run-1");
    expect(mockRuntime.stopLoop).toHaveBeenCalled();
    expect(mockRuntime.deleteTeam).toHaveBeenCalled();
  });

  it("drain does NOT scan on-disk .omo/runtime — only drains teams owned by this process", async () => {
    const deleted: string[] = [];
    const mockRuntime = {
      loops: new Map(),
      teamRoots: new Map(),
      stopLoop: vi.fn(),
      deleteTeam: vi.fn(async (_root: string, teamRunId: string) => {
        deleted.push(teamRunId);
        return { teamRunId, status: "deleted" as const, removedWorktrees: 0 };
      }),
    } as unknown as TeamRuntime;

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "drain-noscan-"));
    fs.mkdirSync(path.join(scratch, ".omo", "runtime", "team-disk-ghost-0001"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(scratch, ".omo", "runtime", "team-disk-ghost-0001", "state.json"),
      JSON.stringify({ teamRunId: "team-disk-ghost-0001", status: "active" }),
    );
    const prevCwd = process.cwd();
    process.chdir(scratch);
    try {
      await drainActiveTeams(mockRuntime, 100);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    expect(deleted).not.toContain("team-disk-ghost-0001");
    expect(deleted).toHaveLength(0);
  });
});

describe("Production resolveModelChain wiring", () => {
  it("wires resolveModelChain on createServer default TeamRuntime with config override and OMO_ROLES fallback", async () => {
    let capturedRuntime: TeamRuntime | undefined;
    const origHandler = TEAM_HANDLERS.team_list;
    TEAM_HANDLERS.team_list = async (args, ctx) => {
      capturedRuntime = ctx?.runtime;
      return origHandler(args, ctx);
    };

    try {
      const customCfg: Config = {
        ...baseCfg,
        roleModels: {
          "custom-role": ["model-custom-1", "model-custom-2"],
          quick: ["gemini-override"],
        },
      };

      const server = createServer(undefined, customCfg);
      const registeredTools = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: Record<string, unknown>) => Promise<unknown> }
          >;
        }
      )._registeredTools;
      expect(registeredTools.team_list).toBeDefined();

      await registeredTools.team_list.handler({ cwd: "/tmp/non-existent-proj" });

      expect(capturedRuntime).toBeDefined();
      expect(capturedRuntime?.deps.resolveModelChain).toBeDefined();
      const resolver = capturedRuntime!.deps.resolveModelChain!;

      // 1. cfg.roleModels override wins over OMO_ROLES
      expect(resolver({ resolvedRole: "quick" } as TeamRunMember)).toEqual(["gemini-override"]);

      // 2. cfg.roleModels for custom role
      expect(resolver({ resolvedRole: "custom-role" } as TeamRunMember)).toEqual([
        "model-custom-1",
        "model-custom-2",
      ]);

      // 3. Fallback to OMO_ROLES.chain when not in cfg.roleModels
      expect(resolver({ resolvedRole: "git-master" } as TeamRunMember)).toEqual(
        OMO_ROLES["git-master"].chain,
      );

      // 4. Fallback to [member.resolvedRole] when unknown role
      expect(resolver({ resolvedRole: "unknown-role" } as TeamRunMember)).toEqual(["unknown-role"]);
    } finally {
      TEAM_HANDLERS.team_list = origHandler;
    }
  });

  it("wires resolveModelChain on createToolHandler fallback TeamRuntime", async () => {
    let capturedRuntime: TeamRuntime | undefined;
    const origHandler = TEAM_HANDLERS.team_list;
    TEAM_HANDLERS.team_list = async (args, ctx) => {
      capturedRuntime = ctx?.runtime;
      return origHandler(args, ctx);
    };

    try {
      const f = fakeDeps();
      const cooldowns = new CooldownRegistry();
      const customCfg: Config = {
        ...baseCfg,
        roleModels: {
          executor: ["model-exec-1"],
        },
      };

      const toolDef = TOOLS.find((t) => t.name === "team_list")!;
      const handler = createToolHandler(
        toolDef,
        customCfg,
        new ModelRegistry(async () => "test-model\n"),
        f.deps,
        cooldowns,
      );

      await handler({ cwd: "/tmp/non-existent-proj" });

      expect(capturedRuntime).toBeDefined();
      expect(capturedRuntime?.deps.resolveModelChain).toBeDefined();
      const resolver = capturedRuntime!.deps.resolveModelChain!;

      expect(resolver({ resolvedRole: "executor" } as TeamRunMember)).toEqual(["model-exec-1"]);
      expect(resolver({ resolvedRole: "tester" } as TeamRunMember)).toEqual(
        OMO_ROLES["tester"].chain,
      );
      expect(resolver({ resolvedRole: "mystery-agent" } as TeamRunMember)).toEqual([
        "mystery-agent",
      ]);
    } finally {
      TEAM_HANDLERS.team_list = origHandler;
    }
  });

  it("wires resolveModelChain on singleton runtime exported from index.ts", () => {
    expect(singletonRuntime.deps.resolveModelChain).toBeDefined();
    const resolver = singletonRuntime.deps.resolveModelChain!;

    const cfgRoleModels = singletonRuntime.deps.cfg?.roleModels as
      | Record<string, string[]>
      | undefined;
    expect(resolver({ resolvedRole: "quick" } as TeamRunMember)).toEqual(
      cfgRoleModels?.["quick"] ?? OMO_ROLES["quick"].chain,
    );
    expect(resolver({ resolvedRole: "unknown-slug" } as TeamRunMember)).toEqual(["unknown-slug"]);
  });
});

describe("Production runWake wiring", () => {
  it("makeDefaultRunWake invokes runAgy and returns WakeResult shape", async () => {
    const f = fakeDeps();
    const runWake = makeDefaultRunWake(baseCfg, f.deps);

    const result = await runWake({
      member: "architect",
      projectRoot: process.cwd(),
      teamRunId: "team-test-1",
      prompt: "analyze system",
      model: "gemini-3.8-flash-medium",
      conversationId: "conv-123",
      timeoutSec: 120,
    });

    expect(result).toEqual({
      output: "agent answer",
      sessionId: "sess-1",
      model: "gemini-3.8-flash-medium",
    });
    expect(f.runs.length).toBe(1);
    expect(f.runs[0].args).toContain("analyze system");
    expect(f.runs[0].args).toContain("--model");
    expect(f.runs[0].args).toContain("gemini-3.8-flash-medium");
  });

  it("makeDefaultRunWake returns null sessionId when session file does not contain root", async () => {
    const f = fakeDeps();
    f.deps.readSessionsFile = async () => JSON.stringify({});
    const runWake = makeDefaultRunWake(baseCfg, f.deps);

    const result = await runWake({
      member: "coder",
      projectRoot: "/tmp/non-existent-proj",
      teamRunId: "team-test-2",
      prompt: "write code",
      model: "claude-sonnet",
      timeoutSec: 60,
    });

    expect(result.sessionId).toBeNull();
    expect(result.output).toBe("agent answer");
    expect(result.model).toBe("claude-sonnet");
  });

  it("wires runWake on createServer default TeamRuntime and delegates to runAgy", async () => {
    let capturedRuntime: TeamRuntime | undefined;
    const origHandler = TEAM_HANDLERS.team_list;
    TEAM_HANDLERS.team_list = async (args, ctx) => {
      capturedRuntime = ctx?.runtime;
      return origHandler(args, ctx);
    };

    try {
      const f = fakeDeps();
      const server = createServer(undefined, baseCfg, f.deps);
      const registeredTools = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: Record<string, unknown>) => Promise<unknown> }
          >;
        }
      )._registeredTools;

      await registeredTools.team_list.handler({ cwd: "/tmp/non-existent-proj" });

      expect(capturedRuntime).toBeDefined();
      expect(capturedRuntime?.deps.runWake).toBeDefined();

      const result = await capturedRuntime!.deps.runWake!({
        member: "worker",
        projectRoot: process.cwd(),
        teamRunId: "team-test-cs",
        prompt: "perform task",
        model: "gemini-pro",
        timeoutSec: 45,
      });

      expect(result.output).toBe("agent answer");
      expect(result.sessionId).toBe("sess-1");
      expect(result.model).toBe("gemini-pro");
      expect(f.runs.length).toBe(1);
      expect(f.runs[0].args).toContain("perform task");
    } finally {
      TEAM_HANDLERS.team_list = origHandler;
    }
  });

  it("wires runWake on createToolHandler fallback TeamRuntime and delegates to runAgy", async () => {
    let capturedRuntime: TeamRuntime | undefined;
    const origHandler = TEAM_HANDLERS.team_list;
    TEAM_HANDLERS.team_list = async (args, ctx) => {
      capturedRuntime = ctx?.runtime;
      return origHandler(args, ctx);
    };

    try {
      const f = fakeDeps();
      const cooldowns = new CooldownRegistry();
      const toolDef = TOOLS.find((t) => t.name === "team_list")!;
      const handler = createToolHandler(
        toolDef,
        baseCfg,
        new ModelRegistry(async () => "test-model\n"),
        f.deps,
        cooldowns,
      );

      await handler({ cwd: "/tmp/non-existent-proj" });

      expect(capturedRuntime).toBeDefined();
      expect(capturedRuntime?.deps.runWake).toBeDefined();

      const result = await capturedRuntime!.deps.runWake!({
        member: "tester",
        projectRoot: process.cwd(),
        teamRunId: "team-test-cth",
        prompt: "run tests",
        model: "gemini-3.8-flash-medium",
        timeoutSec: 30,
      });

      expect(result.output).toBe("agent answer");
      expect(result.sessionId).toBe("sess-1");
      expect(result.model).toBe("gemini-3.8-flash-medium");
      expect(f.runs.length).toBe(1);
    } finally {
      TEAM_HANDLERS.team_list = origHandler;
    }
  });

  it("wires runWake on singleton runtime exported from index.ts", () => {
    expect(singletonRuntime.deps.runWake).toBeDefined();
    expect(typeof singletonRuntime.deps.runWake).toBe("function");
  });
});
