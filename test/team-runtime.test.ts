import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  TeamRuntime,
  validateTransition,
  isValidMemberTransition,
  generateTeamRunId,
  getTeamState,
  loadTeamState,
  updateTeamState,
  ALLOWED_MEMBER_TRANSITIONS,
  type MemberStatus,
} from "../src/team/runtime.js";
import { TeamError, type TeamSpec } from "../src/team/spec.js";
import { runDir, readJson } from "../src/team/store.js";

describe("src/team/runtime T6: TeamRuntime createTeam + member state machine", () => {
  let testDir: string;

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
      const runtime = new TeamRuntime();
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
      });

      expect(worker).toEqual({
        name: "worker",
        kind: "category",
        resolvedRole: "visual-engineering",
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(targetRunDir, "transcript", "worker.jsonl"),
      });

      expect(reviewer).toEqual({
        name: "reviewer",
        kind: "subagent_type",
        resolvedRole: "ultrabrain", // alias atlas -> ultrabrain
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(targetRunDir, "transcript", "reviewer.jsonl"),
      });

      // Run directory structure verified
      expect(existsSync(path.join(targetRunDir, "inboxes", "planner"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "inboxes", "worker"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "inboxes", "reviewer"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "tasks"))).toBe(true);
      expect(existsSync(path.join(targetRunDir, "transcript"))).toBe(true);
    });

    it("supports inverted arguments createTeam(projectRoot, spec)", async () => {
      const runtime = new TeamRuntime();
      const res = await runtime.createTeam(testDir, validSingleSpec);

      expect(res.status).toBe("creating");
      const state = await runtime.loadState(testDir, res.teamRunId);
      expect(state.teamRunId).toBe(res.teamRunId);
      expect(state.members).toHaveLength(1);
      expect(state.members[0].name).toBe("lead");
    });

    it("generates unique teamRunId across two sequential create calls", async () => {
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
      const { teamRunId } = await runtime.createTeam(validMultiSpec, testDir);

      // approveShutdown on idle member is illegal transition (idle -> removed is invalid)
      await expect(
        runtime.approveShutdown(testDir, teamRunId, "worker"),
      ).rejects.toThrow(TeamError);
    });

    it("rejects shutdown operations for non-existent member", async () => {
      const runtime = new TeamRuntime();
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
      const runtime = new TeamRuntime();
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

      await expect(
        runtime.spawnWorktree(testDir, "team-123", "worker"),
      ).rejects.toThrow(/not implemented \(T7/);

      await expect(
        runtime.removeWorktrees(testDir, "team-123", ["worker"]),
      ).rejects.toThrow(/not implemented \(T7/);

      await expect(
        runtime.wakeMember(testDir, "team-123", "worker"),
      ).rejects.toThrow(/not implemented \(T8/);

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
});
