import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync, { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  TeamRuntime,
  validateTransition,
  isValidMemberTransition,
  generateTeamRunId,
  getTeamState,
  loadTeamState,
  updateTeamState,
  resolveMemberWorktree,
  slugifyMemberName,
  spawnWorktree,
  removeWorktrees,
  ALLOWED_MEMBER_TRANSITIONS,
  type MemberStatus,
  type TeamRuntimeDeps,
  type WakeOptions,
  type WakeResult,
  type WakeMemberResult,
  type TeamSemaphore,
  type TeamRunMember,
} from "../src/team/runtime.js";
import { TeamError, type TeamSpec } from "../src/team/spec.js";
import { QuotaError } from "../src/quota.js";
import { runDir, readJson } from "../src/team/store.js";

describe("src/team/runtime T6: TeamRuntime createTeam + member state machine", () => {
  let testDir: string;

  function createTestRuntime(deps: TeamRuntimeDeps = {}): TeamRuntime {
    return new TeamRuntime({
      spawnWorktree: async (projectRoot, teamRunId, member) => {
        const wt = resolveMemberWorktree(teamRunId, member);
        return {
          worktreePath: wt,
          cwd: wt,
          sessionCwd: path.resolve(projectRoot),
        };
      },
      removeWorktrees: async () => {},
      ...deps,
    });
  }

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-runtime-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const validSingleSpec: TeamSpec = {
    version: 1,
    name: "solo-team",
    leadAgentId: "lead",
    backendType: "cli",
    members: [
      {
        name: "lead",
        kind: "subagent_type",
        subagent_type: "deep",
        backendType: "cli",
      },
    ],
  };

  const validMultiSpec: TeamSpec = {
    version: 1,
    name: "dev-team",
    leadAgentId: "planner",
    backendType: "cli",
    members: [
      {
        name: "planner",
        kind: "subagent_type",
        subagent_type: "sisyphus", // alias to deep
        backendType: "cli",
      },
      {
        name: "worker",
        kind: "category",
        category: "visual-engineering",
        backendType: "cli",
      },
      {
        name: "reviewer",
        kind: "subagent_type",
        subagent_type: "atlas", // alias to ultrabrain
        backendType: "cli",
      },
    ],
  };

  describe("member state machine matrix & validateTransition", () => {
    const allStatuses: MemberStatus[] = [
      "idle",
      "running",
      "awaiting_shutdown",
      "removed",
    ];

    const legalTransitions: Array<[MemberStatus, MemberStatus]> = [
      ["idle", "running"],
      ["idle", "awaiting_shutdown"],
      ["running", "idle"],
      ["running", "awaiting_shutdown"],
      ["awaiting_shutdown", "removed"],
      ["awaiting_shutdown", "idle"],
    ];

    it("verifies all legal transitions return true from validateTransition", () => {
      for (const [from, to] of legalTransitions) {
        expect(isValidMemberTransition(from, to)).toBe(true);
        expect(validateTransition(from, to)).toBe(true);
      }
    });

    it("verifies all illegal transitions throw TeamError with code INVALID_MEMBER_TRANSITION", () => {
      const legalSet = new Set(
        legalTransitions.map(([from, to]) => `${from}->${to}`),
      );

      for (const from of allStatuses) {
        for (const to of allStatuses) {
          if (!legalSet.has(`${from}->${to}`)) {
            expect(isValidMemberTransition(from, to)).toBe(false);
            expect(() => validateTransition(from, to)).toThrow(TeamError);
            try {
              validateTransition(from, to);
            } catch (err: unknown) {
              const teamErr = err as TeamError;
              expect(teamErr.field).toBe("status");
              expect(teamErr.code).toBe("INVALID_MEMBER_TRANSITION");
            }
          }
        }
      }
    });

    it("verifies removed members cannot transition to any state (terminal state)", () => {
      for (const next of allStatuses) {
        expect(isValidMemberTransition("removed", next)).toBe(false);
        expect(() => validateTransition("removed", next)).toThrow(TeamError);
      }
      expect(ALLOWED_MEMBER_TRANSITIONS.removed.size).toBe(0);
    });
  });

  describe("teamRunId generation", () => {
    it("generates slug matching team-<ts>-<rand>", () => {
      const id1 = generateTeamRunId();
      const id2 = generateTeamRunId();

      expect(id1).toMatch(/^team-[a-z0-9]+-[a-f0-9]{6}$/);
      expect(id2).toMatch(/^team-[a-z0-9]+-[a-f0-9]{6}$/);
      expect(id1).not.toBe(id2);
    });

    it("generates unique teamRunId across multiple rapid calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(generateTeamRunId());
      }
      expect(ids.size).toBe(50);
    });
  });

  describe("createTeam", () => {
    it("returns immediately with status 'creating' and persists state.json with correct shape", async () => {
      const runtime = createTestRuntime();
      const startTime = Date.now();

      // createTeam(spec, projectRoot)
      const res = await runtime.createTeam(validMultiSpec, testDir);

      expect(res.status).toBe("creating");
      expect(res.teamRunId).toMatch(/^team-[a-z0-9]+-[a-f0-9]{6}$/);

      const targetRunDir = runDir(testDir, res.teamRunId);
      const stateFile = path.join(targetRunDir, "state.json");
      expect(existsSync(stateFile)).toBe(true);

      const state = await readJson<any>(stateFile);
      expect(state).not.toBeNull();
      expect(state.teamRunId).toBe(res.teamRunId);
      expect(state.projectRoot).toBe(testDir);
      expect(state.status).toBe("creating");
      expect(state.createdAt).toBeGreaterThanOrEqual(startTime);
      expect(state.spec.name).toBe("dev-team");

      // Verify members shape
      expect(state.members).toHaveLength(3);
      const [planner, worker, reviewer] = state.members;

      expect(planner).toEqual({
        name: "planner",
        kind: "subagent_type",
        resolvedRole: "deep", // alias sisyphus -> deep
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(targetRunDir, "transcript", "planner.jsonl"),
        worktreePath: resolveMemberWorktree(res.teamRunId, "planner"),
      });

      expect(worker).toEqual({
        name: "worker",
        kind: "category",
        resolvedRole: "visual-engineering",
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(targetRunDir, "transcript", "worker.jsonl"),
        worktreePath: resolveMemberWorktree(res.teamRunId, "worker"),
      });

      expect(reviewer).toEqual({
        name: "reviewer",
        kind: "subagent_type",
        resolvedRole: "ultrabrain", // alias atlas -> ultrabrain
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(targetRunDir, "transcript", "reviewer.jsonl"),
        worktreePath: resolveMemberWorktree(res.teamRunId, "reviewer"),
      });

      expect(res.worktrees).toEqual([
        resolveMemberWorktree(res.teamRunId, "planner"),
        resolveMemberWorktree(res.teamRunId, "worker"),
        resolveMemberWorktree(res.teamRunId, "reviewer"),
      ]);

      // Run directory structure verified
      expect(existsSync(path.join(targetRunDir, "inboxes", "planner"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "inboxes", "worker"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "inboxes", "reviewer"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "tasks"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "transcript"))).toBe(true);
    });

    it("supports inverted arguments createTeam(projectRoot, spec)", async () => {
      const runtime = createTestRuntime();
      const res = await runtime.createTeam(testDir, validSingleSpec);

      expect(res.status).toBe("creating");
      const state = await runtime.loadState(testDir, res.teamRunId);
      expect(state.teamRunId).toBe(res.teamRunId);
      expect(state.members).toHaveLength(1);
      expect(state.members[0].name).toBe("lead");
    });

    it("generates unique teamRunId across two sequential create calls", async () => {
      const runtime = createTestRuntime();
      const res1 = await runtime.createTeam(validSingleSpec, testDir);
      const res2 = await runtime.createTeam(validSingleSpec, testDir);

      expect(res1.teamRunId).not.toBe(res2.teamRunId);
      expect(res1.status).toBe("creating");
      expect(res2.status).toBe("creating");

      const state1 = await runtime.loadState(testDir, res1.teamRunId);
      const state2 = await runtime.loadState(testDir, res2.teamRunId);
      expect(state1.teamRunId).toBe(res1.teamRunId);
      expect(state2.teamRunId).toBe(res2.teamRunId);
    });

    it("rejects duplicate member names in spec with TeamError", async () => {
      const runtime = createTestRuntime();
      const duplicateSpec = {
        version: 1,
        name: "dup-team",
        leadAgentId: "worker",
        backendType: "cli",
        members: [
          { name: "worker", kind: "subagent_type", subagent_type: "deep" },
          { name: "worker", kind: "subagent_type", subagent_type: "quick" },
        ],
      };

      await expect(runtime.createTeam(duplicateSpec, testDir)).rejects.toThrow(
        TeamError,
      );
      try {
        await runtime.createTeam(duplicateSpec, testDir);
      } catch (err: unknown) {
        const teamErr = err as TeamError;
        expect(teamErr.field).toBe("members");
        expect(teamErr.code).toBe("DUPLICATE_MEMBER_NAME");
      }
    });

    it("rejects invalid spec using validateTeamSpec", async () => {
      const runtime = createTestRuntime();
      // missing leadAgentId on multi-member team
      const invalidSpec = {
        name: "invalid-team",
        backendType: "cli",
        members: [
          { name: "a", kind: "subagent_type", subagent_type: "deep" },
          { name: "b", kind: "subagent_type", subagent_type: "quick" },
        ],
      };

      await expect(runtime.createTeam(invalidSpec, testDir)).rejects.toThrow(
        TeamError,
      );
    });
  });

  describe("state persistence under locks (getState, loadState, updateState)", () => {
    it("loads state correctly and throws if teamRunId does not exist", async () => {
      const runtime = createTestRuntime();
      const res = await runtime.createTeam(validSingleSpec, testDir);

      const state = await runtime.loadState(testDir, res.teamRunId);
      expect(state.teamRunId).toBe(res.teamRunId);

      const missing = await runtime.getState(testDir, "team-non-existent");
      expect(missing).toBeNull();

      await expect(
        runtime.loadState(testDir, "team-non-existent"),
      ).rejects.toThrow(TeamError);
    });

    it("updates state atomically under lock", async () => {
      const runtime = createTestRuntime();
      const res = await runtime.createTeam(validSingleSpec, testDir);

      const updated = await runtime.updateState(
        testDir,
        res.teamRunId,
        (current) => {
          return {
            ...current,
            status: "active",
          };
        },
      );

      expect(updated.status).toBe("active");

      const reloaded = await runtime.loadState(testDir, res.teamRunId);
      expect(reloaded.status).toBe("active");
    });
  });

  describe("member shutdown lifecycle transitions", () => {
    it("handles requestShutdown -> approveShutdown -> removed cycle", async () => {
      const runtime = createTestRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      // 1. Initial status is idle
      let state = await runtime.loadState(testDir, teamRunId);
      expect(state.members.find((m) => m.name === "worker")?.status).toBe(
        "idle",
      );

      // 2. requestShutdown transitions idle -> awaiting_shutdown
      const reqRes = await runtime.requestShutdown(testDir, teamRunId, "worker");
      expect(reqRes.name).toBe("worker");
      expect(reqRes.status).toBe("awaiting_shutdown");

      state = await runtime.loadState(testDir, teamRunId);
      expect(state.members.find((m) => m.name === "worker")?.status).toBe(
        "awaiting_shutdown",
      );

      // 3. approveShutdown transitions awaiting_shutdown -> removed
      const appRes = await runtime.approveShutdown(testDir, teamRunId, "worker");
      expect(appRes.name).toBe("worker");
      expect(appRes.status).toBe("removed");

      state = await runtime.loadState(testDir, teamRunId);
      expect(state.members.find((m) => m.name === "worker")?.status).toBe(
        "removed",
      );

      // 4. removed member cannot be shut down or transitioned again
      await expect(
        runtime.requestShutdown(testDir, teamRunId, "worker"),
      ).rejects.toThrow(TeamError);
      await expect(
        runtime.approveShutdown(testDir, teamRunId, "worker"),
      ).rejects.toThrow(TeamError);
      await expect(
        runtime.rejectShutdown(testDir, teamRunId, "worker", "reason"),
      ).rejects.toThrow(TeamError);
    });

    it("handles requestShutdown -> rejectShutdown -> idle cycle", async () => {
      const runtime = createTestRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      // requestShutdown: idle -> awaiting_shutdown
      await runtime.requestShutdown(testDir, teamRunId, "worker");

      // rejectShutdown: awaiting_shutdown -> idle
      const rejRes = await runtime.rejectShutdown(
        testDir,
        teamRunId,
        "worker",
        "More work needed",
      );
      expect(rejRes.name).toBe("worker");
      expect(rejRes.status).toBe("idle");

      const state = await runtime.loadState(testDir, teamRunId);
      expect(state.members.find((m) => m.name === "worker")?.status).toBe(
        "idle",
      );
    });

    it("rejects direct approveShutdown on idle member without request", async () => {
      const runtime = createTestRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      // approveShutdown on idle member is illegal transition (idle -> removed is invalid)
      await expect(
        runtime.approveShutdown(testDir, teamRunId, "worker"),
      ).rejects.toThrow(TeamError);
    });

    it("rejects shutdown operations for non-existent member", async () => {
      const runtime = createTestRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      await expect(
        runtime.requestShutdown(testDir, teamRunId, "ghost"),
      ).rejects.toThrow(TeamError);
      await expect(
        runtime.approveShutdown(testDir, teamRunId, "ghost"),
      ).rejects.toThrow(TeamError);
      await expect(
        runtime.rejectShutdown(testDir, teamRunId, "ghost", "reason"),
      ).rejects.toThrow(TeamError);
    });

    it("allows transition from running to awaiting_shutdown mid-run", async () => {
      const runtime = createTestRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      // Manually set worker to running
      await runtime.updateState(testDir, teamRunId, (s) => {
        const m = s.members.find((x) => x.name === "worker");
        if (m) m.status = "running";
        return s;
      });

      // requestShutdown while running is legal: running -> awaiting_shutdown
      const res = await runtime.requestShutdown(testDir, teamRunId, "worker");
      expect(res.status).toBe("awaiting_shutdown");

      const state = await runtime.loadState(testDir, teamRunId);
      expect(state.members.find((m) => m.name === "worker")?.status).toBe(
        "awaiting_shutdown",
      );
    });
  });

  describe("deps and future seams stubs", () => {
    it("initializes with injected deps and throws 'not implemented' on future seams", async () => {
      const fakeCooldowns = {
        isCooled: () => false,
        set: () => {},
        get: () => null,
      };
      const runtime = new TeamRuntime({
        cooldowns: fakeCooldowns,
        cfg: { maxParallel: 4 },
      });

      expect(runtime.deps.cooldowns).toBe(fakeCooldowns);
      expect(runtime.deps.cfg?.maxParallel).toBe(4);

      // wakeMember is now implemented (T8) — without a valid team state it throws TEAM_NOT_FOUND
      await expect(
        runtime.wakeMember(testDir, "team-123", "worker"),
      ).rejects.toThrow(TeamError);

      expect(() => runtime.buildWakePrompt({}, {})).toThrow(
        /not implemented \(T9/,
      );
      expect(() => runtime.startLoop(testDir, "team-123")).toThrow(
        /not implemented \(T10/,
      );
      expect(() => runtime.stopLoop("team-123")).toThrow(
        /not implemented \(T10/,
      );
      await expect(runtime.deleteTeam(testDir, "team-123")).rejects.toThrow(
        /not implemented \(T10/,
      );
    });
  });

  describe("src/team/runtime T7: worktree manager + createTeam integration", () => {
    it("slugifies member names for safe path usage", () => {
      expect(slugifyMemberName("worker")).toBe("worker");
      expect(slugifyMemberName("special/worker:1")).toBe("special_worker_1");
      expect(slugifyMemberName("agent@team.io")).toBe("agent_team.io");
      expect(slugifyMemberName("sisyphus-junior")).toBe("sisyphus-junior");
    });

    it("resolves realpath'd worktree path under os.tmpdir()", () => {
      const p = resolveMemberWorktree("team-abc-123", "worker");
      expect(p.startsWith(fsSync.realpathSync(os.tmpdir()))).toBe(true);
      expect(p).toContain("agy-bridge-team-team-abc-123-worker");
    });

    it("calls spawnWorktree once per member with realpath'd tmpdir path and captures args", async () => {
      const spawnCalls: Array<{ projectRoot: string; teamRunId: string; member: string }> = [];
      const runtime = new TeamRuntime({
        spawnWorktree: async (projectRoot, teamRunId, member) => {
          spawnCalls.push({ projectRoot, teamRunId, member });
          const wt = resolveMemberWorktree(teamRunId, member);
          return {
            worktreePath: wt,
            cwd: wt,
            sessionCwd: path.resolve(projectRoot),
          };
        },
        removeWorktrees: async () => {},
      });

      const res = await runtime.createTeam(validMultiSpec, testDir);
      expect(spawnCalls).toHaveLength(3);
      expect(spawnCalls.map((c) => c.member)).toEqual(["planner", "worker", "reviewer"]);
      expect(spawnCalls[0].projectRoot).toBe(testDir);
      expect(spawnCalls[0].teamRunId).toBe(res.teamRunId);

      const state = await runtime.loadState(testDir, res.teamRunId);
      for (const m of state.members) {
        expect(m.worktreePath).toBe(resolveMemberWorktree(res.teamRunId, m.name));
        expect(m.worktreePath?.startsWith(fsSync.realpathSync(os.tmpdir()))).toBe(true);
      }
      expect(res.worktrees).toEqual(state.members.map((m) => m.worktreePath));
    });

    it("rolls back worktrees when 2nd member's spawnWorktree throws", async () => {
      const removedCalls: Array<{ projectRoot: string; teamRunId: string; members: string[] }> = [];
      let callCount = 0;

      const runtime = new TeamRuntime({
        spawnWorktree: async (projectRoot, teamRunId, member) => {
          callCount++;
          if (callCount === 2) {
            throw new Error("simulated spawn failure for second member");
          }
          const wt = resolveMemberWorktree(teamRunId, member);
          return {
            worktreePath: wt,
            cwd: wt,
            sessionCwd: path.resolve(projectRoot),
          };
        },
        removeWorktrees: async (projectRoot, teamRunId, members) => {
          removedCalls.push({ projectRoot, teamRunId, members });
        },
      });

      await expect(runtime.createTeam(validMultiSpec, testDir)).rejects.toThrow(
        "simulated spawn failure for second member",
      );

      // Rollback was called for 1st member
      expect(removedCalls).toHaveLength(1);
      expect(removedCalls[0].projectRoot).toBe(testDir);
      expect(removedCalls[0].members).toEqual(["planner"]);
    });

    it("throws TeamError with NOT_GIT_REPO when projectRoot is not a git repo", async () => {
      await expect(
        spawnWorktree(testDir, "team-run-not-git", "worker"),
      ).rejects.toThrow(TeamError);

      try {
        await spawnWorktree(testDir, "team-run-not-git", "worker");
      } catch (err) {
        const teamErr = err as TeamError;
        expect(teamErr.code).toBe("NOT_GIT_REPO");
        expect(teamErr.field).toBe("projectRoot");
        expect(teamErr.message).toContain("not a git repository");
      }
    });

    it("handles removeWorktrees best-effort when one fails and another succeeds", async () => {
      let isGit = false;
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        isGit = true;
      } catch {
        isGit = false;
      }
      if (!isGit) return;

      const scratchDir = path.join(os.tmpdir(), `wt-best-effort-${randomUUID()}`);
      await fs.mkdir(scratchDir, { recursive: true });

      try {
        execFileSync("git", ["init"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "test"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: scratchDir, stdio: "ignore" });

        const runId = "test-run-best-effort";
        const res1 = await spawnWorktree(scratchDir, runId, "worker1");
        expect(existsSync(res1.worktreePath)).toBe(true);

        // Member 2 does not exist, worker1 exists.
        // removeWorktrees should succeed best-effort and remove worker1 without throwing.
        await expect(
          removeWorktrees(scratchDir, runId, ["worker1", "missing-worker"]),
        ).resolves.not.toThrow();

        expect(existsSync(res1.worktreePath)).toBe(false);
      } finally {
        await fs.rm(scratchDir, { recursive: true, force: true });
      }
    });

    it("throws TeamError with REMOVE_WORKTREES_FAILED only if ALL attempted removals fail", async () => {
      let isGit = false;
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        isGit = true;
      } catch {
        isGit = false;
      }
      if (!isGit) return;

      const scratchDir = path.join(os.tmpdir(), `wt-all-fail-${randomUUID()}`);
      await fs.mkdir(scratchDir, { recursive: true });

      try {
        execFileSync("git", ["init"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "test"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: scratchDir, stdio: "ignore" });
        execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: scratchDir, stdio: "ignore" });

        const runId = "test-run-all-fail";
        // Create 2 directories that exist, but are NOT valid git worktrees
        const p1 = resolveMemberWorktree(runId, "fail1");
        const p2 = resolveMemberWorktree(runId, "fail2");
        await fs.mkdir(p1, { recursive: true });
        await fs.mkdir(p2, { recursive: true });

        try {
          await expect(
            removeWorktrees(scratchDir, runId, ["fail1", "fail2"]),
          ).rejects.toThrow(TeamError);

          try {
            await removeWorktrees(scratchDir, runId, ["fail1", "fail2"]);
          } catch (err) {
            const teamErr = err as TeamError;
            expect(teamErr.code).toBe("REMOVE_WORKTREES_FAILED");
            expect(teamErr.field).toBe("worktree");
          }
        } finally {
          await fs.rm(p1, { recursive: true, force: true });
          await fs.rm(p2, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(scratchDir, { recursive: true, force: true });
      }
    });

    it("creates and removes worktrees in a real scratch git repository (real-git integration test)", async () => {
      let isGitAvailable = false;
      try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        isGitAvailable = true;
      } catch {
        isGitAvailable = false;
      }

      if (!isGitAvailable) {
        console.warn("git not available in environment, skipping real-git integration test");
        return;
      }

      const gitRepoDir = path.join(os.tmpdir(), `real-git-test-${randomUUID()}`);
      await fs.mkdir(gitRepoDir, { recursive: true });

      try {
        execFileSync("git", ["init"], { cwd: gitRepoDir, stdio: "ignore" });
        execFileSync("git", ["config", "user.name", "Integration Test"], {
          cwd: gitRepoDir,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "user.email", "test@example.com"], {
          cwd: gitRepoDir,
          stdio: "ignore",
        });
        execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
          cwd: gitRepoDir,
          stdio: "ignore",
        });

        // Instantiate runtime with default deps (real git!)
        const runtime = new TeamRuntime();
        const res = await runtime.createTeam(validMultiSpec, gitRepoDir);

        expect(res.status).toBe("creating");
        expect(res.worktrees).toHaveLength(3);

        // Verify each worktree exists on disk and is a realpath
        for (const wtPath of res.worktrees!) {
          expect(existsSync(wtPath)).toBe(true);
          expect(fsSync.realpathSync(wtPath)).toBe(wtPath);
        }

        // Verify git worktree list output contains the created worktrees
        const listOutput = execFileSync("git", ["worktree", "list"], {
          cwd: gitRepoDir,
        }).toString();
        for (const wtPath of res.worktrees!) {
          expect(listOutput).toContain(wtPath);
        }

        // Clean up via removeWorktrees
        await runtime.removeWorktrees(gitRepoDir, res.teamRunId, res.members!);

        // Verify worktrees are gone from disk
        for (const wtPath of res.worktrees!) {
          expect(existsSync(wtPath)).toBe(false);
        }

        // Verify git worktree list is clean (only main repo remains)
        const cleanListOutput = execFileSync("git", ["worktree", "list"], {
          cwd: gitRepoDir,
        }).toString();
        for (const wtPath of res.worktrees!) {
          expect(cleanListOutput).not.toContain(wtPath);
        }
      } finally {
        await fs.rm(gitRepoDir, { recursive: true, force: true });
      }
    });
  });
});

describe("src/team/runtime T8: wakeMember with failover + session persistence", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-wake-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const multiSpec: TeamSpec = {
    version: 1,
    name: "wake-team",
    leadAgentId: "alpha",
    backendType: "cli",
    members: [
      {
        name: "alpha",
        kind: "subagent_type",
        subagent_type: "deep",
        backendType: "cli",
      },
      {
        name: "beta",
        kind: "category",
        category: "visual-engineering",
        backendType: "cli",
      },
    ],
  };

  function makeSemaphore(): TeamSemaphore & { count: number } {
    let count = 0;
    return {
      get count() { return count; },
      acquire: async () => { count++; },
      release: () => { count--; },
    };
  }

  function createWakeRuntime(
    runWake: (opts: WakeOptions) => Promise<WakeResult>,
    extra: Partial<TeamRuntimeDeps> = {},
  ): TeamRuntime {
    return new TeamRuntime({
      spawnWorktree: async (projectRoot, teamRunId, member) => {
        const wt = resolveMemberWorktree(teamRunId, member);
        return {
          worktreePath: wt,
          cwd: wt,
          sessionCwd: path.resolve(projectRoot),
        };
      },
      removeWorktrees: async () => {},
      runWake,
      resolveModelChain: (member) => [member.resolvedRole],
      ...extra,
    });
  }

  it("first wake passes no conversationId; second wake reuses member.sessionId", async () => {
    const wakeCalls: WakeOptions[] = [];
    const fakeRunWake = async (opts: WakeOptions): Promise<WakeResult> => {
      wakeCalls.push({ ...opts });
      return { output: `done-${wakeCalls.length}`, sessionId: "sess-abc", model: opts.model };
    };

    const runtime = createWakeRuntime(fakeRunWake);
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    // First wake: no prior sessionId → conversationId should be undefined
    const res1 = await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "task1" });
    expect(res1.ok).toBe(true);
    expect(res1.sessionId).toBe("sess-abc");
    expect(wakeCalls[0].conversationId).toBeUndefined();

    // Verify sessionId persisted in state
    const stateAfter1 = await runtime.loadState(testDir, teamRunId);
    expect(stateAfter1.members.find((m) => m.name === "alpha")?.sessionId).toBe("sess-abc");

    // Second wake: reuses sessionId from state as conversationId
    const res2 = await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "task2" });
    expect(res2.ok).toBe(true);
    expect(wakeCalls[1].conversationId).toBe("sess-abc");
  });

  it("rejects double-wake with ALREADY_RUNNING when member is running", async () => {
    const runtime = createWakeRuntime(async () => ({ output: "x", sessionId: null, model: null }));
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    // Manually set alpha to running
    await runtime.updateState(testDir, teamRunId, (s) => {
      const m = s.members.find((x) => x.name === "alpha");
      if (m) m.status = "running";
      return s;
    });

    await expect(
      runtime.wakeMember(testDir, teamRunId, "alpha"),
    ).rejects.toThrow(TeamError);

    try {
      await runtime.wakeMember(testDir, teamRunId, "alpha");
    } catch (err) {
      const teamErr = err as TeamError;
      expect(teamErr.code).toBe("ALREADY_RUNNING");
    }
  });

  it("rejects wake on removed member", async () => {
    const runtime = createWakeRuntime(async () => ({ output: "x", sessionId: null, model: null }));
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    // Set to awaiting_shutdown then removed
    await runtime.requestShutdown(testDir, teamRunId, "alpha");
    await runtime.approveShutdown(testDir, teamRunId, "alpha");

    await expect(
      runtime.wakeMember(testDir, teamRunId, "alpha"),
    ).rejects.toThrow(TeamError);

    try {
      await runtime.wakeMember(testDir, teamRunId, "alpha");
    } catch (err) {
      expect((err as TeamError).code).toBe("MEMBER_REMOVED");
    }
  });

  it("quota failover: QuotaError on model A → succeeds on B, cooldowns.set called with A", async () => {
    const cooldownCalls: Array<{ model: string; sec: number }> = [];
    const fakeCooldowns = {
      isCooled: () => false,
      set: (model: string, sec: number) => { cooldownCalls.push({ model, sec }); },
      get: () => null,
    };

    let callCount = 0;
    const fakeRunWake = async (opts: WakeOptions): Promise<WakeResult> => {
      callCount++;
      if (opts.model === "model-A") {
        throw new QuotaError("model-A", { resetText: "1h0m0s", resetSeconds: 3600 });
      }
      return { output: "ok-from-B", sessionId: "sess-B", model: "model-B" };
    };

    const runtime = createWakeRuntime(fakeRunWake, {
      cooldowns: fakeCooldowns,
      resolveModelChain: () => ["model-A", "model-B"],
    });
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    const res = await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "failover test" });
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe("sess-B");

    // Verify cooldowns.set was called with model-A
    expect(cooldownCalls.length).toBeGreaterThanOrEqual(1);
    expect(cooldownCalls[0].model).toBe("model-A");
    expect(cooldownCalls[0].sec).toBe(3600);

    // Verify sessionId from B is persisted
    const state = await runtime.loadState(testDir, teamRunId);
    expect(state.members.find((m) => m.name === "alpha")?.sessionId).toBe("sess-B");
  });

  it("finally releases semaphore even on throw", async () => {
    const sem = makeSemaphore();
    const fakeRunWake = async (): Promise<WakeResult> => {
      throw new Error("boom");
    };

    const runtime = createWakeRuntime(fakeRunWake, { semaphore: sem });
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    await expect(
      runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "crash" }),
    ).rejects.toThrow("boom");

    // Semaphore was acquired (+1) then released (-1) → back to 0
    expect(sem.count).toBe(0);

    // Member status reset to idle after failure
    const state = await runtime.loadState(testDir, teamRunId);
    expect(state.members.find((m) => m.name === "alpha")?.status).toBe("idle");
  });

  it("shutdown-requested-mid-run → member ends awaiting_shutdown, not idle", async () => {
    let runWakeResolve: ((v: WakeResult) => void) | undefined;
    const fakeRunWake = async (): Promise<WakeResult> => {
      // Simulate a long-running wake that we can control
      return new Promise<WakeResult>((resolve) => {
        runWakeResolve = resolve;
      });
    };

    const runtime = createWakeRuntime(fakeRunWake);
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    // Start wake in background
    const wakePromise = runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "long task" });

    // Wait for member to be marked running
    await new Promise((r) => setTimeout(r, 100));
    const midState = await runtime.loadState(testDir, teamRunId);
    expect(midState.members.find((m) => m.name === "alpha")?.status).toBe("running");

    // Request shutdown mid-run
    await runtime.requestShutdown(testDir, teamRunId, "alpha");

    // Verify the running→awaiting_shutdown transition is valid and was applied
    const shutdownState = await runtime.loadState(testDir, teamRunId);
    expect(shutdownState.members.find((m) => m.name === "alpha")?.status).toBe("awaiting_shutdown");

    // Now resolve the wake
    runWakeResolve!({ output: "done", sessionId: "sess-x", model: null });
    const res = await wakePromise;
    expect(res.ok).toBe(true);

    // After finally block, status should remain awaiting_shutdown (not reset to idle)
    const finalState = await runtime.loadState(testDir, teamRunId);
    expect(finalState.members.find((m) => m.name === "alpha")?.status).toBe("awaiting_shutdown");
  });

  it("transcript file gets output line on success + error line on quota failure", async () => {
    let callCount = 0;
    const fakeRunWake = async (opts: WakeOptions): Promise<WakeResult> => {
      callCount++;
      if (callCount === 1 && opts.model === "model-A") {
        throw new QuotaError("model-A", { resetSeconds: 60 });
      }
      return { output: "final-output", sessionId: "sess-final", model: opts.model };
    };

    const runtime = createWakeRuntime(fakeRunWake, {
      cooldowns: {
        isCooled: () => false,
        set: () => {},
        get: () => null,
      },
      resolveModelChain: () => ["model-A", "model-B"],
    });
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    const res = await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "transcript test" });
    expect(res.ok).toBe(true);

    // Read transcript file
    const state = await runtime.loadState(testDir, teamRunId);
    const transcriptPath = state.members.find((m) => m.name === "alpha")!.transcriptPath;
    const lines = (await fs.readFile(transcriptPath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const errorLine = JSON.parse(lines[0]);
    expect(errorLine.kind).toBe("error");
    expect(errorLine.model).toBe("model-A");
    expect(errorLine.error).toContain("QuotaError");

    const outputLine = JSON.parse(lines[1]);
    expect(outputLine.kind).toBe("output");
    expect(outputLine.model).toBe("model-B");
    expect(outputLine.output).toBe("final-output");
    expect(outputLine.sessionId).toBe("sess-final");
  });

  it("all models exhausted returns ok:false without throwing", async () => {
    const fakeRunWake = async (opts: WakeOptions): Promise<WakeResult> => {
      throw new QuotaError(opts.model, { resetSeconds: 120 });
    };

    const runtime = createWakeRuntime(fakeRunWake, {
      cooldowns: {
        isCooled: () => false,
        set: () => {},
        get: () => null,
      },
      resolveModelChain: () => ["only-model"],
    });
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    const res = await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "exhaust" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("All models exhausted");

    // Member status should be idle after finally
    const state = await runtime.loadState(testDir, teamRunId);
    expect(state.members.find((m) => m.name === "alpha")?.status).toBe("idle");
  });

  it("semaphore acquire is called before runWake and release after", async () => {
    const sem = makeSemaphore();
    let semDuringWake = -1;

    const fakeRunWake = async (): Promise<WakeResult> => {
      semDuringWake = sem.count;
      return { output: "ok", sessionId: null, model: null };
    };

    const runtime = createWakeRuntime(fakeRunWake, { semaphore: sem });
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    expect(sem.count).toBe(0);
    await runtime.wakeMember(testDir, teamRunId, "alpha", { prompt: "sem test" });

    // During runWake, semaphore was held (count = 1)
    expect(semDuringWake).toBe(1);
    // After completion, semaphore released (count = 0)
    expect(sem.count).toBe(0);
  });

  it("member not found throws MEMBER_NOT_FOUND", async () => {
    const runtime = createWakeRuntime(async () => ({ output: "", sessionId: null, model: null }));
    const { teamRunId } = await runtime.createTeam(multiSpec, testDir);

    await expect(
      runtime.wakeMember(testDir, teamRunId, "ghost"),
    ).rejects.toThrow(TeamError);

    try {
      await runtime.wakeMember(testDir, teamRunId, "ghost");
    } catch (err) {
      expect((err as TeamError).code).toBe("MEMBER_NOT_FOUND");
    }
  });
});
