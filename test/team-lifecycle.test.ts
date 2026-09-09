import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  handleTeamCreate,
  handleTeamList,
  handleTeamStatus,
  handleTeamDelete,
  handleTeamShutdownRequest,
  handleTeamShutdownApprove,
  handleTeamShutdownReject,
  handleSendMessage,
  handleTeamTaskCreate,
  handleTeamTaskList,
  handleTeamTaskGet,
  handleTeamTaskUpdate,
  TEAM_HANDLERS,
  type TeamHandlerContext,
} from "../src/team/handlers.js";
import { TeamRuntime, resolveMemberWorktree, type TeamRuntimeDeps } from "../src/team/runtime.js";
import { saveNamedTeam, type TeamSpec } from "../src/team/spec.js";
import { atomicWriteJson, runDir } from "../src/team/store.js";
import { createTask } from "../src/team/tasklist.js";
import { sendMessage } from "../src/team/mailbox.js";

describe("T11-T13: Team Lifecycle & Shutdown Handlers", () => {
  let testDir: string;
  let runtime: TeamRuntime;
  let ctx: TeamHandlerContext;

  function createMockRuntime(deps: TeamRuntimeDeps = {}): TeamRuntime {
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
      runAgy: async () => {
        return {
          output: "mock agy output",
          sessionId: "mock-session",
          attempts: [],
        };
      },
      ...deps,
    });
  }

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-lifecycle-test-${randomUUID()}`);
    await fsp.mkdir(testDir, { recursive: true });
    runtime = createMockRuntime({ cfg: { teamPollMs: 60_000 } });
    ctx = { projectRoot: testDir, runtime };
  });

  afterEach(async () => {
    // Stop any loops that might have started
    try {
      const runtimeDir = path.join(testDir, ".omo", "runtime");
      const entries = await fsp.readdir(runtimeDir).catch(() => []);
      for (const entry of entries) {
        runtime.stopLoop(testDir, entry);
      }
    } catch {}

    try {
      await fsp.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  const validSoloSpec: TeamSpec = {
    version: 1,
    name: "solo-dev",
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

  const validPairSpec: TeamSpec = {
    version: 1,
    name: "pair-team",
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
        name: "reviewer",
        kind: "category",
        category: "quality",
        backendType: "cli",
      },
    ],
  };

  describe("T11: handleTeamCreate", () => {
    it("creates a team from inline spec object and returns creating status immediately", async () => {
      const res = await handleTeamCreate({ inline_spec: validSoloSpec }, ctx);

      expect(res.isError).toBeFalsy();
      expect(res.content[0].type).toBe("text");
      expect(res.content[0].text).toContain("[team_create]");
      expect(res.content[0].text).toContain("Status: creating");
      expect(res.content[0].text).toContain("lead");
      expect(res.content[0].text).toContain("Loop: started");

      const stateFile = path.join(testDir, ".omo", "runtime");
      const entries = await fsp.readdir(stateFile);
      expect(entries.length).toBe(1);
    });

    it("creates a team from inline spec JSON string", async () => {
      const res = await handleTeamCreate({ inline_spec: JSON.stringify(validPairSpec) }, ctx);

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("lead, reviewer");
      expect(res.content[0].text).toContain('"loopStarted": true');
    });

    it("returns isError for malformed inline_spec JSON", async () => {
      const res = await handleTeamCreate({ inline_spec: "{not valid json}" }, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_JSON");
    });

    it("creates a team from flat members array and auto-resolves single member lead", async () => {
      const res = await handleTeamCreate(
        {
          name: "flat-team",
          members: [{ name: "worker", role: "deep" }],
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("worker");
    });

    it("creates a team from flat string members array", async () => {
      const res = await handleTeamCreate(
        {
          name: "string-members",
          leadAgentId: "lead",
          members: ["lead", "helper"],
        },
        ctx,
      );

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("lead, helper");
    });

    it("creates a team from named spec stored in .omo/teams/<name>/config.json", async () => {
      await saveNamedTeam(testDir, validPairSpec);

      const res = await handleTeamCreate({ name: "pair-team" }, ctx);

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("lead, reviewer");
    });

    it("returns isError when named team does not exist", async () => {
      const res = await handleTeamCreate({ name: "nonexistent-team" }, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("TEAM_SPEC_NOT_FOUND");
    });

    it("returns isError when neither named team nor spec is provided", async () => {
      const res = await handleTeamCreate({}, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_ARGUMENT");
    });

    it("rejects non-cli top-level backendType (tmux) with clear REJECTED message", async () => {
      const res = await handleTeamCreate(
        {
          backendType: "tmux",
          inline_spec: validSoloSpec,
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("UNSUPPORTED_BACKEND_TYPE");
      expect(res.content[0].text).toContain("tmux/in-process REJECTED");
    });

    it("rejects non-cli top-level backendType (in-process) with clear REJECTED message", async () => {
      const res = await handleTeamCreate(
        {
          backendType: "in-process",
          inline_spec: validSoloSpec,
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("UNSUPPORTED_BACKEND_TYPE");
      expect(res.content[0].text).toContain("tmux/in-process REJECTED");
    });

    it("rejects tmux backendType specified in inline spec", async () => {
      const res = await handleTeamCreate(
        {
          inline_spec: {
            ...validSoloSpec,
            backendType: "tmux",
          },
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("UNSUPPORTED_BACKEND_TYPE");
      expect(res.content[0].text).toContain("tmux/in-process REJECTED");
    });

    it("rejects in-process backendType specified in inline spec", async () => {
      const res = await handleTeamCreate(
        {
          inline_spec: {
            ...validSoloSpec,
            backendType: "in-process",
          },
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("UNSUPPORTED_BACKEND_TYPE");
      expect(res.content[0].text).toContain("tmux/in-process REJECTED");
    });

    it("returns isError without throwing when spec validation fails (>8 members)", async () => {
      const tooManyMembers = Array.from({ length: 9 }, (_, i) => ({
        name: `agent-${i}`,
        role: "deep",
      }));

      const res = await handleTeamCreate(
        {
          name: "huge-team",
          leadAgentId: "agent-0",
          members: tooManyMembers,
        },
        ctx,
      );

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("TOO_MANY_MEMBERS");
    });
  });

  describe("T12: handleTeamList", () => {
    it("returns empty lists when no runs or named teams exist", async () => {
      const res = await handleTeamList({}, ctx);

      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Active Runs (0)");
      expect(res.content[0].text).toContain("Named Teams (0)");
    });

    it("lists active runs sorted newest first along with named teams", async () => {
      // 1. Create named team
      await saveNamedTeam(testDir, validPairSpec);

      // 2. Create two active team runs
      const create1 = await handleTeamCreate(
        { name: "team-alpha", inline_spec: { ...validSoloSpec, name: "team-alpha" } },
        ctx,
      );
      const parsed1 = JSON.parse(
        create1.content[0].text.slice(create1.content[0].text.indexOf("{")),
      );

      // Wait 15ms so timestamps differ
      await new Promise((r) => setTimeout(r, 15));

      const create2 = await handleTeamCreate(
        { name: "team-beta", inline_spec: { ...validPairSpec, name: "team-beta" } },
        ctx,
      );
      const parsed2 = JSON.parse(
        create2.content[0].text.slice(create2.content[0].text.indexOf("{")),
      );

      const res = await handleTeamList({}, ctx);
      expect(res.isError).toBeFalsy();

      const text = res.content[0].text;
      expect(text).toContain("Active Runs (2)");
      expect(text).toContain("Named Teams (1)");
      expect(text).toContain(parsed1.teamRunId);
      expect(text).toContain(parsed2.teamRunId);
      expect(text).toContain("pair-team");

      // Verify sort order: newer run (parsed2) appears before older run (parsed1)
      const idx2 = text.indexOf(parsed2.teamRunId);
      const idx1 = text.indexOf(parsed1.teamRunId);
      expect(idx2).toBeLessThan(idx1);
    });
  });

  describe("T12: handleTeamStatus", () => {
    it("returns isError when teamRunId is missing", async () => {
      const res = await handleTeamStatus({}, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_ARGUMENT");
    });

    it("returns isError when teamRunId does not exist", async () => {
      const res = await handleTeamStatus({ teamRunId: "team-does-not-exist" }, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("TEAM_NOT_FOUND");
    });

    it("returns comprehensive team status including member statuses, tasks, and transcript info", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validPairSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      // Add a task
      const rd = runDir(testDir, teamRunId);
      await createTask(rd, { subject: "Task 1", createdBy: "lead" });

      // Send a message to lead
      await sendMessage(testDir, teamRunId, "system", "lead", "Welcome lead");

      // Write mock transcript for lead
      const leadTranscript = path.join(rd, "transcript", "lead.jsonl");
      await fsp.mkdir(path.dirname(leadTranscript), { recursive: true });
      await fsp.writeFile(
        leadTranscript,
        '{"role":"assistant","content":"hello world"}\n',
        "utf-8",
      );

      const statusRes = await handleTeamStatus({ teamRunId }, ctx);
      expect(statusRes.isError).toBeFalsy();

      const text = statusRes.content[0].text;
      expect(text).toContain(`Team: ${teamRunId}`);
      expect(text).toContain("lead [idle]");
      expect(text).toContain("reviewer [idle]");

      const statusJson = JSON.parse(text.slice(text.indexOf("{")));
      expect(statusJson.teamRunId).toBe(teamRunId);
      expect(statusJson.memberCount).toBe(2);
      expect(statusJson.activeCount).toBe(0);
      expect(statusJson.taskCounts.pending).toBe(1);
      expect(statusJson.taskCounts.total).toBe(1);

      const leadMember = statusJson.members.find((m: { name: string }) => m.name === "lead");
      expect(leadMember).toBeDefined();
      expect(leadMember.transcriptAvailable).toBe(true);
      expect(leadMember.lastOutputTail).toContain("hello world");
      expect(leadMember.unreadMessages).toBe(1);

      const reviewerMember = statusJson.members.find(
        (m: { name: string }) => m.name === "reviewer",
      );
      expect(reviewerMember).toBeDefined();
      expect(reviewerMember.transcriptAvailable).toBe(false);
      expect(reviewerMember.unreadMessages).toBe(0);
    });

    it("supports team_id alias for teamRunId", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validSoloSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      const res = await handleTeamStatus({ team_id: teamRunId }, ctx);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain(teamRunId);
    });
  });

  describe("T12: handleTeamDelete", () => {
    it("returns isError when teamRunId is missing", async () => {
      const res = await handleTeamDelete({}, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("INVALID_ARGUMENT");
    });

    it("deletes the team run and cleans directory", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validSoloSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      const deleteRes = await handleTeamDelete({ teamRunId }, ctx);
      expect(deleteRes.isError).toBeFalsy();
      expect(deleteRes.content[0].text).toContain("deleted successfully");
      expect(deleteRes.content[0].text).toContain('"status": "deleted"');

      // Subsequent status check returns TEAM_NOT_FOUND
      const statusRes = await handleTeamStatus({ teamRunId }, ctx);
      expect(statusRes.isError).toBe(true);
      expect(statusRes.content[0].text).toContain("TEAM_NOT_FOUND");
    });

    it("is strictly idempotent when deleting a non-existent or already-deleted team", async () => {
      const res1 = await handleTeamDelete({ teamRunId: "team-already-gone" }, ctx);
      expect(res1.isError).toBeFalsy();
      expect(res1.content[0].text).toContain('"status": "deleted"');

      const res2 = await handleTeamDelete({ teamRunId: "team-already-gone" }, ctx);
      expect(res2.isError).toBeFalsy();
    });
  });

  describe("T13: Shutdown handlers (request, approve, reject)", () => {
    it("validates required arguments for shutdown request, approve, and reject", async () => {
      const reqMissing = await handleTeamShutdownRequest({}, ctx);
      expect(reqMissing.isError).toBe(true);
      expect(reqMissing.content[0].text).toContain("INVALID_ARGUMENT");

      const appMissing = await handleTeamShutdownApprove({ teamRunId: "t1" }, ctx);
      expect(appMissing.isError).toBe(true);
      expect(appMissing.content[0].text).toContain("INVALID_ARGUMENT");

      const rejMissing = await handleTeamShutdownReject(
        { teamRunId: "t1", targetMemberName: "lead" },
        ctx,
      );
      expect(rejMissing.isError).toBe(true);
      expect(rejMissing.content[0].text).toContain("Reason is required");
    });

    it("rejects shutdown transition for non-existent member", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validSoloSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      const res = await handleTeamShutdownRequest({ teamRunId, targetMemberName: "ghost" }, ctx);

      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("MEMBER_NOT_FOUND");
    });

    it("executes full request -> approve -> removed lifecycle", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validPairSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      // 1. Request shutdown for reviewer
      const reqRes = await handleTeamShutdownRequest(
        { teamRunId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(reqRes.isError).toBeFalsy();
      expect(reqRes.content[0].text).toContain("status: awaiting_shutdown");

      // Verify status reflects awaiting_shutdown
      const status1 = await handleTeamStatus({ teamRunId }, ctx);
      expect(status1.content[0].text).toContain("reviewer [awaiting_shutdown]");

      // 2. Approve shutdown for reviewer
      const appRes = await handleTeamShutdownApprove(
        { teamRunId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(appRes.isError).toBeFalsy();
      expect(appRes.content[0].text).toContain("status: removed");

      // Verify status reflects removed
      const status2 = await handleTeamStatus({ teamRunId }, ctx);
      expect(status2.content[0].text).toContain("reviewer [removed]");

      // 3. Attempting another approval throws illegal transition
      const illegalApp = await handleTeamShutdownApprove(
        { teamRunId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(illegalApp.isError).toBe(true);
      expect(illegalApp.content[0].text).toContain("INVALID_MEMBER_TRANSITION");
    });

    it("executes request -> reject -> idle cycle with mandatory reason", async () => {
      const createRes = await handleTeamCreate({ inline_spec: validSoloSpec }, ctx);
      const jsonStart = createRes.content[0].text.indexOf("{");
      const { teamRunId } = JSON.parse(createRes.content[0].text.slice(jsonStart));

      // 1. Request shutdown
      const reqRes = await handleTeamShutdownRequest({ teamRunId, targetMemberName: "lead" }, ctx);
      expect(reqRes.isError).toBeFalsy();
      expect(reqRes.content[0].text).toContain("awaiting_shutdown");

      // 2. Reject without reason fails
      const noReasonRes = await handleTeamShutdownReject(
        { teamRunId, targetMemberName: "lead", reason: "   " },
        ctx,
      );
      expect(noReasonRes.isError).toBe(true);
      expect(noReasonRes.content[0].text).toContain("Reason is required");

      // 3. Reject with reason restores to idle
      const rejRes = await handleTeamShutdownReject(
        {
          teamRunId,
          targetMemberName: "lead",
          reason: "Critical tasks still pending",
        },
        ctx,
      );
      expect(rejRes.isError).toBeFalsy();
      expect(rejRes.content[0].text).toContain("status: idle");
      expect(rejRes.content[0].text).toContain("Critical tasks still pending");

      // Verify status shows idle
      const statusRes = await handleTeamStatus({ teamRunId }, ctx);
      expect(statusRes.content[0].text).toContain("lead [idle]");
    });
  });

  describe("TEAM_HANDLERS dictionary map", () => {
    it("maps all expected tool names and aliases", () => {
      expect(TEAM_HANDLERS.team_create).toBe(handleTeamCreate);
      expect(TEAM_HANDLERS.team_list).toBe(handleTeamList);
      expect(TEAM_HANDLERS.team_status).toBe(handleTeamStatus);
      expect(TEAM_HANDLERS.team_delete).toBe(handleTeamDelete);
      expect(TEAM_HANDLERS.team_shutdown_request).toBe(handleTeamShutdownRequest);
      expect(TEAM_HANDLERS.team_approve_shutdown).toBe(handleTeamShutdownApprove);
      expect(TEAM_HANDLERS.team_shutdown_approve).toBe(handleTeamShutdownApprove);
      expect(TEAM_HANDLERS.team_reject_shutdown).toBe(handleTeamShutdownReject);
      expect(TEAM_HANDLERS.team_shutdown_reject).toBe(handleTeamShutdownReject);
    });

    it("can be invoked directly via TEAM_HANDLERS map", async () => {
      const res = await TEAM_HANDLERS.team_list({}, ctx);
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("Active Runs");
    });
  });

  describe("T23: End-to-End Full Lifecycle Matrix", () => {
    it("executes complete lifecycle: create (named + inline) -> status -> send_message -> task ops -> shutdown (request/reject/approve) -> delete", async () => {
      // 1. Create named team on disk and instantiate run
      await saveNamedTeam(testDir, validPairSpec);
      const createNamedRes = await handleTeamCreate({ name: "pair-team" }, ctx);
      expect(createNamedRes.isError).toBeFalsy();
      const parsedNamed = JSON.parse(
        createNamedRes.content[0].text.slice(createNamedRes.content[0].text.indexOf("{")),
      );
      expect(parsedNamed.status).toBe("creating");
      expect(parsedNamed.members).toEqual(["lead", "reviewer"]);

      // 2. Create inline team run
      const createInlineRes = await handleTeamCreate(
        {
          inline_spec: {
            ...validPairSpec,
            name: "e2e-team",
          },
        },
        ctx,
      );
      expect(createInlineRes.isError).toBeFalsy();
      const parsedInline = JSON.parse(
        createInlineRes.content[0].text.slice(createInlineRes.content[0].text.indexOf("{")),
      );
      const runId = parsedInline.teamRunId;

      // 3. Status check
      const statusRes1 = await handleTeamStatus({ teamRunId: runId }, ctx);
      expect(statusRes1.isError).toBeFalsy();
      expect(statusRes1.content[0].text).toContain("lead [idle]");
      expect(statusRes1.content[0].text).toContain("reviewer [idle]");

      // 4. Send messages (direct + broadcast)
      const msgRes1 = await handleSendMessage(
        {
          teamRunId: runId,
          from: "lead",
          to: "reviewer",
          body: "Start reviewing task",
        },
        ctx,
      );
      expect(msgRes1.isError).toBeFalsy();
      expect(msgRes1.content[0].text).toContain("delivered to 1 recipient(s)");

      const msgBroadcast = await handleSendMessage(
        {
          teamRunId: runId,
          from: "lead",
          to: "*",
          body: "Team wide notification",
        },
        ctx,
      );
      expect(msgBroadcast.isError).toBeFalsy();
      expect(msgBroadcast.content[0].text).toContain("delivered to 2 recipient(s)");

      // 5. Task operations: create -> list -> get -> claim -> in_progress -> completed
      const taskCreateRes = await handleTeamTaskCreate(
        {
          teamRunId: runId,
          subject: "Write end-to-end tests",
          description: "Full lifecycle validation",
        },
        ctx,
      );
      expect(taskCreateRes.isError).toBeFalsy();
      const createdTask = JSON.parse(
        taskCreateRes.content[0].text.slice(taskCreateRes.content[0].text.indexOf("{")),
      );
      expect(createdTask.status).toBe("pending");

      const taskListRes = await handleTeamTaskList({ teamRunId: runId }, ctx);
      expect(taskListRes.isError).toBeFalsy();
      expect(taskListRes.content[0].text).toContain(
        `- [pending] ${createdTask.id}: Write end-to-end tests`,
      );

      const taskGetRes = await handleTeamTaskGet({ teamRunId: runId, taskId: createdTask.id }, ctx);
      expect(taskGetRes.isError).toBeFalsy();
      expect(taskGetRes.content[0].text).toContain("Write end-to-end tests");

      const claimRes = await handleTeamTaskUpdate(
        {
          teamRunId: runId,
          taskId: createdTask.id,
          status: "claimed",
          owner: "reviewer",
        },
        ctx,
      );
      expect(claimRes.isError).toBeFalsy();
      expect(claimRes.content[0].text).toContain("status=claimed");

      const inProgRes = await handleTeamTaskUpdate(
        {
          teamRunId: runId,
          taskId: createdTask.id,
          status: "in_progress",
          owner: "reviewer",
        },
        ctx,
      );
      expect(inProgRes.isError).toBeFalsy();
      expect(inProgRes.content[0].text).toContain("status=in_progress");

      const compRes = await handleTeamTaskUpdate(
        {
          teamRunId: runId,
          taskId: createdTask.id,
          status: "completed",
          owner: "reviewer",
        },
        ctx,
      );
      expect(compRes.isError).toBeFalsy();
      expect(compRes.content[0].text).toContain("status=completed");

      // Verify status reflects completed task
      const statusRes2 = await handleTeamStatus({ teamRunId: runId }, ctx);
      expect(statusRes2.content[0].text).toContain("completed=1");

      // 6. Shutdown flow: request -> reject -> request -> approve
      const shutReq1 = await handleTeamShutdownRequest(
        { teamRunId: runId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(shutReq1.isError).toBeFalsy();
      expect(shutReq1.content[0].text).toContain("awaiting_shutdown");

      const shutRej = await handleTeamShutdownReject(
        {
          teamRunId: runId,
          targetMemberName: "reviewer",
          reason: "Need another verification pass",
        },
        ctx,
      );
      expect(shutRej.isError).toBeFalsy();
      expect(shutRej.content[0].text).toContain("status: idle");

      const shutReq2 = await handleTeamShutdownRequest(
        { teamRunId: runId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(shutReq2.isError).toBeFalsy();

      const shutApp = await handleTeamShutdownApprove(
        { teamRunId: runId, targetMemberName: "reviewer" },
        ctx,
      );
      expect(shutApp.isError).toBeFalsy();
      expect(shutApp.content[0].text).toContain("status: removed");

      // 7. Delete team run
      const delRes = await handleTeamDelete({ teamRunId: runId }, ctx);
      expect(delRes.isError).toBeFalsy();
      expect(delRes.content[0].text).toContain("deleted successfully");

      // Verify post-deletion status returns TEAM_NOT_FOUND error
      const postDelStatus = await handleTeamStatus({ teamRunId: runId }, ctx);
      expect(postDelStatus.isError).toBe(true);
      expect(postDelStatus.content[0].text).toContain("TEAM_NOT_FOUND");
    });
  });
});
