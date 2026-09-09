#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import {
  TeamRuntime,
  type TeamRuntimeConfig,
  type TeamRunMember,
} from "./team/runtime.js";
import { OMO_ROLES } from "./tools.js";
import { createServer, makeDefaultRunWake } from "./server.js";

const cfg = loadConfig();
export const runtime = new TeamRuntime({
  cfg: cfg as unknown as TeamRuntimeConfig,
  runWake: makeDefaultRunWake(cfg),
  resolveModelChain: (member: TeamRunMember) =>
    cfg.roleModels[member.resolvedRole] ??
    OMO_ROLES[member.resolvedRole]?.chain ??
    [member.resolvedRole],
});
export const server = createServer(runtime, cfg);

let draining = false;

export async function drainActiveTeams(
  rt: TeamRuntime = runtime,
  killGraceMs: number = cfg.teamKillGraceMs ?? 5000,
): Promise<void> {
  const activeTeams = new Map<string, string>(); // teamRunId -> projectRoot

  // In-memory runtime inspection
  const internalRt = rt as unknown as {
    teamRoots?: Map<string, string>;
    loops?: Map<string, NodeJS.Timeout>;
  };

  if (internalRt.teamRoots) {
    for (const [teamRunId, root] of internalRt.teamRoots.entries()) {
      activeTeams.set(teamRunId, root);
    }
  }

  if (internalRt.loops) {
    for (const teamRunId of internalRt.loops.keys()) {
      if (!activeTeams.has(teamRunId)) {
        activeTeams.set(teamRunId, internalRt.teamRoots?.get(teamRunId) ?? process.cwd());
      }
    }
  }

  const drains: Promise<unknown>[] = [];
  for (const [teamRunId, root] of activeTeams.entries()) {
    try {
      rt.stopLoop(root, teamRunId);
    } catch {}
    drains.push(rt.deleteTeam(root, teamRunId).catch(() => {}));
  }

  if (drains.length > 0) {
    await Promise.race([
      Promise.allSettled(drains),
      new Promise((resolve) => setTimeout(resolve, killGraceMs)),
    ]);
  }
}

export async function drainAndExit(code = 0, rt: TeamRuntime = runtime): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    await drainActiveTeams(rt);
  } catch {}

  process.exit(code);
}

// ponytail: register only in the real MCP entrypoint — importing this module
// from tests must not arm stdin-close drain (it wipes real .omo/runtime teams
// on disk when the vitest worker exits).
if (!process.env.VITEST) {
  process.on("SIGINT", () => {
    void drainAndExit(0);
  });

  process.on("SIGTERM", () => {
    void drainAndExit(0);
  });

  process.stdin.on("end", () => {
    void drainAndExit(0);
  });

  process.stdin.on("close", () => {
    void drainAndExit(0);
  });
}

if (!process.env.VITEST) {
  server
    .connect(new StdioServerTransport())
    .catch((err) => {
      console.error("agy-bridge failed to start:", err);
      process.exit(1);
    });
}
