import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, readJson, withLock, TeamError as StoreTeamError } from "./store.js";

export type TaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "deleted";

export interface Task {
  id: string;
  teamRunId: string;
  subject: string;
  description: string;
  status: TaskStatus;
  createdBy: string;
  owner: string | null;
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
}

export interface CreateTaskInput {
  id?: string;
  teamRunId?: string;
  subject: string;
  description?: string;
  createdBy?: string;
  blockedBy?: string[];
  owner?: string | null;
  status?: TaskStatus;
}

export interface TaskListFilter {
  status?: TaskStatus;
  owner?: string;
  includeDeleted?: boolean;
}

export class TeamError extends StoreTeamError {
  readonly field?: string;
  readonly code?: string;

  constructor(message: string, field?: string, code?: string) {
    super(message);
    this.name = "TeamError";
    this.field = field;
    this.code = code;
  }
}

export class AlreadyClaimedError extends TeamError {
  constructor(message = "already_claimed") {
    super(message, "status", "ALREADY_CLAIMED");
    this.name = "AlreadyClaimedError";
  }
}

export class BlockedByError extends TeamError {
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(`blocked by ${blockers.join(",")}`, "blockedBy", "BLOCKED_BY");
    this.name = "BlockedByError";
    this.blockers = blockers;
  }
}

export class InvalidTaskTransitionError extends TeamError {
  readonly currentStatus: TaskStatus;
  readonly nextStatus: TaskStatus;

  constructor(currentStatus: TaskStatus, nextStatus: TaskStatus) {
    super(`no reverse transitions from ${currentStatus} to ${nextStatus}`, "status", "INVALID_TRANSITION");
    this.name = "InvalidTaskTransitionError";
    this.currentStatus = currentStatus;
    this.nextStatus = nextStatus;
  }
}

export class CrossOwnerUpdateError extends TeamError {
  constructor(message = "cross-owner updates are not allowed") {
    super(message, "owner", "CROSS_OWNER_UPDATE");
    this.name = "CrossOwnerUpdateError";
  }
}

export const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlyArray<TaskStatus>>> = {
  pending: ["claimed", "deleted"],
  claimed: ["in_progress", "deleted"],
  in_progress: ["completed", "deleted"],
  completed: ["deleted"],
  deleted: [],
};

export function isValidTransition(currentStatus: TaskStatus, nextStatus: TaskStatus): boolean {
  if (currentStatus === nextStatus) return true;
  return ALLOWED_TRANSITIONS[currentStatus]?.includes(nextStatus) ?? false;
}

function validateTaskId(id: string): void {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new TeamError("Task id is required", "id", "INVALID_ID");
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new TeamError(`Invalid task id: ${id}`, "id", "INVALID_ID");
  }
}

function getTaskFilePath(runDir: string, id: string): string {
  return path.join(runDir, "tasks", `${id}.json`);
}

function getLockFilePath(runDir: string): string {
  return path.join(runDir, "locks", "tasks.lock");
}

async function readAllTasksInternal(runDir: string): Promise<Task[]> {
  const tasksDir = path.join(runDir, "tasks");
  let entries: fsp.FileHandle extends any ? any[] : never;
  try {
    entries = await fsp.readdir(tasksDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const tasks: Task[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.startsWith(".") || !entry.name.endsWith(".json")) {
      continue;
    }
    const taskPath = path.join(tasksDir, entry.name);
    try {
      const task = await readJson<Task>(taskPath);
      if (task && typeof task === "object" && typeof task.id === "string") {
        tasks.push(task);
      }
    } catch {
      // skip malformed task files
    }
  }
  return tasks;
}

async function claimTaskInternal(runDir: string, id: string, owner: string): Promise<Task> {
  validateTaskId(id);
  const trimmedOwner = typeof owner === "string" ? owner.trim() : "";
  if (!trimmedOwner) {
    throw new TeamError("owner is required to claim task", "owner", "OWNER_REQUIRED");
  }

  const taskPath = getTaskFilePath(runDir, id);
  const task = await readJson<Task>(taskPath);
  if (!task) {
    throw new TeamError(`Task not found: ${id}`, "id", "NOT_FOUND");
  }

  if (task.status !== "pending") {
    throw new AlreadyClaimedError(`Task ${id} is not pending (status: ${task.status})`);
  }

  const allTasks = await readAllTasksInternal(runDir);
  const blockers = (task.blockedBy || []).filter((blockerId) => {
    const blocker = allTasks.find((t) => t.id === blockerId);
    return blocker && blocker.status !== "completed" && blocker.status !== "deleted";
  });

  if (blockers.length > 0) {
    throw new BlockedByError(blockers);
  }

  const now = Date.now();
  task.status = "claimed";
  task.owner = trimmedOwner;
  task.claimedAt = now;
  task.updatedAt = now;

  await atomicWriteJson(taskPath, task);
  return task;
}

export async function createTask(runDir: string, input: CreateTaskInput): Promise<Task> {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject) {
    throw new TeamError("subject is required", "subject", "SUBJECT_REQUIRED");
  }

  const id = input.id ?? randomUUID();
  validateTaskId(id);

  const lockPath = getLockFilePath(runDir);
  return withLock(lockPath, async () => {
    const taskPath = getTaskFilePath(runDir, id);
    const existing = await readJson<Task>(taskPath);
    if (existing) {
      throw new TeamError(`Task already exists: ${id}`, "id", "ALREADY_EXISTS");
    }

    const now = Date.now();
    const task: Task = {
      id,
      teamRunId: input.teamRunId ?? path.basename(runDir),
      subject,
      description: input.description ?? "",
      status: input.status ?? "pending",
      createdBy: input.createdBy ?? "",
      owner: input.owner ?? null,
      blockedBy: Array.isArray(input.blockedBy) ? [...input.blockedBy] : [],
      createdAt: now,
      updatedAt: now,
    };

    await atomicWriteJson(taskPath, task);
    return task;
  });
}

export async function getTask(runDir: string, id: string): Promise<Task | null> {
  validateTaskId(id);
  const taskPath = getTaskFilePath(runDir, id);
  return readJson<Task>(taskPath);
}

export async function listTasks(runDir: string, filter?: TaskListFilter): Promise<Task[]> {
  const allTasks = await readAllTasksInternal(runDir);

  return allTasks
    .filter((task) => {
      if (!filter?.includeDeleted && task.status === "deleted") {
        return false;
      }
      if (filter?.status !== undefined && task.status !== filter.status) {
        return false;
      }
      if (filter?.owner !== undefined && task.owner !== filter.owner) {
        return false;
      }
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export async function claimTask(runDir: string, id: string, owner: string): Promise<Task> {
  const lockPath = getLockFilePath(runDir);
  return withLock(lockPath, async () => {
    return claimTaskInternal(runDir, id, owner);
  });
}

export async function updateTaskStatus(
  runDir: string,
  id: string,
  statusOrOpts: TaskStatus | { status: TaskStatus; owner?: string },
  ownerArg?: string,
): Promise<Task> {
  validateTaskId(id);

  let newStatus: TaskStatus;
  let owner: string | undefined;

  if (typeof statusOrOpts === "object" && statusOrOpts !== null) {
    newStatus = statusOrOpts.status;
    owner = statusOrOpts.owner ?? ownerArg;
  } else {
    newStatus = statusOrOpts;
    owner = ownerArg;
  }

  const validStatuses: TaskStatus[] = ["pending", "claimed", "in_progress", "completed", "deleted"];
  if (!validStatuses.includes(newStatus)) {
    throw new TeamError(`Invalid task status: ${newStatus}`, "status", "INVALID_STATUS");
  }

  const lockPath = getLockFilePath(runDir);
  return withLock(lockPath, async () => {
    const taskPath = getTaskFilePath(runDir, id);
    const task = await readJson<Task>(taskPath);
    if (!task) {
      throw new TeamError(`Task not found: ${id}`, "id", "NOT_FOUND");
    }

    if (task.status === newStatus) {
      return task;
    }

    // Auto-claim if starting a pending task directly
    if (task.status === "pending" && (newStatus === "in_progress" || newStatus === "claimed")) {
      const claimedTask = await claimTaskInternal(runDir, id, owner ?? "");
      if (newStatus === "claimed") {
        return claimedTask;
      }
      task.status = claimedTask.status;
      task.owner = claimedTask.owner;
      task.claimedAt = claimedTask.claimedAt;
      task.updatedAt = claimedTask.updatedAt;
    }

    if (!isValidTransition(task.status, newStatus)) {
      throw new InvalidTaskTransitionError(task.status, newStatus);
    }

    if (newStatus !== "deleted") {
      if (task.owner && owner && task.owner !== owner) {
        throw new CrossOwnerUpdateError();
      }
      if (task.owner && !owner) {
        throw new CrossOwnerUpdateError("owner is required to update owned task");
      }
    }

    const now = Date.now();
    task.status = newStatus;
    task.updatedAt = now;
    if (owner && !task.owner) {
      task.owner = owner;
    }

    await atomicWriteJson(taskPath, task);
    return task;
  });
}
