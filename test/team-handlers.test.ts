import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  handleTeamCreate,
  handleSendMessage,
  handleTeamTaskCreate,
  handleTeamTaskList,
  handleTeamTaskGet,
  handleTeamTaskUpdate,
  TEAM_HANDLERS,
  type TeamHandlerContext,
} from "../src/team/handlers.js";
import { TeamRuntime, resolveMemberWorktree, type TeamRuntimeDeps } from "../src/team/runtime.js";
import { type TeamSpec } from "../src/team/spec.js";
import { MAX_PAYLOAD_BYTES } from "../src/team/mailbox.js";
import { atomicWriteJson } from "../src/team/store.js";

describe("T14-T15: Messaging & Task Tool Handlers", () => {
  let testDir: string;
  let runtime: TeamRuntime;
  let ctx: TeamHandlerContext;
  let teamRunId: string;

  function createMockRuntime(deps: TeamRuntimeDeps = {}): TeamRuntime {
    return new TeamRuntime({
      spawnWorktree: async (projectRoot, tId, member) => {
        const wt = resolveMemberWorktree(tId, member);
        return {
          worktreePath: wt,
          cwd: wt,
          sessionCwd: path.resolve(projectRoot),
        };
      },
      removeWorktrees: async () => {},
      runAgy: async () => ({
        output: "mock output",
        sessionId: "mock-session",
        attempts: [],
      }),
      ...deps,
    });
  }

  const testSpec: TeamSpec = {
    version: 1,
    name: "handlers-team",
    leadAgentId: "lead",
    backendType: "cli",
    members: [
      {
        name: "lead",
        kind: "subagent_type",
        subagent_type: "deep",
        backendType: "cli",
      },
      {
        name: "researcher",
        kind: "category",
        category: "research",
        backendType: "cli",
      },
      {
        name: "tester",
        kind: "category",
        category: "quality",
        backendType: "cli",
      },
    ],
  };

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-handlers-test-${randomUUID()}`);
    await fsp.mkdir(testDir, { recursive: true });
    runtime = createMockRuntime({ cfg: { teamPollMs: 60_000 } });
    ctx = { projectRoot: testDir, runtime };

    // Create a team to operate on
    const createRes = await handleTeamCreate({ inline_spec: testSpec }, ctx);
    const jsonStart = createRes.content[0].text.indexOf("{");
    const parsed = JSON.parse(createRes.content[0].text.slice(jsonStart));
    teamRunId = parsed.teamRunId;
  });

  afterEach(async () => {
    try {
      runtime.stopLoop(testDir, teamRunId);
    } catch {}

    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("T14: handleSendMessage", () => {
    it("validates required arguments (teamRunId, to, body)", async () => {
      const missingTeam = await handleSendMessage({ to: "lead", body: "hello" }, ctx);
      expect(missingTeam.isError).toBe(true);
      expect(missingTeam.content[0].text).toContain("INVALID_ARGUMENT: teamRunId is required");

      const missingTo = await handleSendMessage({ teamRunId, body: "hello" }, ctx);
      expect(missingTo.isError).toBe(true);
      expect(missingTo.content[0].text).toContain("INVALID_ARGUMENT: recipient 'to' is required");

      const missingBody = await handleSendMessage({ teamRunId, to: "lead" }, ctx);
      expect(missingBody.isError).toBe(true);
      expect(missingBody.content[0].text).toContain("INVALID_ARGUMENT: body is required");

      const emptyBody = await handleSendMessage({ teamRunId, to: "lead", body: "   " }, ctx);
      expect(emptyBody.isError).toBe(true);
      expect(emptyBody.content[0].text).toContain("INVALID_ARGUMENT: body is required");
    });

    it("sends a message to a single member with default from='lead'", async () => {
      const res = await handleSendMessage(
        {
          teamRunId,
          to: "researcher",
          body: "Please analyze the codebase architecture",
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("[team_send_message]");
      expect(res.content[0].text).toContain("Message delivered to 1 recipient(s): researcher");

      const parsed = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
      expect(parsed.from).toBe("lead");
      expect(parsed.to).toBe("researcher");
      expect(parsed.broadcast).toBe(false);
      expect(parsed.delivered).toEqual(["researcher"]);
      expect(typeof parsed.messageId).toBe("string");
    });

    it("sends a message with custom from sender", async () => {
      const res = await handleSendMessage(
        {
          teamRunId,
          from: "researcher",
          to: "tester",
          body: "Research complete, ready for testing",
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
      expect(parsed.from).toBe("researcher");
      expect(parsed.to).toBe("tester");
      expect(parsed.delivered).toEqual(["tester"]);
    });

    it("broadcasts message to all team members when to='*'", async () => {
      const res = await handleSendMessage(
        {
          teamRunId,
          to: "*",
          body: "Team sync starting now",
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Message delivered to 3 recipient(s)");

      const parsed = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
      expect(parsed.broadcast).toBe(true);
      expect(parsed.delivered).toEqual(expect.arrayContaining(["lead", "researcher", "tester"]));
    });

    it("returns isError with MEMBER_NOT_FOUND when recipient does not exist", async () => {
      const res = await handleSendMessage(
        {
          teamRunId,
          to: "nonexistent-member",
          body: "Hello ghost",
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("MEMBER_NOT_FOUND");
      expect(res.content[0].text).toContain("nonexistent-member");
    });

    it("returns isError with PAYLOAD_TOO_LARGE when body exceeds MAX_PAYLOAD_BYTES", async () => {
      const largeBody = "x".repeat(MAX_PAYLOAD_BYTES + 100);
      const res = await handleSendMessage(
        {
          teamRunId,
          to: "lead",
          body: largeBody,
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("PAYLOAD_TOO_LARGE");
    });

    it("returns isError with RECIPIENT_BACKPRESSURE when recipient unread exceeds limit", async () => {
      const inboxDir = path.join(testDir, ".omo", "runtime", teamRunId, "inboxes", "researcher");
      await fsp.mkdir(inboxDir, { recursive: true });

      // Pre-seed an existing message in researcher's inbox totaling ~250 KB
      const preseededPath = path.join(inboxDir, "existing-msg.json");
      const largeContent = "x".repeat(249_000);
      await atomicWriteJson(preseededPath, {
        id: "pre-seed",
        from: "lead",
        to: "researcher",
        body: largeContent,
        ts: Date.now() - 10_000,
      });

      // Sending another 20 KB message pushes total unread over 256 KB limit
      const res = await handleSendMessage(
        {
          teamRunId,
          to: "researcher",
          body: "y".repeat(20_000),
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("RECIPIENT_BACKPRESSURE");
    });

    it("supports team_id alias", async () => {
      const res = await handleSendMessage(
        {
          team_id: teamRunId,
          to: "lead",
          body: "ping",
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("delivered to 1 recipient(s)");
    });
  });

  describe("T15: Task handlers (create, list, get, update)", () => {
    it("validates required arguments across task handlers", async () => {
      // create
      const createNoTeam = await handleTeamTaskCreate({ subject: "test" }, ctx);
      expect(createNoTeam.isError).toBe(true);
      expect(createNoTeam.content[0].text).toContain("INVALID_ARGUMENT: teamRunId is required");

      const createNoSubject = await handleTeamTaskCreate({ teamRunId }, ctx);
      expect(createNoSubject.isError).toBe(true);
      expect(createNoSubject.content[0].text).toContain("INVALID_ARGUMENT: subject is required");

      // list
      const listNoTeam = await handleTeamTaskList({}, ctx);
      expect(listNoTeam.isError).toBe(true);
      expect(listNoTeam.content[0].text).toContain("INVALID_ARGUMENT: teamRunId is required");

      // get
      const getNoTeam = await handleTeamTaskGet({ taskId: "t1" }, ctx);
      expect(getNoTeam.isError).toBe(true);
      expect(getNoTeam.content[0].text).toContain("INVALID_ARGUMENT: teamRunId is required");

      const getNoTask = await handleTeamTaskGet({ teamRunId }, ctx);
      expect(getNoTask.isError).toBe(true);
      expect(getNoTask.content[0].text).toContain("INVALID_ARGUMENT: taskId is required");

      // update
      const updateNoArgs = await handleTeamTaskUpdate({ teamRunId, taskId: "t1" }, ctx);
      expect(updateNoArgs.isError).toBe(true);
      expect(updateNoArgs.content[0].text).toContain(
        "At least one of 'status' or 'owner' must be provided",
      );
    });

    it("returns (no tasks) when task list is empty", async () => {
      const res = await handleTeamTaskList({ teamRunId }, ctx);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBe("(no tasks)");
    });

    it("creates a task and returns taskId + subject", async () => {
      const res = await handleTeamTaskCreate(
        {
          teamRunId,
          subject: "Build authentication module",
          description: "OAuth2 with JWT support",
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("[team_task_create]");
      expect(res.content[0].text).toContain("Build authentication module");

      const parsed = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
      expect(parsed.subject).toBe("Build authentication module");
      expect(parsed.description).toBe("OAuth2 with JWT support");
      expect(parsed.status).toBe("pending");
      expect(parsed.owner).toBeNull();
      expect(typeof parsed.id).toBe("string");
    });

    it("lists tasks formatted as '- [<status>] <taskId>: <subject> (owner: <owner|unassigned>)'", async () => {
      await handleTeamTaskCreate({ teamRunId, subject: "Task A" }, ctx);
      await handleTeamTaskCreate({ teamRunId, subject: "Task B", owner: "lead" }, ctx);

      const res = await handleTeamTaskList({ teamRunId }, ctx);
      expect(res.isError).toBeFalsy();

      const text = res.content[0].text;
      expect(text).toContain("- [pending]");
      expect(text).toContain("Task A (owner: unassigned)");
      expect(text).toContain("Task B (owner: lead)");
    });

    it("filters task list by status and owner", async () => {
      const create1 = await handleTeamTaskCreate(
        { teamRunId, subject: "Task 1", owner: "lead" },
        ctx,
      );
      const task1 = JSON.parse(create1.content[0].text.slice(create1.content[0].text.indexOf("{")));

      await handleTeamTaskCreate({ teamRunId, subject: "Task 2", owner: "tester" }, ctx);

      // Claim task 1
      await handleTeamTaskUpdate(
        { teamRunId, taskId: task1.id, status: "claimed", owner: "lead" },
        ctx,
      );

      // Filter by status=claimed
      const claimedList = await handleTeamTaskList({ teamRunId, status: "claimed" }, ctx);
      expect(claimedList.content[0].text).toContain("Task 1");
      expect(claimedList.content[0].text).not.toContain("Task 2");

      // Filter by owner=tester
      const testerList = await handleTeamTaskList({ teamRunId, owner: "tester" }, ctx);
      expect(testerList.content[0].text).toContain("Task 2");
      expect(testerList.content[0].text).not.toContain("Task 1");
    });

    it("retrieves full task detail via handleTeamTaskGet", async () => {
      const createRes = await handleTeamTaskCreate(
        {
          teamRunId,
          subject: "Detailed Task",
          description: "Deep dive investigation",
          owner: "researcher",
        },
        ctx,
      );
      const created = JSON.parse(
        createRes.content[0].text.slice(createRes.content[0].text.indexOf("{")),
      );

      const getRes = await handleTeamTaskGet({ teamRunId, taskId: created.id }, ctx);
      expect(getRes.isError).toBeFalsy();

      const text = getRes.content[0].text;
      expect(text).toContain("[team_task_get]");
      expect(text).toContain(`Task: ${created.id}`);
      expect(text).toContain("Detailed Task");
      expect(text).toContain("Deep dive investigation");
      expect(text).toContain("Owner: researcher");

      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      expect(parsed.id).toBe(created.id);
      expect(parsed.subject).toBe("Detailed Task");
      expect(parsed.owner).toBe("researcher");
    });

    it("returns isError with TASK_NOT_FOUND when task does not exist", async () => {
      const res = await handleTeamTaskGet({ teamRunId, taskId: "nonexistent-task" }, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("TASK_NOT_FOUND");
      expect(res.content[0].text).toContain("nonexistent-task");
    });

    it("claims a pending task atomically requiring owner", async () => {
      const createRes = await handleTeamTaskCreate({ teamRunId, subject: "Unassigned Task" }, ctx);
      const created = JSON.parse(
        createRes.content[0].text.slice(createRes.content[0].text.indexOf("{")),
      );

      // Claiming without owner fails
      const noOwner = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "claimed" },
        ctx,
      );
      expect(noOwner.isError).toBe(true);
      expect(noOwner.content[0].text).toContain("OWNER_REQUIRED");

      // Claiming with owner succeeds
      const claimRes = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "claimed", owner: "researcher" },
        ctx,
      );
      expect(claimRes.isError).toBeFalsy();
      expect(claimRes.content[0].text).toContain("status=claimed");
      expect(claimRes.content[0].text).toContain("owner=researcher");

      // Subsequent claim by another owner throws ALREADY_CLAIMED
      const doubleClaim = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "claimed", owner: "tester" },
        ctx,
      );
      expect(doubleClaim.isError).toBe(true);
      expect(doubleClaim.content[0].text).toContain("ALREADY_CLAIMED");
    });

    it("executes forward-only status transitions (claimed -> in_progress -> completed)", async () => {
      const createRes = await handleTeamTaskCreate({ teamRunId, subject: "Pipeline Task" }, ctx);
      const created = JSON.parse(
        createRes.content[0].text.slice(createRes.content[0].text.indexOf("{")),
      );

      // 1. Claim
      await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "claimed", owner: "lead" },
        ctx,
      );

      // 2. in_progress
      const inProg = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "in_progress", owner: "lead" },
        ctx,
      );
      expect(inProg.isError).toBeFalsy();
      expect(inProg.content[0].text).toContain("status=in_progress");

      // 3. completed
      const comp = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "completed", owner: "lead" },
        ctx,
      );
      expect(comp.isError).toBeFalsy();
      expect(comp.content[0].text).toContain("status=completed");

      // 4. Reverse transition (completed -> in_progress) throws INVALID_TRANSITION
      const reverse = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "in_progress", owner: "lead" },
        ctx,
      );
      expect(reverse.isError).toBe(true);
      expect(reverse.content[0].text).toContain("INVALID_TRANSITION");
    });

    it("rejects cross-owner update attempts with CROSS_OWNER_UPDATE", async () => {
      const createRes = await handleTeamTaskCreate(
        { teamRunId, subject: "Owned Task", owner: "lead" },
        ctx,
      );
      const created = JSON.parse(
        createRes.content[0].text.slice(createRes.content[0].text.indexOf("{")),
      );

      // Claim as lead
      await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "claimed", owner: "lead" },
        ctx,
      );

      // Advance as lead to in_progress
      await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "in_progress", owner: "lead" },
        ctx,
      );

      // Tester tries to update task owned by lead
      const crossUpdate = await handleTeamTaskUpdate(
        { teamRunId, taskId: created.id, status: "completed", owner: "tester" },
        ctx,
      );
      expect(crossUpdate.isError).toBe(true);
      expect(crossUpdate.content[0].text).toContain("CROSS_OWNER_UPDATE");
    });
  });

  describe("TEAM_HANDLERS map integration for T14-T15", () => {
    it("contains all expected messaging and task keys and aliases", () => {
      expect(TEAM_HANDLERS.team_send_message).toBe(handleSendMessage);
      expect(TEAM_HANDLERS.team_task_create).toBe(handleTeamTaskCreate);
      expect(TEAM_HANDLERS.team_task_list).toBe(handleTeamTaskList);
      expect(TEAM_HANDLERS.team_task_get).toBe(handleTeamTaskGet);
      expect(TEAM_HANDLERS.team_task_update).toBe(handleTeamTaskUpdate);

      // Short aliases
      expect(TEAM_HANDLERS.send_message).toBe(handleSendMessage);
      expect(TEAM_HANDLERS.task_create).toBe(handleTeamTaskCreate);
      expect(TEAM_HANDLERS.task_list).toBe(handleTeamTaskList);
      expect(TEAM_HANDLERS.task_get).toBe(handleTeamTaskGet);
      expect(TEAM_HANDLERS.task_update).toBe(handleTeamTaskUpdate);
    });

    it("invokes messaging and task handlers via TEAM_HANDLERS dictionary", async () => {
      // Create task via dictionary
      const createRes = await TEAM_HANDLERS.team_task_create(
        { teamRunId, subject: "Dict task" },
        ctx,
      );
      expect(createRes.isError).toBeFalsy();

      // List tasks via dictionary
      const listRes = await TEAM_HANDLERS.team_task_list({ teamRunId }, ctx);
      expect(listRes.isError).toBeFalsy();
      expect(listRes.content[0].text).toContain("Dict task");

      // Send message via dictionary
      const msgRes = await TEAM_HANDLERS.team_send_message(
        { teamRunId, to: "lead", body: "Dict message" },
        ctx,
      );
      expect(msgRes.isError).toBeFalsy();
      expect(msgRes.content[0].text).toContain("Message delivered to 1 recipient(s)");
    });
  });
});
