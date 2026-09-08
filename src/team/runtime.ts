import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
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
} from "./store.js";

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

export interface TeamRuntimeDeps {
  cooldowns?: TeamCooldownRegistry;
  cfg?: TeamRuntimeConfig;
  spawnWorktree?: (projectRoot: string, teamRunId: string, member: string) => Promise<string>;
  removeWorktrees?: (projectRoot: string, teamRunId: string, members: string[]) => Promise<void>;
  runWake?: (options: unknown) => Promise<unknown>;
  spawnChild?: (command: string, args: string[], options?: unknown) => Promise<unknown>;
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

  // T7 worktree stub seams
  async spawnWorktree(
    projectRoot: string,
    teamRunId: string,
    member: string,
  ): Promise<string> {
    if (this.deps.spawnWorktree) {
      return this.deps.spawnWorktree(projectRoot, teamRunId, member);
    }
    throw new Error("not implemented (T7: spawnWorktree)");
  }

  async removeWorktrees(
    projectRoot: string,
    teamRunId: string,
    members: string[],
  ): Promise<void> {
    if (this.deps.removeWorktrees) {
      return this.deps.removeWorktrees(projectRoot, teamRunId, members);
    }
    throw new Error("not implemented (T7: removeWorktrees)");
  }

  // T8 wakeMember stub seam
  async wakeMember(
    projectRoot: string,
    teamRunId: string,
    memberName: string,
  ): Promise<unknown> {
    if (this.deps.runWake) {
      return this.deps.runWake({ projectRoot, teamRunId, memberName });
    }
    throw new Error("not implemented (T8: wakeMember)");
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
