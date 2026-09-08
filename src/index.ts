#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
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

  // Disk inspection for current project
  try {
    const runtimeDir = path.join(process.cwd(), ".omo", "runtime");
    if (fs.existsSync(runtimeDir)) {
      const entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const statePath = path.join(runtimeDir, entry.name, "state.json");
        if (fs.existsSync(statePath)) {
          try {
            const raw = fs.readFileSync(statePath, "utf8");
            const state = JSON.parse(raw) as { teamRunId?: string; status?: string };
            if (state?.teamRunId && state.status !== "deleted") {
              activeTeams.set(state.teamRunId, process.cwd());
            }
          } catch {}
        }
      }
    }
  } catch {}

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

if (!process.env.VITEST) {
  server
    .connect(new StdioServerTransport())
    .catch((err) => {
      console.error("agy-bridge failed to start:", err);
      process.exit(1);
    });
}
