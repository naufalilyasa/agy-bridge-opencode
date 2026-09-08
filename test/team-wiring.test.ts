import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { createToolHandler, createServer } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import { TeamRuntime, type TeamRuntimeConfig } from "../src/team/runtime.js";
import { drainActiveTeams } from "../src/index.js";
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
});
