import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { ModelRegistry } from "./models.js";
import {
  runAgy,
  defaultDeps,
  execWithClosedStdin,
  IdleStallError,
  type RunnerDeps,
  type RunResult,
} from "./runner.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { TOOLS, OMO_ROLES, type ToolDef } from "./tools.js";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
  _meta?: {
    progressToken?: number | string;
  };
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  registry: ModelRegistry,
  deps: RunnerDeps = defaultDeps,
  cooldowns: CooldownRegistry = new CooldownRegistry(),
  server?: McpServer,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  return async (args, extra) => {
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();

      if (tool.name === "get_session_status") {
        let sessionId: string | undefined;
        try {
          const map = JSON.parse(await deps.readSessionsFile()) as Record<string, string>;
          sessionId = map[path.resolve(cwd)] ?? map[cwd];
        } catch {}
        if (!sessionId) {
          return {
            content: [
              {
                type: "text",
                text: `[agy-bridge] No prior agy session recorded for directory: ${cwd}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `[agy-bridge] Active Session for ${cwd}:\n` +
                `- session_id: ${sessionId}\n` +
                `- Status: Ready for follow_up\n` +
                `- Tip: Call 'follow_up' (session_id is optional) to continue this conversation without resending context.`,
            },
          ],
        };
      }

      if (tool.name === "list_sessions") {
        let map: Record<string, string> = {};
        try {
          map = JSON.parse(await deps.readSessionsFile()) as Record<string, string>;
        } catch {}

        const entries = Object.entries(map);
        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "[agy-bridge] No recorded Antigravity sessions found." }],
          };
        }

        const lines: string[] = ["### 📋 Antigravity Sessions List\n"];
        const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");

        for (const [projPath, sessionId] of entries) {
          const isCurrent = path.resolve(cwd) === path.resolve(projPath);
          const transcriptPath = path.join(
            brainDir,
            sessionId,
            ".system_generated",
            "logs",
            "transcript.jsonl",
          );
          let lastActive = "Unknown";
          let totalSteps = "N/A";

          if (fs.existsSync(transcriptPath)) {
            try {
              const stat = fs.statSync(transcriptPath);
              lastActive = new Date(stat.mtimeMs).toLocaleString();
              const buf = fs.readFileSync(transcriptPath, "utf8");
              const stepCount = buf.trim().split("\n").length;
              totalSteps = `${stepCount} steps`;
            } catch {}
          }

          lines.push(`- **${sessionId}** ${isCurrent ? "👉 *(CURRENT PROJECT)*" : ""}`);
          lines.push(`  - **Project Directory**: \`${projPath}\``);
          lines.push(`  - **Last Active**: ${lastActive} (${totalSteps})`);
          lines.push(`  - **Resume Command**: \`follow_up(session_id: "${sessionId}", question: "...")\``);
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      let conversationId = args.session_id as string | undefined;
      if ((!conversationId || conversationId === "latest") && tool.name === "follow_up") {
        try {
          const map = JSON.parse(await deps.readSessionsFile()) as Record<string, string>;
          conversationId = map[path.resolve(cwd)] ?? map[cwd];
        } catch {}
        if (!conversationId) {
          throw new Error(
            `No prior agy session found for directory "${cwd}". Use 'delegate' to start a new task first.`,
          );
        }
      }

      let prompt = tool.buildPrompt(args, cwd);

      const MEMORY_EXEMPT_TOOLS = new Set(["get_session_status", "list_sessions"]);
      if (!MEMORY_EXEMPT_TOOLS.has(tool.name) && !prompt.includes("RECALL MEMORY DIRECTIVE")) {
        prompt +=
          `\n\n## MEMORY PROTOCOL - MANDATORY, NEVER SKIP\n` +
          `- BEFORE starting work: query \`agentmemory\` via \`memory_recall\` and/or \`memory_smart_search\` for concepts relevant to this task.\n` +
          `- BEFORE your final answer: persist key learnings via \`memory_save\` (always include the project field).\n` +
          `- If agentmemory tools are unavailable or return zero results, state it explicitly in your final answer ("MEMORY RECALL: 0 results" / "MEMORY SAVE: unavailable"). Silently skipping this step is a protocol violation.`;
      }
      const timeoutSec =
        cfg.perToolTimeouts[tool.name] ?? (cfg.timeoutExplicit ? cfg.timeoutSec : tool.timeoutSec);

      const roleKey = ((args.role as string) || "").toLowerCase().replace(/_/g, "-");
      const effectiveChain =
        (roleKey ? cfg.roleModels[roleKey] : undefined) ||
        (roleKey ? OMO_ROLES[roleKey]?.chain : undefined) ||
        tool.chain;

      const resolution = await registry.resolveChain({
        explicit: args.model as string | undefined,
        chain: effectiveChain,
        defaultModel: cfg.defaultModel,
      });

      const attempts: string[] = [];
      let result: RunResult | undefined;
      let used: string | undefined;

      const onProgress = (elapsedSec: number) => {
        const token = extra?._meta?.progressToken;
        if (token !== undefined && server) {
          server.server
            .notification({
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress: elapsedSec,
                total: timeoutSec,
              },
            })
            .catch(() => {});
        }
      };

      for (const model of resolution.models) {
        if (model && cooldowns.cooling(model)) {
          attempts.push(`${model}: quota cooldown, ${cooldowns.describe(model)} left`);
          continue;
        }
        try {
          result = await runAgy(
            { prompt, cwd, model, conversationId, timeoutSec, signal: extra?.signal, onProgress },
            cfg,
            deps,
          );
          used = model;
          break;
        } catch (err) {
          if (err instanceof QuotaError && model) {
            cooldowns.set(model, err.resetSeconds);
            attempts.push(
              `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
            );
            continue;
          }
          throw err;
        }
      }

      if (!result) {
        throw new Error(
          `Both primary candidate models (Gemini 3.7 Flash & Claude Sonnet 4.6) are quota-exhausted or encountered server errors:\n` +
            `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
            `Retry after the quota resets, or pass an explicit \`model\`.`,
        );
      }

      const isTerminatedOrError =
        /(?:Agent execution terminated due to error|Error ID:|experiencing high traffic|RESOURCE_EXHAUSTED|UNAVAILABLE \(code 503\)|model is overloaded)/i.test(
          result.output,
        );

      if (isTerminatedOrError) {
        const errorText =
          `${result.output}\n\n---\n` +
          `[agy-bridge execution error detected]\n` +
          (result.sessionId ? `- Active session ID: "${result.sessionId}"\n` : "") +
          `- AUTONOMOUS RECOVERY REQUIRED: The previous agy process terminated with an error. Do NOT perform this work yourself and do NOT halt. You MUST immediately invoke 'follow_up' (session_id: "${result.sessionId || "latest"}") with your instructions to resume and complete the task automatically.`;

        return {
          content: [{ type: "text", text: errorText }],
          isError: true,
        };
      }

      const meta: string[] = [`model: ${used ?? "agy default"}`];
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);
      if (result.sessionId) meta.push(`session: ${result.sessionId} (use follow_up to continue)`);

      return {
        content: [
          { type: "text", text: `${result.output}\n\n---\n[agy-bridge] ${meta.join(" | ")}` },
        ],
      };
    } catch (err) {
      let sessionId: string | undefined;
      const reqCwd = (args.cwd as string | undefined) ?? process.cwd();
      try {
        const map = JSON.parse(await deps.readSessionsFile()) as Record<string, string>;
        sessionId = map[path.resolve(reqCwd)] ?? map[reqCwd];
      } catch {}

      if (err instanceof IdleStallError) {
        const recoveryMsg =
          `[agy-bridge stall detected] agy process became inactive/stalled (no log output for ${err.idleSeconds}s).\n` +
          `- The stalled process has been automatically terminated.\n` +
          (sessionId ? `- Active session ID: "${sessionId}"\n` : "") +
          `- AUTONOMOUS RECOVERY ACTION: Please immediately invoke 'follow_up' (session_id: "${sessionId || "latest"}") with your instructions to resume execution.`;

        return {
          content: [{ type: "text", text: recoveryMsg }],
          isError: true,
        };
      }

      let text = (err as Error).message;
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[agy-bridge strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      } else {
        text +=
          `\n\n[agy-bridge recovery notice]` +
          (sessionId ? `\n- Active session ID: "${sessionId}"` : "") +
          `\n- AUTONOMOUS ACTION: If this was a transient server/traffic error, immediately invoke 'follow_up' (session_id: "${sessionId || "latest"}") to retry and resume work automatically.`;
      }
      return {
        content: [{ type: "text", text }],
        isError: true,
      };
    }
  };
}

export function createServer(): McpServer {
  const cfg = loadConfig();
  const registry = new ModelRegistry(async () => {
    const { stdout } = await execWithClosedStdin(cfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();

  const server = new McpServer({ name: "agy-bridge", version: "0.4.1" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, defaultDeps, cooldowns, server),
    );
  }
  return server;
}
