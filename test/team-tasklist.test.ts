import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createTask,
  getTask,
  listTasks,
  claimTask,
  updateTaskStatus,
  TeamError,
  AlreadyClaimedError,
  BlockedByError,
  InvalidTaskTransitionError,
  CrossOwnerUpdateError,
} from "../src/team/tasklist.js";
import { runDir as makeRunDir } from "../src/team/store.js";

describe("src/team/tasklist", () => {
  let testRoot: string;
  let runDir: string;
  const teamRunId = `run-${randomUUID()}`;

  beforeEach(async () => {
    testRoot = path.join(os.tmpdir(), `team-tasklist-test-${randomUUID()}`);
    runDir = makeRunDir(testRoot, teamRunId);
    await fs.mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("createTask & getTask", () => {
    it("creates a task with pending status and default fields", async () => {
      const task = await createTask(runDir, {
        subject: "Implement parser",
        description: "Parse input files",
        createdBy: "lead-agent",
      });

      expect(task.id).toBeDefined();
      expect(task.subject).toBe("Implement parser");
      expect(task.description).toBe("Parse input files");
      expect(task.status).toBe("pending");
      expect(task.owner).toBeNull();
      expect(task.blockedBy).toEqual([]);
      expect(task.createdBy).toBe("lead-agent");
      expect(typeof task.createdAt).toBe("number");
      expect(typeof task.updatedAt).toBe("number");

      const fetched = await getTask(runDir, task.id);
      expect(fetched).toEqual(task);
    });

    it("returns null for non-existent task id", async () => {
      const result = await getTask(runDir, randomUUID());
      expect(result).toBeNull();
    });

    it("rejects path traversal in getTask and createTask", async () => {
      await expect(getTask(runDir, "../escape")).rejects.toThrow(TeamError);
      await expect(
        createTask(runDir, {
          id: "../escape",
          subject: "traversal task",
        }),
      ).rejects.toThrow(TeamError);
    });

    it("throws TeamError if subject is empty", async () => {
      await expect(
        createTask(runDir, {
          subject: "",
        }),
      ).rejects.toThrow(TeamError);
    });
  });

  describe("claimTask", () => {
    it("claims a pending task atomically and sets owner and claimedAt", async () => {
      const task = await createTask(runDir, {
        subject: "Process batch",
      });

      const claimed = await claimTask(runDir, task.id, "worker-1");
      expect(claimed.status).toBe("claimed");
      expect(claimed.owner).toBe("worker-1");
      expect(typeof claimed.claimedAt).toBe("number");

      const stored = await getTask(runDir, task.id);
      expect(stored?.status).toBe("claimed");
      expect(stored?.owner).toBe("worker-1");
    });

    it("throws TeamError naming owner if owner is missing or empty", async () => {
      const task = await createTask(runDir, { subject: "Task A" });
      const err = await claimTask(runDir, task.id, "").catch((e) => e);
      expect(err).toBeInstanceOf(TeamError);
      expect(err.field).toBe("owner");
    });

    it("throws AlreadyClaimedError if task is already claimed", async () => {
      const task = await createTask(runDir, { subject: "Task B" });
      await claimTask(runDir, task.id, "worker-1");

      const err = await claimTask(runDir, task.id, "worker-2").catch((e) => e);
      expect(err).toBeInstanceOf(AlreadyClaimedError);
      expect(err).toBeInstanceOf(TeamError);
      expect(err.field).toBe("status");
    });

    it("blocks claiming if dependencies are not completed", async () => {
      const blocker = await createTask(runDir, { subject: "Blocker Task" });
      const blocked = await createTask(runDir, {
        subject: "Dependent Task",
        blockedBy: [blocker.id],
      });

      const err = await claimTask(runDir, blocked.id, "worker-1").catch((e) => e);
      expect(err).toBeInstanceOf(BlockedByError);
      expect(err).toBeInstanceOf(TeamError);
      expect(err.field).toBe("blockedBy");
      expect((err as BlockedByError).blockers).toEqual([blocker.id]);

      // Complete the blocker
      await claimTask(runDir, blocker.id, "worker-2");
      await updateTaskStatus(runDir, blocker.id, { status: "in_progress", owner: "worker-2" });
      await updateTaskStatus(runDir, blocker.id, { status: "completed", owner: "worker-2" });

      // Now claiming blocked task succeeds
      const claimed = await claimTask(runDir, blocked.id, "worker-1");
      expect(claimed.status).toBe("claimed");
      expect(claimed.owner).toBe("worker-1");
    });

    it("unblocks claiming if dependency was deleted", async () => {
      const blocker = await createTask(runDir, { subject: "Blocker to delete" });
      const blocked = await createTask(runDir, {
        subject: "Dependent Task 2",
        blockedBy: [blocker.id],
      });

      // Delete blocker
      await updateTaskStatus(runDir, blocker.id, { status: "deleted" });

      const claimed = await claimTask(runDir, blocked.id, "worker-1");
      expect(claimed.status).toBe("claimed");
      expect(claimed.owner).toBe("worker-1");
    });

    it("allows exactly one claimant in concurrent race (Promise.all)", async () => {
      const task = await createTask(runDir, { subject: "Raced Task" });

      const results = await Promise.allSettled([
        claimTask(runDir, task.id, "worker-alpha"),
        claimTask(runDir, task.id, "worker-beta"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winningTask = (fulfilled[0] as PromiseFulfilledResult<any>).value;
      expect(winningTask.status).toBe("claimed");
      expect(["worker-alpha", "worker-beta"]).toContain(winningTask.owner);

      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(rejectionReason).toBeInstanceOf(AlreadyClaimedError);
      expect(rejectionReason).toBeInstanceOf(TeamError);

      const diskTask = await getTask(runDir, task.id);
      expect(diskTask?.status).toBe("claimed");
      expect(diskTask?.owner).toBe(winningTask.owner);
    });
  });

  describe("updateTaskStatus", () => {
    it("supports the forward-only lifecycle: pending -> in_progress -> completed", async () => {
      const task = await createTask(runDir, { subject: "Lifecycle Task" });

      // Auto-claim pending -> in_progress with owner
      const inProgress = await updateTaskStatus(runDir, task.id, {
        status: "in_progress",
        owner: "worker-1",
      });
      expect(inProgress.status).toBe("in_progress");
      expect(inProgress.owner).toBe("worker-1");
      expect(typeof inProgress.claimedAt).toBe("number");

      // in_progress -> completed
      const completed = await updateTaskStatus(runDir, task.id, {
        status: "completed",
        owner: "worker-1",
      });
      expect(completed.status).toBe("completed");

      const onDisk = await getTask(runDir, task.id);
      expect(onDisk?.status).toBe("completed");
    });

    it("supports positional argument overload: updateTaskStatus(runDir, id, status, owner)", async () => {
      const task = await createTask(runDir, { subject: "Positional arg test" });
      await claimTask(runDir, task.id, "worker-1");

      const inProgress = await updateTaskStatus(runDir, task.id, "in_progress", "worker-1");
      expect(inProgress.status).toBe("in_progress");

      const completed = await updateTaskStatus(runDir, task.id, "completed", "worker-1");
      expect(completed.status).toBe("completed");
    });

    it("is idempotent when updating to current status", async () => {
      const task = await createTask(runDir, { subject: "Idempotency test" });
      await claimTask(runDir, task.id, "worker-1");

      const updated = await updateTaskStatus(runDir, task.id, {
        status: "claimed",
        owner: "worker-1",
      });
      expect(updated.status).toBe("claimed");
    });

    it("rejects illegal backward and forward jump transitions", async () => {
      const task = await createTask(runDir, { subject: "Transition test" });
      await claimTask(runDir, task.id, "worker-1");
      await updateTaskStatus(runDir, task.id, { status: "in_progress", owner: "worker-1" });
      await updateTaskStatus(runDir, task.id, { status: "completed", owner: "worker-1" });

      // completed -> claimed (illegal backward transition)
      await expect(
        updateTaskStatus(runDir, task.id, { status: "claimed", owner: "worker-1" }),
      ).rejects.toBeInstanceOf(InvalidTaskTransitionError);

      // completed -> in_progress (illegal backward transition)
      await expect(
        updateTaskStatus(runDir, task.id, { status: "in_progress", owner: "worker-1" }),
      ).rejects.toBeInstanceOf(InvalidTaskTransitionError);

      // completed -> pending (illegal backward transition)
      await expect(
        updateTaskStatus(runDir, task.id, { status: "pending", owner: "worker-1" }),
      ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
    });

    it("rejects cross-owner updates for non-deleted transitions", async () => {
      const task = await createTask(runDir, { subject: "Owner test" });
      await claimTask(runDir, task.id, "worker-1");

      // worker-2 attempts to move to in_progress
      const err = await updateTaskStatus(runDir, task.id, {
        status: "in_progress",
        owner: "worker-2",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(CrossOwnerUpdateError);
      expect(err).toBeInstanceOf(TeamError);
      expect(err.field).toBe("owner");

      // worker-1 succeeds
      const valid = await updateTaskStatus(runDir, task.id, {
        status: "in_progress",
        owner: "worker-1",
      });
      expect(valid.status).toBe("in_progress");
    });

    it("allows non-owner to delete tasks", async () => {
      const task = await createTask(runDir, { subject: "Deletion test" });
      await claimTask(runDir, task.id, "worker-1");

      const deleted = await updateTaskStatus(runDir, task.id, {
        status: "deleted",
        owner: "lead-admin",
      });
      expect(deleted.status).toBe("deleted");

      const onDisk = await getTask(runDir, task.id);
      expect(onDisk?.status).toBe("deleted");
    });
  });

  describe("listTasks", () => {
    it("returns tasks sorted by createdAt and filters out deleted tasks by default", async () => {
      const task1 = await createTask(runDir, { subject: "Task 1" });
      await new Promise((r) => setTimeout(r, 10));
      const task2 = await createTask(runDir, { subject: "Task 2" });
      await new Promise((r) => setTimeout(r, 10));
      const task3 = await createTask(runDir, { subject: "Task 3" });

      await updateTaskStatus(runDir, task2.id, { status: "deleted" });

      const activeTasks = await listTasks(runDir);
      expect(activeTasks.map((t) => t.id)).toEqual([task1.id, task3.id]);

      const allTasks = await listTasks(runDir, { includeDeleted: true });
      expect(allTasks.map((t) => t.id)).toEqual([task1.id, task2.id, task3.id]);
    });

    it("supports filtering by status and owner", async () => {
      const task1 = await createTask(runDir, { subject: "Task 1" });
      const task2 = await createTask(runDir, { subject: "Task 2" });
      await claimTask(runDir, task1.id, "worker-1");
      await claimTask(runDir, task2.id, "worker-2");

      const worker1Tasks = await listTasks(runDir, { owner: "worker-1" });
      expect(worker1Tasks.map((t) => t.id)).toEqual([task1.id]);

      const pendingTasks = await listTasks(runDir, { status: "pending" });
      expect(pendingTasks).toHaveLength(0);
    });

    it("returns empty array if tasks directory does not exist yet", async () => {
      const emptyDir = path.join(testRoot, "non-existent-run");
      const list = await listTasks(emptyDir);
      expect(list).toEqual([]);
    });
  });
});
