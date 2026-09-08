import fsp from "node:fs/promises";
import path from "node:path";
import {
  TeamRuntime,
  type TeamRunState,
  type ShutdownTransitionResult,
  type CreateTeamResult,
} from "./runtime.js";
import {
  TeamError,
  validateTeamSpec,
  loadNamedTeam,
  listNamedTeams,
  type TeamSpec,
} from "./spec.js";
import { runDir, readJson } from "./store.js";
import { listTasks, type Task } from "./tasklist.js";
import { getInboxUnreadBytes } from "./mailbox.js";

export interface TeamHandlerContext {
  projectRoot: string;
  runtime: TeamRuntime;
}

export interface TeamToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type TeamHandlerFn = (
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
) => Promise<TeamToolResponse>;

function resolveContext(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): TeamHandlerContext {
  const projectRoot =
    ctx?.projectRoot ??
    (typeof args.cwd === "string" && args.cwd.trim().length > 0
      ? args.cwd.trim()
      : process.cwd());
  const runtime = ctx?.runtime ?? new TeamRuntime();
  return { projectRoot, runtime };
}

function formatErrorResponse(err: unknown): TeamToolResponse {
  if (
    err instanceof TeamError ||
    (err && typeof err === "object" && (err as { name?: string }).name === "TeamError")
  ) {
    const teamErr = err as { code?: string; message: string };
    const code = teamErr.code ?? "TeamError";
    return {
      content: [{ type: "text", text: `${code}: ${teamErr.message}` }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * T11: handleTeamCreate
 * Resolves named spec or inline spec/members, enforces 'cli' backend,
 * calls runtime.createTeam, triggers background loop, and immediately
 * returns creating status without awaiting member executions.
 */
export async function handleTeamCreate(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    // Reject non-cli backend early
    const topBackendType = args.backendType ?? args.backend_type;
    if (topBackendType !== undefined && topBackendType !== "cli") {
      return {
        content: [
          {
            type: "text",
            text: `UNSUPPORTED_BACKEND_TYPE: tmux/in-process REJECTED: agy-bridge only supports 'cli' subprocess backend (got '${String(topBackendType)}')`,
          },
        ],
        isError: true,
      };
    }

    let rawSpec: unknown;

    if (args.inline_spec !== undefined || args.spec !== undefined) {
      const inline = args.inline_spec ?? args.spec;
      if (typeof inline === "string") {
        try {
          rawSpec = JSON.parse(inline);
        } catch (parseErr) {
          return {
            content: [
              {
                type: "text",
                text: `INVALID_JSON: Failed to parse inline spec JSON: ${(parseErr as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      } else {
        rawSpec = inline;
      }
    } else if (Array.isArray(args.members)) {
      const name =
        (args.name as string | undefined) ??
        (args.teamName as string | undefined) ??
        `team-${Date.now()}`;
      const leadAgentId =
        (args.leadAgentId as string | undefined) ??
        (args.lead_agent_id as string | undefined);

      const normalizedMembers = args.members.map((m) => {
        if (typeof m === "string") {
          return { name: m, kind: "category", category: "engineering" };
        }
        return m;
      });

      rawSpec = {
        name,
        description: args.description as string | undefined,
        leadAgentId:
          leadAgentId ??
          (normalizedMembers.length === 1 && typeof normalizedMembers[0] === "object" && normalizedMembers[0] !== null
            ? (normalizedMembers[0] as { name?: string }).name
            : undefined),
        backendType: (topBackendType as string | undefined) ?? "cli",
        members: normalizedMembers,
      };
    } else if (
      (typeof args.name === "string" && args.name.trim().length > 0) ||
      (typeof args.teamName === "string" && args.teamName.trim().length > 0)
    ) {
      const name = ((args.name as string) ?? (args.teamName as string)).trim();
      const loaded = await loadNamedTeam(projectRoot, name);
      if (!loaded) {
        return {
          content: [
            {
              type: "text",
              text: `TEAM_SPEC_NOT_FOUND: Named team spec '${name}' not found in project ${projectRoot}`,
            },
          ],
          isError: true,
        };
      }
      rawSpec = loaded;
    } else {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: Must provide either named team 'name' or inline spec ('inline_spec' / 'members')",
          },
        ],
        isError: true,
      };
    }

    if (rawSpec && typeof rawSpec === "object") {
      const specObj = rawSpec as Record<string, unknown>;
      if (specObj.backendType !== undefined && specObj.backendType !== "cli") {
        return {
          content: [
            {
              type: "text",
              text: `UNSUPPORTED_BACKEND_TYPE: tmux/in-process REJECTED: agy-bridge only supports 'cli' subprocess backend (got '${String(specObj.backendType)}')`,
            },
          ],
          isError: true,
        };
      }
    }

    const validatedSpec: TeamSpec = validateTeamSpec(rawSpec);

    const result: CreateTeamResult = await runtime.createTeam(
      validatedSpec,
      projectRoot,
    );

    // Start background wake loop (non-blocking)
    runtime.startLoop(projectRoot, result.teamRunId);

    const payload = {
      teamRunId: result.teamRunId,
      status: result.status,
      runDir: result.runDir,
      members: result.members ?? [],
      worktrees: result.worktrees ?? [],
      loopStarted: true,
    };

    return {
      content: [
        {
          type: "text",
          text:
            `[team_create] Team run created: ${result.teamRunId}\n` +
            `Status: ${result.status}\n` +
            `Members: ${(result.members ?? []).join(", ")}\n` +
            `Run directory: ${result.runDir}\n` +
            `Loop: started\n\n` +
            JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T12: handleTeamList
 * Scans active runs from .omo/runtime and named team configs from .omo/teams.
 * Returns sorted active runs and named specs.
 */
export async function handleTeamList(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot } = resolveContext(args, ctx);

    // 1. Scan active runs from .omo/runtime
    const runtimeDir = path.join(projectRoot, ".omo", "runtime");
    const activeRuns: Array<{
      teamRunId: string;
      name?: string;
      status: string;
      memberCount: number;
      createdAt: number;
    }> = [];

    try {
      const entries = await fsp.readdir(runtimeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateFile = path.join(runtimeDir, entry.name, "state.json");
        try {
          const state = await readJson<TeamRunState>(stateFile);
          if (state && typeof state === "object" && state.teamRunId) {
            activeRuns.push({
              teamRunId: state.teamRunId,
              name: state.spec?.name,
              status: state.status,
              memberCount: Array.isArray(state.members) ? state.members.length : 0,
              createdAt: typeof state.createdAt === "number" ? state.createdAt : 0,
            });
          }
        } catch {
          // ignore corrupted/partially-written states
        }
      }
    } catch {
      // .omo/runtime might not exist yet
    }

    activeRuns.sort((a, b) => b.createdAt - a.createdAt);

    // 2. Scan named team specs from .omo/teams
    const namedTeamsList = await listNamedTeams(projectRoot);
    const namedTeams = namedTeamsList.map((t) => ({
      name: t.name,
      members: t.members.map((m) => m.name),
      leadAgentId: t.leadAgentId,
      backendType: t.backendType,
      source: path.join(projectRoot, ".omo", "teams", t.name, "config.json"),
    }));

    const payload = {
      activeRuns,
      namedTeams,
    };

    const activeRunsText =
      activeRuns.length === 0
        ? "  (none)\n"
        : activeRuns
            .map(
              (r) =>
                `  - ${r.teamRunId} [${r.status}] name=${r.name ?? "unnamed"} members=${r.memberCount}`,
            )
            .join("\n") + "\n";

    const namedTeamsText =
      namedTeams.length === 0
        ? "  (none)\n"
        : namedTeams
            .map((t) => `  - ${t.name} (members: ${t.members.join(", ")})`)
            .join("\n") + "\n";

    return {
      content: [
        {
          type: "text",
          text:
            `[team_list]\nActive Runs (${activeRuns.length}):\n${activeRunsText}` +
            `\nNamed Teams (${namedTeams.length}):\n${namedTeamsText}\n` +
            JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T12: handleTeamStatus
 * Reads state.json for teamRunId, calculates wall-clock elapsed,
 * reports per-member status, transcript availability and output tail,
 * task counts by status, and inbox unread message counts.
 */
export async function handleTeamStatus(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    const rawId = (args.teamRunId ?? args.team_id) as string | undefined;
    if (!rawId || typeof rawId !== "string" || rawId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: teamRunId is required",
          },
        ],
        isError: true,
      };
    }

    const teamRunId = rawId.trim();
    const state = await runtime.loadState(projectRoot, teamRunId);

    const now = Date.now();
    const wallClockMs = Math.max(0, now - (state.createdAt ?? now));
    const memberCount = state.members.length;
    const activeCount = state.members.filter((m) => m.status === "running").length;

    const rd = runDir(projectRoot, teamRunId);

    // Read task statistics
    const taskCounts: Record<string, number> = {
      pending: 0,
      claimed: 0,
      in_progress: 0,
      completed: 0,
      deleted: 0,
      total: 0,
    };
    try {
      const tasks: Task[] = await listTasks(rd, { includeDeleted: true });
      taskCounts.total = tasks.length;
      for (const t of tasks) {
        taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
      }
    } catch {
      // tasks directory might not exist yet
    }

    // Process per-member summaries
    let totalUnreadMessages = 0;
    const memberSummaries = await Promise.all(
      state.members.map(async (member) => {
        let transcriptAvailable = false;
        let lastOutputTail: string | null = null;

        if (member.transcriptPath) {
          try {
            await fsp.access(member.transcriptPath);
            transcriptAvailable = true;
            const content = await fsp.readFile(member.transcriptPath, "utf-8");
            lastOutputTail = content.length > 500 ? content.slice(-500) : content;
          } catch {
            // transcript file does not exist or cannot be read
          }
        }

        const memberInbox = path.join(rd, "inboxes", member.name);
        let unreadCount = 0;
        let unreadBytes = 0;

        try {
          const entries = await fsp.readdir(memberInbox, { withFileTypes: true });
          for (const entry of entries) {
            if (
              entry.isFile() &&
              entry.name.endsWith(".json") &&
              !entry.name.startsWith(".") &&
              !entry.name.includes(".tmp.")
            ) {
              unreadCount++;
            }
          }
          unreadBytes = await getInboxUnreadBytes(memberInbox);
        } catch {
          // inbox dir may not exist
        }

        totalUnreadMessages += unreadCount;

        return {
          name: member.name,
          kind: member.kind,
          role: member.resolvedRole,
          status: member.status,
          lastWakeAt: member.lastWakeAt,
          sessionId: member.sessionId,
          worktreePath: member.worktreePath,
          transcriptAvailable,
          lastOutputTail: lastOutputTail || undefined,
          unreadMessages: unreadCount,
          unreadBytes,
        };
      }),
    );

    const summary = {
      teamRunId: state.teamRunId,
      name: state.spec.name,
      status: state.status,
      createdAt: state.createdAt,
      wallClockMs,
      wallClockElapsed: `${Math.floor(wallClockMs / 1000)}s`,
      memberCount,
      activeCount,
      taskCounts,
      totalUnreadMessages,
      members: memberSummaries,
    };

    const membersText = memberSummaries
      .map(
        (m) =>
          `  - ${m.name} [${m.status}] role=${m.role} wake=${m.lastWakeAt ?? "never"} unread=${m.unreadMessages}`,
      )
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            `[team_status] Team: ${state.teamRunId} (${state.spec.name})\n` +
            `Status: ${state.status} | Active: ${activeCount}/${memberCount} | Wall-clock: ${Math.round(wallClockMs / 1000)}s\n` +
            `Tasks: total=${taskCounts.total} pending=${taskCounts.pending} claimed=${taskCounts.claimed} in_progress=${taskCounts.in_progress} completed=${taskCounts.completed}\n\n` +
            `Members:\n${membersText}\n\n` +
            JSON.stringify(summary, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T12: handleTeamDelete
 * Invokes runtime.deleteTeam (stops loop, aborts runs, cleans worktrees, removes runDir).
 * Completely idempotent.
 */
export async function handleTeamDelete(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    const rawId = (args.teamRunId ?? args.team_id) as string | undefined;
    if (!rawId || typeof rawId !== "string" || rawId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: teamRunId is required",
          },
        ],
        isError: true,
      };
    }

    const teamRunId = rawId.trim();
    const result = await runtime.deleteTeam(projectRoot, teamRunId);

    return {
      content: [
        {
          type: "text",
          text:
            `[team_delete] Team run '${teamRunId}' deleted successfully.\n` +
            JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T13: handleTeamShutdownRequest
 * Transitions member from idle/running -> awaiting_shutdown.
 */
export async function handleTeamShutdownRequest(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    const rawId = (args.teamRunId ?? args.team_id) as string | undefined;
    if (!rawId || typeof rawId !== "string" || rawId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: teamRunId is required",
          },
        ],
        isError: true,
      };
    }

    const rawMember = (args.targetMemberName ??
      args.memberName ??
      args.member) as string | undefined;
    if (!rawMember || typeof rawMember !== "string" || rawMember.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: targetMemberName is required",
          },
        ],
        isError: true,
      };
    }

    const teamRunId = rawId.trim();
    const memberName = rawMember.trim();

    const result: ShutdownTransitionResult = await runtime.requestShutdown(
      projectRoot,
      teamRunId,
      memberName,
    );

    return {
      content: [
        {
          type: "text",
          text:
            `[team_shutdown_request] Member '${result.member}' shutdown requested (status: ${result.status}).\n` +
            JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T13: handleTeamShutdownApprove
 * Transitions member from awaiting_shutdown -> removed.
 */
export async function handleTeamShutdownApprove(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    const rawId = (args.teamRunId ?? args.team_id) as string | undefined;
    if (!rawId || typeof rawId !== "string" || rawId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: teamRunId is required",
          },
        ],
        isError: true,
      };
    }

    const rawMember = (args.targetMemberName ??
      args.memberName ??
      args.member) as string | undefined;
    if (!rawMember || typeof rawMember !== "string" || rawMember.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: targetMemberName is required",
          },
        ],
        isError: true,
      };
    }

    const teamRunId = rawId.trim();
    const memberName = rawMember.trim();

    const result: ShutdownTransitionResult = await runtime.approveShutdown(
      projectRoot,
      teamRunId,
      memberName,
    );

    return {
      content: [
        {
          type: "text",
          text:
            `[team_approve_shutdown] Member '${result.member}' shutdown approved (status: ${result.status}).\n` +
            JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * T13: handleTeamShutdownReject
 * Requires reason. Transitions member from awaiting_shutdown -> idle.
 */
export async function handleTeamShutdownReject(
  args: Record<string, unknown>,
  ctx?: TeamHandlerContext,
): Promise<TeamToolResponse> {
  try {
    const { projectRoot, runtime } = resolveContext(args, ctx);

    const rawId = (args.teamRunId ?? args.team_id) as string | undefined;
    if (!rawId || typeof rawId !== "string" || rawId.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: teamRunId is required",
          },
        ],
        isError: true,
      };
    }

    const rawMember = (args.targetMemberName ??
      args.memberName ??
      args.member) as string | undefined;
    if (!rawMember || typeof rawMember !== "string" || rawMember.trim().length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: targetMemberName is required",
          },
        ],
        isError: true,
      };
    }

    const reason = args.reason;
    if (
      reason === undefined ||
      reason === null ||
      typeof reason !== "string" ||
      reason.trim().length === 0
    ) {
      return {
        content: [
          {
            type: "text",
            text: "INVALID_ARGUMENT: Reason is required to reject shutdown",
          },
        ],
        isError: true,
      };
    }

    const teamRunId = rawId.trim();
    const memberName = rawMember.trim();
    const trimmedReason = reason.trim();

    const result: ShutdownTransitionResult = await runtime.rejectShutdown(
      projectRoot,
      teamRunId,
      memberName,
      trimmedReason,
    );

    return {
      content: [
        {
          type: "text",
          text:
            `[team_reject_shutdown] Member '${result.member}' shutdown rejected (status: ${result.status}). Reason: ${trimmedReason}\n` +
            JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

/**
 * TEAM_HANDLERS map for MCP server registration
 */
export const TEAM_HANDLERS: Record<string, TeamHandlerFn> = {
  team_create: handleTeamCreate,
  team_list: handleTeamList,
  team_status: handleTeamStatus,
  team_delete: handleTeamDelete,
  team_shutdown_request: handleTeamShutdownRequest,
  team_approve_shutdown: handleTeamShutdownApprove,
  team_shutdown_approve: handleTeamShutdownApprove,
  team_reject_shutdown: handleTeamShutdownReject,
  team_shutdown_reject: handleTeamShutdownReject,
};
