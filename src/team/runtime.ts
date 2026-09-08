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

const execFileAsync = promisify(execFile);

export type MemberStatus = "idle" | "running" | "awaiting_shutdown" | "removed";

export const ALLOWED_MEMBER_TRANSITIONS: Readonly<
  Record<MemberStatus, ReadonlySet<MemberStatus>>
> = {
  idle: new Set(["running", "awaiting_shutdown"]),
  running: new Set(["idle", "awaiting_shutdown"]),
  awaiting_shutdown: new Set(["removed", "idle"]),
  removed: new Set(),
};

export function isValidMemberTransition(
  current: MemberStatus,
  next: MemberStatus,
): boolean {
  const allowed = ALLOWED_MEMBER_TRANSITIONS[current];
  return Boolean(allowed && allowed.has(next));
}

export function validateTransition(
  current: MemberStatus,
  next: MemberStatus,
): boolean {
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

export interface TeamRuntimeDeps {
  cooldowns?: TeamCooldownRegistry;
  cfg?: TeamRuntimeConfig;
  spawnWorktree?: (
    projectRoot: string,
    teamRunId: string,
    member: string,
  ) => Promise<WorktreeResult | string>;
  removeWorktrees?: (
    projectRoot: string,
    teamRunId: string,
    members: string[],
  ) => Promise<void>;
  runWake?: (options: WakeOptions) => Promise<WakeResult>;
  spawnChild?: (command: string, args: string[], options?: unknown) => Promise<unknown>;
  resolveModelChain?: (member: TeamRunMember) => string[];
  semaphore?: TeamSemaphore;
  onProgress?: (elapsedSec: number) => void;
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

export function resolveMemberWorktree(
  teamRunId: string,
  memberName: string,
): string {
  const tmp = fs.realpathSync(os.tmpdir());
  return path.join(
    tmp,
    `agy-bridge-team-${teamRunId}-${slugifyMemberName(memberName)}`,
  );
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
    await execFileAsync(
      "git",
      ["worktree", "add", "--detach", targetWorktreePath, "HEAD"],
      {
        cwd: projectRoot,
        timeout: 30_000,
      },
    );
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

export async function loadTeamState(
  projectRoot: string,
  teamRunId: string,
): Promise<TeamRunState> {
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

export class TeamRuntime {
  readonly deps: TeamRuntimeDeps;
  private readonly teamRoots = new Map<string, string>();

  constructor(deps: TeamRuntimeDeps = {}) {
    this.deps = deps;
  }

  async createTeam(
    arg1: unknown,
    arg2?: unknown,
  ): Promise<CreateTeamResult> {
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

  async loadState(
    projectRootOrTeamRunId: string,
    maybeTeamRunId?: string,
  ): Promise<TeamRunState> {
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

  async removeWorktrees(
    projectRoot: string,
    teamRunId: string,
    members: string[],
  ): Promise<void> {
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
    if (this.deps.semaphore) {
      await this.deps.semaphore.acquire();
    }

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
    const prompt = opts?.prompt ?? `Wake ${memberName}`;
    const transcriptPath = member.transcriptPath;
    // Use existing sessionId for conversation resume
    let conversationId = member.sessionId ?? undefined;

    try {
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
            prompt,
            model,
            conversationId,
            timeoutSec,
            signal: opts?.signal,
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
      if (this.deps.semaphore) {
        this.deps.semaphore.release();
      }

      // Reset status: if shutdown was requested mid-run → awaiting_shutdown; else → idle
      await updateTeamState(projectRoot, teamRunId, (s) => {
        const m = s.members.find((x) => x.name === memberName);
        if (m && m.status === "running") {
          m.status = "idle";
        }
        // If status was changed to awaiting_shutdown during the run, leave it
        return s;
      });
    }
  }

  // T9 buildWakePrompt stub seam
  buildWakePrompt(_member: unknown, _ctx: unknown): string {
    throw new Error("not implemented (T9: buildWakePrompt)");
  }

  // T10 loop stub seams
  startLoop(_projectRoot: string, _teamRunId: string): void {
    throw new Error("not implemented (T10: startLoop)");
  }

  stopLoop(_teamRunId: string): void {
    throw new Error("not implemented (T10: stopLoop)");
  }

  async deleteTeam(_projectRoot: string, _teamRunId: string): Promise<unknown> {
    throw new Error("not implemented (T10: deleteTeam)");
  }
}
