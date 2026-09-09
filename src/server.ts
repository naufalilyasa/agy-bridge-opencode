import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, loadConfigCached, type Config } from "./config.js";
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
import { TEAM_HANDLERS, type TeamHandlerContext } from "./team/handlers.js";
import {
  TeamRuntime,
  type TeamRuntimeConfig,
  type TeamCooldownRegistry,
  type TeamRunMember,
  type WakeOptions,
  type WakeResult,
} from "./team/runtime.js";

export class AllModelsExhaustedError extends Error {
  readonly code = "ALL_MODELS_EXHAUSTED";
  readonly field?: string;

  constructor(
    message: string,
    public readonly models: (string | undefined)[] = [],
    public readonly attempts: string[] = [],
    field?: string,
  ) {
    super(message);
    this.name = "AllModelsExhaustedError";
    this.field = field;
  }
}

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function adaptCooldowns(cooldowns: CooldownRegistry): TeamCooldownRegistry {
  return {
    isCooled: (model: string) => cooldowns.cooling(model),
    set: (model: string, resetSeconds: number) => cooldowns.set(model, resetSeconds),
    get: (model: string) => (cooldowns.cooling(model) ? 1 : null),
  };
}

export function makeDefaultRunWake(
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
): (options: WakeOptions) => Promise<WakeResult> {
  return async (options: WakeOptions): Promise<WakeResult> => {
    const res = await runAgy(
      {
        prompt: options.prompt,
        cwd: options.projectRoot,
        model: options.model,
        conversationId: options.conversationId,
        timeoutSec: options.timeoutSec,
        signal: options.signal,
        onProgress: options.onProgress,
      },
      cfg,
      deps,
    );
    return {
      output: res.output,
      sessionId: res.sessionId ?? null,
      model: options.model,
    };
  };
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
  serverOrRuntime?: McpServer | TeamRuntime,
  runtime?: TeamRuntime,
  cfgProvider?: () => Config,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  const isMcpServer =
    serverOrRuntime !== undefined &&
    (serverOrRuntime instanceof McpServer || "registerTool" in serverOrRuntime);
  const server = isMcpServer ? (serverOrRuntime as McpServer) : undefined;
  const teamRuntime =
    runtime ??
    (!isMcpServer && serverOrRuntime !== undefined
      ? (serverOrRuntime as TeamRuntime)
      : new TeamRuntime({
          cfg: cfg as unknown as TeamRuntimeConfig,
          cooldowns: adaptCooldowns(cooldowns),
          runWake: makeDefaultRunWake(cfg, deps),
          resolveModelChain: (member: TeamRunMember) =>
            cfg.roleModels[member.resolvedRole] ??
            OMO_ROLES[member.resolvedRole]?.chain ?? [member.resolvedRole],
        }));

  return async (args, extra) => {
    // Hot-reload: resolve config per call when a provider is available.
    const activeCfg = cfgProvider ? cfgProvider() : cfg;
    try {
      const cwd = (args.cwd as string | undefined) ?? process.cwd();

      if (tool.kind === "team") {
        const handler = TEAM_HANDLERS[tool.name];
        if (!handler) {
          return {
            content: [
              {
                type: "text",
                text: `[agy-bridge] Unknown team tool handler: ${tool.name}`,
              },
            ],
            isError: true,
          };
        }
        const projectRoot = path.resolve(
          typeof args.cwd === "string" && args.cwd.trim().length > 0
            ? args.cwd.trim()
            : process.cwd(),
        );
        const ctx: TeamHandlerContext = {
          projectRoot,
          runtime: teamRuntime,
        };
        const res = await handler(args, ctx);
        return {
          content: res.content,
          isError: res.isError,
        };
      }

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
            content: [
              { type: "text", text: "[agy-bridge] No recorded Antigravity sessions found." },
            ],
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
          lines.push(
            `  - **Resume Command**: \`follow_up(session_id: "${sessionId}", question: "...")\``,
          );
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

      let roleKey = ((args.role as string) || "").toLowerCase().replace(/_/g, "-");
      if (!roleKey && tool.name === "follow_up") {
        try {
          const roles = JSON.parse((await deps.readRoleFile()) || "{}") as Record<
            string,
            { role?: string }
          >;
          const entry = roles[path.resolve(cwd)] ?? roles[cwd];
          if (entry?.role) roleKey = entry.role;
        } catch {}
      }
      const effectiveChain =
        activeCfg.toolModels?.[tool.name] ??
        (roleKey ? activeCfg.roleModels[roleKey] : undefined) ??
        (roleKey ? OMO_ROLES[roleKey]?.chain : undefined) ??
        tool.chain;

      const explicitModel = args.model as string | undefined;
      const resolution = await registry.resolveChain({
        explicit: explicitModel,
        chain: effectiveChain,
        defaultModel: activeCfg.defaultModel,
      });

      // Build the prompt AFTER resolving the chain so model-family-specific
      // variants (e.g. Claude vs Gemini discipline) can be injected from the
      // first available model. resolution.models[0] === undefined means "let
      // agy pick" — tools fall back to a neutral variant then.
      let prompt = tool.buildPrompt(args, cwd, resolution.models[0]);

      const MEMORY_EXEMPT_TOOLS = new Set(["get_session_status", "list_sessions"]);
      if (!MEMORY_EXEMPT_TOOLS.has(tool.name) && !prompt.includes("RECALL MEMORY DIRECTIVE")) {
        prompt +=
          `\n\n## MEMORY PROTOCOL - MANDATORY, NEVER SKIP\n` +
          `- BEFORE starting work: query \`agentmemory\` via \`memory_recall\` and/or \`memory_smart_search\` for concepts relevant to this task.\n` +
          `- BEFORE your final answer: persist key learnings via \`memory_save\` (always include the project field).\n` +
          `- If agentmemory tools are unavailable or return zero results, state it explicitly in your final answer ("MEMORY RECALL: 0 results" / "MEMORY SAVE: unavailable"). Silently skipping this step is a protocol violation.`;
      }
      const timeoutSec =
        activeCfg.perToolTimeouts[tool.name] ?? (activeCfg.timeoutExplicit ? activeCfg.timeoutSec : tool.timeoutSec);

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
        if (model && model !== explicitModel && cooldowns.cooling(model)) {
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
        const modelList = resolution.models.filter(Boolean).join(", ") || "agy default";
        throw new AllModelsExhaustedError(
          `[ALL_MODELS_EXHAUSTED] Candidate models (${modelList}) are quota-exhausted or encountered server errors:\n` +
            `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
            `Retry after the quota resets, or pass an explicit \`model\`.`,
          resolution.models,
          attempts,
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
      const chainDisplay = resolution.models.filter(Boolean).join(" → ");
      if (chainDisplay) meta.push(`chain: ${chainDisplay}`);
      if (used !== undefined && resolution.models[0] !== undefined && used !== resolution.models[0]) {
        meta.push(`⚠ downgraded from ${resolution.models[0]}`);
      }
      if (resolution.note) meta.push(`note: ${resolution.note}`);
      if (attempts.length) meta.push(`failover: ${attempts.join("; ")}`);
      if (result.sessionId) meta.push(`session: ${result.sessionId} (use follow_up to continue)`);

      if (tool.name === "delegate" && result.sessionId && roleKey) {
        try {
          const roles = JSON.parse((await deps.readRoleFile()) || "{}") as Record<
            string,
            { sessionId: string; role: string }
          >;
          roles[path.resolve(cwd)] = { sessionId: result.sessionId, role: roleKey };
          await deps.writeRoleFile(JSON.stringify(roles, null, 2));
        } catch {}
      }

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
          (sessionId
            ? `- Session ID of THIS run is ambiguous — the cwd-keyed session map may still point to an older task. Do NOT trust it blindly.\n`
            : "") +
          (err.logPath
            ? `- Runtime log preserved at: ${err.logPath} (inspect with grep/tail if needed)\n`
            : "") +
          (err.logTail
            ? `- Log tail (last activity before the stall):\n---\n${err.logTail}\n---\n`
            : "") +
          `- BEFORE resuming: run 'git status' / 'git diff' to check what the stalled agent already changed.\n` +
          `- AUTONOMOUS RECOVERY ACTION: invoke 'follow_up' (session_id: "${sessionId || "latest"}") and REPEAT the original task prompt in full — the resumed session has no memory of the stalled run.`;

        return {
          content: [{ type: "text", text: recoveryMsg }],
          isError: true,
        };
      }

      let text = (err as Error).message;
      if (activeCfg.onFailure === "strict") {
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

export function createServer(
  runtime?: TeamRuntime,
  cfg: Config = loadConfig(),
  deps: RunnerDeps = defaultDeps,
): McpServer {
  // Hot-reload provider: each tool invocation re-checks config file mtime.
  const cfgProvider = () => loadConfigCached();

  const registry = new ModelRegistry(async () => {
    const activeCfg = cfgProvider();
    const { stdout } = await execWithClosedStdin(activeCfg.agyPath, ["models"], {
      cwd: process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  });
  const cooldowns = new CooldownRegistry();
  const teamRuntime =
    runtime ??
    new TeamRuntime({
      cfg: cfg as unknown as TeamRuntimeConfig,
      cooldowns: adaptCooldowns(cooldowns),
      runWake: makeDefaultRunWake(cfg, deps),
      resolveModelChain: (member: TeamRunMember) =>
        cfg.roleModels[member.resolvedRole] ??
        OMO_ROLES[member.resolvedRole]?.chain ?? [member.resolvedRole],
    });

  const server = new McpServer({ name: "agy-bridge", version: "0.4.1" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, registry, deps, cooldowns, server, teamRuntime, cfgProvider),
    );
  }
  return server;
}
