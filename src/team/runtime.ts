import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { QuotaError } from "../quota.js";
import {
  validateTeamSpec,
  TeamError,
  ROLE_ALIASES,
  type TeamSpec,
  type MemberSpec,
} from "./spec.js";
import {
  runDir,
  ensureRunDirs,
  atomicWriteJson,
  readJson,
  withLock,
  resolveReal,
} from "./store.js";
import { drainInbox, getInboxUnreadBytes, type Message } from "./mailbox.js";
import { listTasks, type Task } from "./tasklist.js";

const execFileAsync = promisify(execFile);

export type MemberStatus = "idle" | "running" | "awaiting_shutdown" | "removed";

export const ALLOWED_MEMBER_TRANSITIONS: Readonly<Record<MemberStatus, ReadonlySet<MemberStatus>>> =
  {
    idle: new Set(["running", "awaiting_shutdown"]),
    running: new Set(["idle", "awaiting_shutdown"]),
    awaiting_shutdown: new Set(["removed", "idle"]),
    removed: new Set(),
  };

export function isValidMemberTransition(current: MemberStatus, next: MemberStatus): boolean {
  const allowed = ALLOWED_MEMBER_TRANSITIONS[current];
  return Boolean(allowed && allowed.has(next));
}

export function validateTransition(current: MemberStatus, next: MemberStatus): boolean {
  if (!isValidMemberTransition(current, next)) {
    throw new TeamError(
      `Illegal member transition from '${current}' to '${next}'`,
      "status",
      "INVALID_MEMBER_TRANSITION",
    );
  }
  return true;
}

export interface TeamRunMember {
  name: string;
  kind: "category" | "subagent_type";
  resolvedRole: string;
  status: MemberStatus;
  lastWakeAt: number | null;
  sessionId: string | null;
  transcriptPath: string;
  worktreePath?: string;
  [key: string]: unknown;
}

export type TeamRunStatus =
  | "creating"
  | "active"
  | "shutdown_requested"
  | "deleting"
  | "deleted"
  | "failed";

export interface TeamRunState {
  teamRunId: string;
  spec: TeamSpec;
  projectRoot: string;
  createdAt: number;
  status: TeamRunStatus;
  members: TeamRunMember[];
  [key: string]: unknown;
}

export interface CreateTeamResult {
  teamRunId: string;
  status: "creating";
  runDir?: string;
  members?: string[];
  worktrees?: string[];
}

export interface ShutdownTransitionResult extends TeamRunMember {
  member: string;
}

export interface TeamCooldownRegistry {
  isCooled(model: string): boolean;
  set(model: string, resetSeconds: number): void;
  get(model: string): number | null;
}

export interface TeamRuntimeConfig {
  maxParallel?: number;
  teamMaxParallel?: number;
  teamMemberTimeoutSec?: number;
  pollIntervalMs?: number;
  teamPollMs?: number;
  killGraceMs?: number;
  [key: string]: unknown;
}

export interface WorktreeResult {
  worktreePath: string;
  cwd: string;
  sessionCwd: string;
}

export interface WakeOptions {
  member: string;
  projectRoot: string;
  teamRunId: string;
  cwd?: string;
  prompt: string;
  model: string;
  conversationId?: string;
  timeoutSec: number;
  signal?: AbortSignal;
  onProgress?: (elapsedSec: number) => void;
}

export interface WakeResult {
  output: string;
  sessionId: string | null;
  model: string | null;
}

export interface WakeMemberResult {
  ok: boolean;
  output?: string;
  sessionId?: string | null;
  model?: string | null;
  error?: string;
}

export interface TeamSemaphore {
  acquire(): Promise<void>;
  release(): void;
}

export class BoundedSemaphore implements TeamSemaphore {
  readonly cap: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(cap: number = 4) {
    if (cap < 1) {
      throw new TeamError("Semaphore capacity must be at least 1", "capacity", "INVALID_CAPACITY");
    }
    this.cap = cap;
  }

  get max(): number {
    return this.cap;
  }

  get currentActive(): number {
    return this.active;
  }

  get available(): number {
    return this.cap - this.active;
  }

  get queueLength(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    if (this.active <= 0) {
      throw new TeamError(
        "DOUBLE_RELEASE: semaphore already at cap",
        "semaphore",
        "DOUBLE_RELEASE",
      );
    }
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    } else {
      this.active--;
    }
  }
}

export interface TeamRuntimeDeps {
  cooldowns?: TeamCooldownRegistry;
  cfg?: TeamRuntimeConfig;
  spawnWorktree?: (
    projectRoot: string,
    teamRunId: string,
    member: string,
  ) => Promise<WorktreeResult | string>;
  removeWorktrees?: (projectRoot: string, teamRunId: string, members: string[]) => Promise<void>;
  runWake?: (options: WakeOptions) => Promise<WakeResult>;
  spawnChild?: (command: string, args: string[], options?: unknown) => Promise<unknown>;
  resolveModelChain?: (member: TeamRunMember) => string[];
  semaphore?: TeamSemaphore;
  onProgress?: (elapsedSec: number) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  [key: string]: unknown;
}

export function generateTeamRunId(): string {
  return `team-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

export function getStateLockPath(projectRoot: string, teamRunId: string): string {
  return path.join(runDir(projectRoot, teamRunId), "locks", "state.lock");
}

export function getStateFilePath(projectRoot: string, teamRunId: string): string {
  return path.join(runDir(projectRoot, teamRunId), "state.json");
}

export function slugifyMemberName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveMemberWorktree(teamRunId: string, memberName: string): string {
  const tmp = fs.realpathSync(os.tmpdir());
  return path.join(tmp, `agy-bridge-team-${teamRunId}-${slugifyMemberName(memberName)}`);
}

function safeResolveReal(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

async function isGitRepo(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
      timeout: 5_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function spawnWorktree(
  projectRoot: string,
  teamRunId: string,
  memberName: string,
): Promise<WorktreeResult> {
  const targetWorktreePath = resolveMemberWorktree(teamRunId, memberName);
  const parentDir = path.dirname(targetWorktreePath);
  await fsp.mkdir(parentDir, { recursive: true });

  try {
    await execFileAsync("git", ["worktree", "add", "--detach", targetWorktreePath, "HEAD"], {
      cwd: projectRoot,
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    const notGit =
      message.includes("not a git repository") ||
      message.includes("not a git work tree") ||
      !(await isGitRepo(projectRoot));

    if (notGit) {
      throw new TeamError(
        `Project root '${projectRoot}' is not a git repository: ${message}`,
        "projectRoot",
        "NOT_GIT_REPO",
      );
    }

    throw new TeamError(
      `Failed to spawn worktree for member '${memberName}': ${message}`,
      "worktree",
      "SPAWN_WORKTREE_FAILED",
    );
  }

  const realWorktree = safeResolveReal(targetWorktreePath);
  const realProjectRoot = safeResolveReal(projectRoot);

  return {
    worktreePath: realWorktree,
    cwd: realWorktree,
    sessionCwd: realProjectRoot,
  };
}

export async function removeWorktrees(
  projectRoot: string,
  teamRunId: string,
  memberNames: string[],
): Promise<void> {
  const errors: Array<{ member: string; error: Error }> = [];
  let attemptedCount = 0;

  for (const memberName of memberNames) {
    const worktreePath = path.isAbsolute(memberName)
      ? memberName
      : resolveMemberWorktree(teamRunId, memberName);

    let exists = false;
    try {
      await fsp.stat(worktreePath);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      try {
        await execFileAsync("git", ["worktree", "prune"], {
          cwd: projectRoot,
          timeout: 10_000,
        });
      } catch {
        // Prune failure ignored
      }
      continue;
    }

    attemptedCount++;
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: projectRoot,
        timeout: 30_000,
      });
    } catch (err: unknown) {
      errors.push({ member: memberName, error: err as Error });
    }

    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: projectRoot,
        timeout: 10_000,
      });
    } catch {
      // Prune error is non-fatal for individual removal
    }
  }

  if (attemptedCount > 0 && errors.length === attemptedCount) {
    throw new TeamError(
      `Failed to remove worktrees for all members: ${errors.map((e) => `${e.member}: ${e.error.message}`).join("; ")}`,
      "worktree",
      "REMOVE_WORKTREES_FAILED",
    );
  }
}

export async function getTeamState(
  projectRoot: string,
  teamRunId: string,
): Promise<TeamRunState | null> {
  const lockPath = getStateLockPath(projectRoot, teamRunId);
  const stateFile = getStateFilePath(projectRoot, teamRunId);
  return withLock(lockPath, async () => {
    return readJson<TeamRunState>(stateFile);
  });
}

export async function loadTeamState(projectRoot: string, teamRunId: string): Promise<TeamRunState> {
  const state = await getTeamState(projectRoot, teamRunId);
  if (!state) {
    throw new TeamError(
      `Team state not found for run '${teamRunId}' in '${projectRoot}'`,
      "teamRunId",
      "TEAM_NOT_FOUND",
    );
  }
  return state;
}

export async function updateTeamState(
  projectRoot: string,
  teamRunId: string,
  updater: (current: TeamRunState) => TeamRunState | Promise<TeamRunState>,
): Promise<TeamRunState> {
  const lockPath = getStateLockPath(projectRoot, teamRunId);
  const stateFile = getStateFilePath(projectRoot, teamRunId);
  return withLock(lockPath, async () => {
    const current = await readJson<TeamRunState>(stateFile);
    if (!current) {
      throw new TeamError(
        `Team state not found for run '${teamRunId}' in '${projectRoot}'`,
        "teamRunId",
        "TEAM_NOT_FOUND",
      );
    }
    const next = await updater(current);
    await atomicWriteJson(stateFile, next);
    return next;
  });
}

export async function buildWakePrompt(
  stateOrMember: unknown,
  memberNameOrCtx: unknown,
  cfg?: unknown,
): Promise<string> {
  if (!stateOrMember || typeof stateOrMember !== "object") {
    throw new TeamError(
      "State or member object is required for buildWakePrompt",
      "stateOrMember",
      "INVALID_ARGUMENT",
    );
  }

  let memberName = "";
  let resolvedRole = "worker";
  let teamRunId = "";
  let projectRoot = "";
  let state: TeamRunState | undefined;
  const cfgObj = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, any>;

  if (typeof memberNameOrCtx === "string") {
    // Calling convention 1: buildWakePrompt(state, memberName, cfg)
    memberName = memberNameOrCtx;
    state = stateOrMember as TeamRunState;
    teamRunId = state.teamRunId || "";
    projectRoot = state.projectRoot || cfgObj.projectRoot || "";
    const member = state.members?.find((m) => m.name === memberName);
    if (member) {
      resolvedRole = member.resolvedRole || (member as any).role || resolvedRole;
    }
  } else if (
    typeof (stateOrMember as any).name === "string" &&
    typeof memberNameOrCtx === "object"
  ) {
    // Calling convention 2: buildWakePrompt(member, ctx)
    const mem = stateOrMember as any;
    memberName = mem.name;
    resolvedRole = mem.resolvedRole || mem.role || resolvedRole;
    const ctx = (memberNameOrCtx || {}) as Record<string, any>;
    projectRoot = ctx.projectRoot || ctx.state?.projectRoot || cfgObj.projectRoot || "";
    teamRunId = ctx.teamRunId || ctx.state?.teamRunId || "";
    state = ctx.state;
  } else {
    // Calling convention 3: object options
    const ctx = (memberNameOrCtx || {}) as Record<string, any>;
    teamRunId = (stateOrMember as any).teamRunId || ctx.teamRunId || "";
    projectRoot = (stateOrMember as any).projectRoot || ctx.projectRoot || cfgObj.projectRoot || "";
    memberName = ctx.name || ctx.memberName || "";
    state = stateOrMember as TeamRunState;
    const member = state.members?.find((m) => m.name === memberName);
    if (member) {
      resolvedRole = member.resolvedRole || (member as any).role || resolvedRole;
    }
  }

  if (!memberName) {
    throw new TeamError(
      "Member name is required for buildWakePrompt",
      "memberName",
      "INVALID_ARGUMENT",
    );
  }

  if (state?.members && !state.members.some((m) => m.name === memberName)) {
    throw new TeamError(
      `Member '${memberName}' not found in team '${teamRunId}'`,
      "memberName",
      "MEMBER_NOT_FOUND",
    );
  }

  // 1. Drain inbox messages (oldest-first)
  let messages: Message[] = [];
  if (cfgObj.messages && Array.isArray(cfgObj.messages)) {
    messages = cfgObj.messages;
  } else if (projectRoot && teamRunId) {
    try {
      const rd = runDir(projectRoot, teamRunId);
      messages = await drainInbox(rd, memberName);
    } catch {
      messages = [];
    }
  }

  let inboxText = "(none)";
  if (messages.length > 0) {
    inboxText = messages
      .map((msg) => {
        const bodyStr = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body);
        return `FROM ${msg.from}: ${bodyStr}`;
      })
      .join("\n");
  }

  // 2. Owned tasks snapshot
  let tasks: Task[] = [];
  if (cfgObj.tasks && Array.isArray(cfgObj.tasks)) {
    tasks = cfgObj.tasks;
  } else if (projectRoot && teamRunId) {
    try {
      const rd = runDir(projectRoot, teamRunId);
      tasks = await listTasks(rd, { owner: memberName });
    } catch {
      tasks = [];
    }
  }

  const activeTasks = tasks.filter((t) => {
    const isOwner = !t.owner || t.owner === memberName;
    const isActiveStatus =
      t.status === "pending" || t.status === "in_progress" || t.status === "claimed";
    return isOwner && isActiveStatus;
  });

  let tasksText = "(none)";
  if (activeTasks.length > 0) {
    tasksText = activeTasks.map((t) => `- [${t.status}] ${t.id}: ${t.subject}`).join("\n");
  }

  return [
    `# TEAM CONTEXT`,
    `Team Run ID: ${teamRunId}`,
    `Member: ${memberName}`,
    `Role: ${resolvedRole}`,
    `Role Directive: You are ${memberName}, acting as ${resolvedRole}. Autonomously execute your role's responsibilities.`,
    ``,
    `## INBOX MESSAGES`,
    inboxText,
    ``,
    `## OWNED TASKS`,
    tasksText,
    ``,
    `## REPORT DIRECTIVE`,
    `When you complete work, reply with a concise report of what you did. Do not ask for permission to continue — work autonomously.`,
  ].join("\n");
}

export class TeamRuntime {
  readonly deps: TeamRuntimeDeps;
  private readonly teamRoots = new Map<string, string>();
  readonly semaphore: TeamSemaphore;
  private readonly loops = new Map<string, NodeJS.Timeout>();
  private readonly activeRuns = new Map<
    string,
    Set<{ promise: Promise<unknown>; controller: AbortController }>
  >();

  constructor(deps: TeamRuntimeDeps = {}) {
    this.deps = deps;
    // BoundedSemaphore is a constructor snapshot of cfg.teamMaxParallel;
    // changing the cap requires a new TeamRuntime (pollMs is read fresh per startLoop).
    this.semaphore =
      deps.semaphore ??
      new BoundedSemaphore(deps.cfg?.teamMaxParallel ?? deps.cfg?.maxParallel ?? 4);
  }

  async createTeam(arg1: unknown, arg2?: unknown): Promise<CreateTeamResult> {
    let specRaw: unknown;
    let projectRoot: string;

    if (typeof arg2 === "string") {
      specRaw = arg1;
      projectRoot = arg2;
    } else if (typeof arg1 === "string") {
      projectRoot = arg1;
      specRaw = arg2;
    } else {
      specRaw = arg1;
      projectRoot = String(arg2 ?? process.cwd());
    }

    const normalizedSpec = validateTeamSpec(specRaw);

    // Validate unique member names
    const seenNames = new Set<string>();
    for (const member of normalizedSpec.members) {
      if (seenNames.has(member.name)) {
        throw new TeamError(
          `Duplicate member name '${member.name}' in team spec`,
          "members",
          "DUPLICATE_MEMBER_NAME",
        );
      }
      seenNames.add(member.name);
    }

    const teamRunId = generateTeamRunId();
    const runDirectory = runDir(projectRoot, teamRunId);

    // Ensure directory layout: inboxes, tasks, transcript, locks
    await ensureRunDirs(
      projectRoot,
      teamRunId,
      normalizedSpec.members.map((m) => m.name),
    );
    await fsp.mkdir(path.join(runDirectory, "locks"), { recursive: true });

    // Build member run states
    const members: TeamRunMember[] = normalizedSpec.members.map((member: MemberSpec) => {
      const resolvedRole =
        member.kind === "category"
          ? member.category
          : (ROLE_ALIASES[member.subagent_type] ?? member.subagent_type);

      return {
        name: member.name,
        kind: member.kind,
        resolvedRole,
        status: "idle",
        lastWakeAt: null,
        sessionId: null,
        transcriptPath: path.join(runDirectory, "transcript", `${member.name}.jsonl`),
      };
    });

    const createdMemberNames: string[] = [];
    try {
      for (const member of members) {
        const wtResult = await this.spawnWorktree(projectRoot, teamRunId, member.name);
        const wtPath = typeof wtResult === "string" ? wtResult : wtResult.worktreePath;
        member.worktreePath = wtPath;
        createdMemberNames.push(member.name);
      }
    } catch (err) {
      if (createdMemberNames.length > 0) {
        try {
          await this.removeWorktrees(projectRoot, teamRunId, createdMemberNames);
        } catch {
          // Ignore rollback removal error so root cause spawn error is thrown
        }
      }
      throw err;
    }

    const state: TeamRunState = {
      teamRunId,
      spec: normalizedSpec,
      projectRoot,
      createdAt: Date.now(),
      status: "creating",
      members,
    };

    const stateFile = getStateFilePath(projectRoot, teamRunId);
    await atomicWriteJson(stateFile, state);

    this.teamRoots.set(teamRunId, projectRoot);

    return {
      teamRunId,
      status: "creating",
      runDir: runDirectory,
      members: normalizedSpec.members.map((m) => m.name),
      worktrees: members.map((m) => m.worktreePath as string).filter(Boolean),
    };
  }

  async getState(
    projectRootOrTeamRunId: string,
    maybeTeamRunId?: string,
  ): Promise<TeamRunState | null> {
    const { projectRoot, teamRunId } = this.resolveRootAndId(
      projectRootOrTeamRunId,
      maybeTeamRunId,
    );
    return getTeamState(projectRoot, teamRunId);
  }

  async loadState(projectRootOrTeamRunId: string, maybeTeamRunId?: string): Promise<TeamRunState> {
    const { projectRoot, teamRunId } = this.resolveRootAndId(
      projectRootOrTeamRunId,
      maybeTeamRunId,
    );
    return loadTeamState(projectRoot, teamRunId);
  }

  async updateState(
    projectRootOrTeamRunId: string,
    maybeTeamRunIdOrUpdater:
      | string
      | ((current: TeamRunState) => TeamRunState | Promise<TeamRunState>),
    maybeUpdater?: (current: TeamRunState) => TeamRunState | Promise<TeamRunState>,
  ): Promise<TeamRunState> {
    let projectRoot: string;
    let teamRunId: string;
    let updater: (current: TeamRunState) => TeamRunState | Promise<TeamRunState>;

    if (typeof maybeTeamRunIdOrUpdater === "function") {
      teamRunId = projectRootOrTeamRunId;
      projectRoot = this.teamRoots.get(teamRunId) ?? process.cwd();
      updater = maybeTeamRunIdOrUpdater;
    } else {
      projectRoot = projectRootOrTeamRunId;
      teamRunId = maybeTeamRunIdOrUpdater;
      updater = maybeUpdater!;
    }

    return updateTeamState(projectRoot, teamRunId, updater);
  }

  async requestShutdown(
    projectRootOrTeamRunId: string,
    teamRunIdOrMemberName: string,
    maybeMemberName?: string,
  ): Promise<ShutdownTransitionResult> {
    const { projectRoot, teamRunId, memberName } = this.resolveMemberArgs(
      projectRootOrTeamRunId,
      teamRunIdOrMemberName,
      maybeMemberName,
    );

    let updatedMember: TeamRunMember | undefined;
    await updateTeamState(projectRoot, teamRunId, (state) => {
      const member = state.members.find((m) => m.name === memberName);
      if (!member) {
        throw new TeamError(
          `Member '${memberName}' not found in team '${teamRunId}'`,
          "memberName",
          "MEMBER_NOT_FOUND",
        );
      }
      validateTransition(member.status, "awaiting_shutdown");
      member.status = "awaiting_shutdown";
      updatedMember = { ...member };
      return state;
    });

    return {
      member: updatedMember!.name,
      ...updatedMember!,
    };
  }

  async approveShutdown(
    projectRootOrTeamRunId: string,
    teamRunIdOrMemberName: string,
    maybeMemberName?: string,
  ): Promise<ShutdownTransitionResult> {
    const { projectRoot, teamRunId, memberName } = this.resolveMemberArgs(
      projectRootOrTeamRunId,
      teamRunIdOrMemberName,
      maybeMemberName,
    );

    let updatedMember: TeamRunMember | undefined;
    await updateTeamState(projectRoot, teamRunId, (state) => {
      const member = state.members.find((m) => m.name === memberName);
      if (!member) {
        throw new TeamError(
          `Member '${memberName}' not found in team '${teamRunId}'`,
          "memberName",
          "MEMBER_NOT_FOUND",
        );
      }
      validateTransition(member.status, "removed");
      member.status = "removed";
      updatedMember = { ...member };
      return state;
    });

    return {
      member: updatedMember!.name,
      ...updatedMember!,
    };
  }

  async rejectShutdown(
    projectRootOrTeamRunId: string,
    teamRunIdOrMemberName: string,
    maybeMemberNameOrReason?: string,
    _maybeReason?: string,
  ): Promise<ShutdownTransitionResult> {
    const { projectRoot, teamRunId, memberName } = this.resolveMemberArgs(
      projectRootOrTeamRunId,
      teamRunIdOrMemberName,
      maybeMemberNameOrReason,
    );

    let updatedMember: TeamRunMember | undefined;
    await updateTeamState(projectRoot, teamRunId, (state) => {
      const member = state.members.find((m) => m.name === memberName);
      if (!member) {
        throw new TeamError(
          `Member '${memberName}' not found in team '${teamRunId}'`,
          "memberName",
          "MEMBER_NOT_FOUND",
        );
      }
      validateTransition(member.status, "idle");
      member.status = "idle";
      updatedMember = { ...member };
      return state;
    });

    return {
      member: updatedMember!.name,
      ...updatedMember!,
    };
  }

  private resolveRootAndId(
    projectRootOrTeamRunId: string,
    maybeTeamRunId?: string,
  ): { projectRoot: string; teamRunId: string } {
    if (typeof maybeTeamRunId === "string") {
      return { projectRoot: projectRootOrTeamRunId, teamRunId: maybeTeamRunId };
    }
    const teamRunId = projectRootOrTeamRunId;
    const projectRoot = this.teamRoots.get(teamRunId) ?? process.cwd();
    return { projectRoot, teamRunId };
  }

  private resolveMemberArgs(
    arg1: string,
    arg2: string,
    arg3?: string,
  ): { projectRoot: string; teamRunId: string; memberName: string } {
    if (typeof arg3 === "string") {
      return { projectRoot: arg1, teamRunId: arg2, memberName: arg3 };
    }
    const teamRunId = arg1;
    const memberName = arg2;
    const projectRoot = this.teamRoots.get(teamRunId) ?? process.cwd();
    return { projectRoot, teamRunId, memberName };
  }

  // T7 worktree manager
  async spawnWorktree(
    projectRoot: string,
    teamRunId: string,
    member: string,
  ): Promise<WorktreeResult> {
    if (this.deps.spawnWorktree) {
      const res = await this.deps.spawnWorktree(projectRoot, teamRunId, member);
      if (typeof res === "string") {
        return {
          worktreePath: res,
          cwd: res,
          sessionCwd: safeResolveReal(projectRoot),
        };
      }
      return res;
    }
    return spawnWorktree(projectRoot, teamRunId, member);
  }

  async removeWorktrees(projectRoot: string, teamRunId: string, members: string[]): Promise<void> {
    if (this.deps.removeWorktrees) {
      return this.deps.removeWorktrees(projectRoot, teamRunId, members);
    }
    return removeWorktrees(projectRoot, teamRunId, members);
  }

  // T8 wakeMember — full implementation
  private async appendTranscript(
    transcriptPath: string,
    entry: Record<string, unknown>,
  ): Promise<void> {
    const dir = path.dirname(transcriptPath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(transcriptPath, JSON.stringify(entry) + "\n", "utf8");
  }

  async wakeMember(
    projectRoot: string,
    teamRunId: string,
    memberName: string,
    opts?: {
      prompt?: string;
      signal?: AbortSignal;
      onProgress?: (elapsedSec: number) => void;
    },
  ): Promise<WakeMemberResult> {
    // --- Load state and validate member ---
    const state = await loadTeamState(projectRoot, teamRunId);
    const member = state.members.find((m) => m.name === memberName);
    if (!member) {
      throw new TeamError(
        `Member '${memberName}' not found in team '${teamRunId}'`,
        "memberName",
        "MEMBER_NOT_FOUND",
      );
    }

    // Guard: removed members cannot be woken
    if (member.status === "removed") {
      throw new TeamError(
        `Member '${memberName}' has been removed and cannot be woken`,
        "memberName",
        "MEMBER_REMOVED",
      );
    }

    // Guard: no double-wake — member already running
    if (member.status === "running") {
      throw new TeamError(
        `Member '${memberName}' is already running (no double-wake)`,
        "memberName",
        "ALREADY_RUNNING",
      );
    }

    // --- Resolve model chain ---
    const modelChain: string[] = this.deps.resolveModelChain
      ? this.deps.resolveModelChain(member)
      : [member.resolvedRole];

    if (modelChain.length === 0) {
      throw new TeamError(
        `No models available in chain for member '${memberName}'`,
        "memberName",
        "NO_MODEL_CHAIN",
      );
    }

    // --- Acquire semaphore slot ---
    await this.semaphore.acquire();

    const abortController = new AbortController();
    if (opts?.signal) {
      if (opts.signal.aborted) {
        abortController.abort(opts.signal.reason);
      } else {
        opts.signal.addEventListener("abort", () => {
          abortController.abort(opts.signal?.reason);
        });
      }
    }

    let resolveRunPromise!: () => void;
    const runPromise = new Promise<void>((r) => {
      resolveRunPromise = r;
    });
    const runRecord = {
      promise: runPromise,
      controller: abortController,
    };

    if (!this.activeRuns.has(teamRunId)) {
      this.activeRuns.set(teamRunId, new Set());
    }
    const currentTeamRuns = this.activeRuns.get(teamRunId)!;
    currentTeamRuns.add(runRecord);

    try {
      // --- Mark member as running ---
      await updateTeamState(projectRoot, teamRunId, (s) => {
        const m = s.members.find((x) => x.name === memberName);
        if (m) {
          validateTransition(m.status, "running");
          m.status = "running";
          m.lastWakeAt = Date.now();
        }
        return s;
      });

      const timeoutSec = this.deps.cfg?.teamMemberTimeoutSec ?? 300;
      const prompt = opts?.prompt ?? (await this.buildWakePrompt(state, memberName));
      const transcriptPath = member.transcriptPath;
      // Use existing sessionId for conversation resume
      let conversationId = member.sessionId ?? undefined;
      // --- Chain failover loop ---
      const attempts: string[] = [];
      let result: WakeResult | null = null;
      let usedModel: string | null = null;

      for (const model of modelChain) {
        // Skip cooled-down models
        if (model && this.deps.cooldowns?.isCooled(model)) {
          attempts.push(`${model}: quota cooldown`);
          continue;
        }

        if (!this.deps.runWake) {
          throw new Error("deps.runWake is not configured");
        }

        try {
          result = await this.deps.runWake({
            member: memberName,
            projectRoot,
            teamRunId,
            cwd: member.worktreePath ?? projectRoot,
            prompt,
            model,
            conversationId,
            timeoutSec,
            signal: abortController.signal,
            onProgress: opts?.onProgress ?? this.deps.onProgress,
          });
          usedModel = model;
          break;
        } catch (err) {
          if (err instanceof QuotaError && model) {
            // Register cooldown for this model
            const resetSec = (err as QuotaError).resetSeconds;
            this.deps.cooldowns?.set(model, resetSec ?? 900);

            // Append failure line to transcript
            await this.appendTranscript(transcriptPath, {
              ts: Date.now(),
              kind: "error",
              model,
              error: `QuotaError: ${err.message}`,
              resetSeconds: resetSec,
            });

            attempts.push(`${model}: quota exhausted`);
            continue;
          }
          // Non-quota errors: log and rethrow
          await this.appendTranscript(transcriptPath, {
            ts: Date.now(),
            kind: "error",
            model,
            error: `${(err as Error).name}: ${(err as Error).message}`,
          });
          throw err;
        }
      }

      if (!result) {
        // All models exhausted
        const errMsg = `All models exhausted for member '${memberName}': ${attempts.join("; ")}`;
        await this.appendTranscript(transcriptPath, {
          ts: Date.now(),
          kind: "error",
          error: errMsg,
        });

        return { ok: false, error: errMsg };
      }

      // --- Success: persist sessionId + write transcript ---
      await updateTeamState(projectRoot, teamRunId, (s) => {
        const m = s.members.find((x) => x.name === memberName);
        if (m) {
          m.sessionId = result!.sessionId;
        }
        return s;
      });

      await this.appendTranscript(transcriptPath, {
        ts: Date.now(),
        kind: "output",
        model: usedModel,
        sessionId: result.sessionId,
        output: result.output,
      });

      return {
        ok: true,
        output: result.output,
        sessionId: result.sessionId,
        model: result.model ?? usedModel,
      };
    } finally {
      // --- ALWAYS: release semaphore + reset status ---
      this.semaphore.release();

      // Reset status: if shutdown was requested mid-run → awaiting_shutdown; else → idle
      try {
        await updateTeamState(projectRoot, teamRunId, (s) => {
          const m = s.members.find((x) => x.name === memberName);
          if (m && m.status === "running") {
            m.status = "idle";
          }
          // If status was changed to awaiting_shutdown during the run, leave it
          return s;
        });
      } catch {
        // Ignore error if team was already deleted concurrently
      }

      currentTeamRuns.delete(runRecord);
      if (currentTeamRuns.size === 0) {
        this.activeRuns.delete(teamRunId);
      }
      resolveRunPromise();
    }
  }

  async buildWakePrompt(
    stateOrMember: unknown,
    memberNameOrCtx: unknown,
    cfg?: unknown,
  ): Promise<string> {
    return buildWakePrompt(stateOrMember, memberNameOrCtx, cfg ?? this.deps.cfg);
  }

  startLoop(projectRootOrTeamRunId: string, maybeTeamRunId?: string): boolean {
    const { projectRoot, teamRunId } = this.resolveRootAndId(
      projectRootOrTeamRunId,
      maybeTeamRunId,
    );

    if (this.loops.has(teamRunId)) {
      return false;
    }

    const pollMs = this.deps.cfg?.teamPollMs ?? this.deps.cfg?.pollIntervalMs ?? 3000;

    const setIntervalFn = this.deps.setInterval ?? setInterval;

    const tick = async () => {
      let state: TeamRunState | null;
      try {
        state = await loadTeamState(projectRoot, teamRunId);
      } catch {
        this.stopLoop(teamRunId);
        return;
      }

      if (!state || state.status === "deleted") {
        this.stopLoop(teamRunId);
        return;
      }

      try {
        const rd = runDir(projectRoot, teamRunId);

        for (const member of state.members) {
          if (
            member.status === "awaiting_shutdown" ||
            member.status === "removed" ||
            member.status === "running"
          ) {
            continue;
          }

          const neverWoken = member.lastWakeAt == null;

          let hasUnread = false;
          try {
            const inboxDir = path.join(rd, "inboxes", member.name);
            hasUnread = (await getInboxUnreadBytes(inboxDir)) > 0;
          } catch {
            hasUnread = false;
          }

          let hasTasks = false;
          try {
            const tasks = await listTasks(rd, { owner: member.name });
            hasTasks = tasks.some(
              (t) => t.status === "pending" || t.status === "in_progress" || t.status === "claimed",
            );
          } catch {
            hasTasks = false;
          }

          if (neverWoken || hasUnread || hasTasks) {
            this.wakeMember(projectRoot, teamRunId, member.name).catch((_err) => {
              // Failures on one member never abort loop or other members
            });
          }
        }
      } catch {
        // Loop error, ignore so loop continues
      }
    };

    const handle = setIntervalFn(tick, pollMs);
    this.loops.set(teamRunId, handle as NodeJS.Timeout);
    return true;
  }

  stopLoop(projectRootOrTeamRunId: string, maybeTeamRunId?: string): boolean {
    const teamRunId = maybeTeamRunId ?? projectRootOrTeamRunId;
    const handle = this.loops.get(teamRunId);
    if (!handle) {
      return false;
    }
    const clearIntervalFn = this.deps.clearInterval ?? clearInterval;
    clearIntervalFn(handle);
    this.loops.delete(teamRunId);
    return true;
  }

  async deleteTeam(
    projectRootOrTeamRunId: string,
    maybeTeamRunId?: string,
  ): Promise<{ teamRunId: string; status: "deleted"; removedWorktrees: number }> {
    const { projectRoot, teamRunId } = this.resolveRootAndId(
      projectRootOrTeamRunId,
      maybeTeamRunId,
    );

    // (a) stopLoop
    this.stopLoop(teamRunId);

    // (b) abort all active runs
    const runs = this.activeRuns.get(teamRunId);
    if (runs) {
      for (const r of runs) {
        r.controller.abort("Team deleted");
      }
    }

    // (c) await Promise.allSettled(activeRuns) with 5000ms cap
    if (runs && runs.size > 0) {
      const promises = Array.from(runs).map((r) => r.promise);
      const killGraceMs = this.deps.cfg?.killGraceMs ?? 5000;
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((resolve) => setTimeout(resolve, killGraceMs)),
      ]);
    }

    // (d) removeWorktrees (best-effort per member)
    const rd = runDir(projectRoot, teamRunId);
    let memberNames: string[] = [];
    let removedWorktrees = 0;

    try {
      const state = await loadTeamState(projectRoot, teamRunId);
      memberNames = state.members.map((m) => m.name);
    } catch {
      try {
        const inboxesDir = path.join(rd, "inboxes");
        const entries = await fsp.readdir(inboxesDir);
        memberNames = entries.filter((e) => !e.startsWith(".") && !e.endsWith(".lock"));
      } catch {
        memberNames = [];
      }
    }

    if (memberNames.length > 0) {
      try {
        await this.removeWorktrees(projectRoot, teamRunId, memberNames);
        removedWorktrees = memberNames.length;
      } catch {
        // best-effort per member
      }
    }

    // (e) rm -rf runDir. Update state status -> 'deleted' before rm
    try {
      await updateTeamState(projectRoot, teamRunId, (s) => {
        s.status = "deleted";
        return s;
      });
    } catch {
      // ignore if state already gone
    }

    try {
      await fsp.rm(rd, { recursive: true, force: true });
    } catch {
      // ignore
    }

    this.teamRoots.delete(teamRunId);
    this.activeRuns.delete(teamRunId);

    return {
      teamRunId,
      status: "deleted",
      removedWorktrees,
    };
  }
}
