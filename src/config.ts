import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolved config file path used by the cached loader. */
let _cachedPath: string | undefined;
let _cachedMtimeMs: number = 0;
let _cachedConfig: Config | undefined;

/**
 * Hot-reload-friendly config loader.  Re-reads agy_bridge.jsonc only when
 * its mtime has changed (fs.statSync — cheap).  On file-not-found or
 * parse error during a *reload* (not first load), the last good Config is
 * kept and a warning is logged to stderr so the MCP server never crashes.
 */
export function loadConfigCached(
  env: Record<string, string | undefined> = process.env,
): Config {
  const cfgPath = resolveConfigPath(env);
  if (cfgPath) {
    try {
      const st = fs.statSync(cfgPath);
      if (_cachedConfig && cfgPath === _cachedPath && st.mtimeMs === _cachedMtimeMs) {
        return _cachedConfig;
      }
      // File changed or first load — reload.
      const fresh = loadConfig(env);
      _cachedPath = cfgPath;
      _cachedMtimeMs = st.mtimeMs;
      _cachedConfig = fresh;
      return fresh;
    } catch (err: unknown) {
      // File disappeared or corrupt during reload.
      if (_cachedConfig) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[agy-bridge] WARNING: config reload failed (${msg}), using cached config`);
        return _cachedConfig;
      }
      // First load — no cache to fall back to; delegate to loadConfig which
      // already handles errors gracefully.
    }
  }
  const fresh = loadConfig(env);
  _cachedConfig = fresh;
  _cachedPath = cfgPath;
  return fresh;
}

/** Resolve the config file path without reading it (shared by loadConfig + cached). */
function resolveConfigPath(
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.AGY_CONFIG_PATH !== undefined) return env.AGY_CONFIG_PATH;
  if (env.NODE_ENV !== "test" && process.env.NODE_ENV !== "test") {
    const jsoncPath = path.join(os.homedir(), ".gemini", "config", "agy_bridge.jsonc");
    const jsonPath = path.join(os.homedir(), ".gemini", "config", "agy_bridge.json");
    return fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;
  }
  return undefined;
}

/** Reset cached state (for testing only). */
export function _resetConfigCache(): void {
  _cachedPath = undefined;
  _cachedMtimeMs = 0;
  _cachedConfig = undefined;
}

export interface Config {
  agyPath: string;
  timeoutSec: number;
  /** True when AGY_TIMEOUT was set explicitly; overrides per-tool timeouts. */
  timeoutExplicit: boolean;
  /** Inactivity threshold in seconds before detecting a stall (default 90s). */
  idleTimeoutSec: number;
  /**
   * Per-tool timeout overrides from AGY_TIMEOUT_<TOOL_NAME> env vars
   * (e.g. AGY_TIMEOUT_DEEP_SEARCH), keyed by lowercased tool name.
   * Takes precedence over the global AGY_TIMEOUT and the tool's default.
   */
  perToolTimeouts: Record<string, number>;
  maxOutputChars: number;
  defaultModel: string | undefined;
  /**
   * Per-tool model chain overrides (e.g. { web_lookup: ["gemini-3.8-flash-medium"] })
   * loaded from config file toolModels or AGY_TOOL_MODEL_<TOOL> env vars.
   */
  toolModels?: Record<string, string[]>;
  /**
   * Per-role model chain overrides (e.g. { oracle: ["Claude Sonnet 4.6 (Thinking)"] })
   * loaded from config file or AGY_ROLE_MODEL_<ROLE> env vars.
   */
  roleModels: Record<string, string[]>;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
  teamMaxParallel?: number;
  teamPollMs?: number;
  teamMemberTimeoutSec?: number;
  teamKillGraceMs?: number;
}

function positiveInt(raw: string | number | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function loadPerToolTimeouts(
  env: Record<string, string | undefined>,
  fileTimeouts: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = { ...fileTimeouts };
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out[tool] = n;
  }
  return out;
}

function loadRoleModels(
  env: Record<string, string | undefined>,
  fileRoles: Record<string, string | string[]> = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const [role, val] of Object.entries(fileRoles)) {
    const normKey = role.toLowerCase().replace(/_/g, "-");
    if (Array.isArray(val)) {
      out[normKey] = val.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof val === "string" && val.trim()) {
      out[normKey] = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_ROLE_MODEL_") || !raw) continue;
    const role = key.slice("AGY_ROLE_MODEL_".length).toLowerCase().replace(/_/g, "-");
    if (!role) continue;
    out[role] = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return out;
}

function loadToolModels(
  env: Record<string, string | undefined>,
  fileToolModels: Record<string, unknown> = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};

  for (const [tool, val] of Object.entries(fileToolModels)) {
    const normKey = tool.toLowerCase().replace(/-/g, "_");
    if (Array.isArray(val)) {
      const arr = val.map((s) => String(s).trim()).filter(Boolean);
      if (arr.length) out[normKey] = arr;
    } else if (typeof val === "string" && val.trim()) {
      const arr = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length) out[normKey] = arr;
    }
  }

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TOOL_MODEL_") || !raw) continue;
    const tool = key.slice("AGY_TOOL_MODEL_".length).toLowerCase().replace(/-/g, "_");
    if (!tool) continue;
    const arr = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (arr.length) out[tool] = arr;
  }

  return out;
}

export function stripJsonComments(raw: string): string {
  // Pass 1: strip comments while preserving strings
  let noComments = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1];

    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        noComments += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      noComments += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      noComments += c;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      noComments += c;
    }
  }

  // Pass 2: strip trailing commas while preserving strings
  let out = "";
  inString = false;
  escaped = false;

  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];

    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === ",") {
      let j = i + 1;
      while (
        j < noComments.length &&
        (noComments[j] === " " ||
          noComments[j] === "\t" ||
          noComments[j] === "\n" ||
          noComments[j] === "\r")
      ) {
        j++;
      }
      if (noComments[j] !== "}" && noComments[j] !== "]") {
        out += c;
      }
    } else {
      out += c;
    }
  }

  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  let fileConfig: Record<string, unknown> = {};

  let configPath: string | undefined;
  if (env.AGY_CONFIG_PATH !== undefined) {
    configPath = env.AGY_CONFIG_PATH;
  } else if (env.NODE_ENV !== "test" && process.env.NODE_ENV !== "test") {
    const jsoncPath = path.join(os.homedir(), ".gemini", "config", "agy_bridge.jsonc");
    const jsonPath = path.join(os.homedir(), ".gemini", "config", "agy_bridge.json");
    configPath = fs.existsSync(jsoncPath) ? jsoncPath : jsonPath;
  }

  let parseAttempted = false;
  let parseFailed = false;
  if (configPath && fs.existsSync(configPath)) {
    parseAttempted = true;
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      fileConfig = JSON.parse(stripJsonComments(raw));
    } catch (err: unknown) {
      parseFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[agy-bridge] WARNING: gagal parse config ${configPath}: ${msg}`);
    }
  }

  const fileRoles = (fileConfig.roles || fileConfig.roleModels || {}) as Record<
    string,
    string | string[]
  >;
  const fileToolModels = (fileConfig.toolModels || {}) as Record<string, unknown>;
  const fileTimeouts = (fileConfig.perToolTimeouts || {}) as Record<string, number>;

  const cfg: Config = {
    agyPath: env.AGY_PATH || (fileConfig.agyPath as string) || "agy",
    timeoutSec: positiveInt(env.AGY_TIMEOUT ?? (fileConfig.timeoutSec as number | undefined), 1200),
    timeoutExplicit:
      positiveInt(env.AGY_TIMEOUT, 0) > 0 ||
      (typeof fileConfig.timeoutSec === "number" && fileConfig.timeoutSec > 0),
    idleTimeoutSec: positiveInt(
      env.AGY_IDLE_TIMEOUT ?? (fileConfig.idleTimeoutSec as number | undefined),
      90,
    ),
    perToolTimeouts: loadPerToolTimeouts(env, fileTimeouts),
    maxOutputChars: positiveInt(
      env.AGY_MAX_OUTPUT_CHARS ?? (fileConfig.maxOutputChars as number | undefined),
      50_000,
    ),
    defaultModel: env.AGY_DEFAULT_MODEL || (fileConfig.defaultModel as string) || undefined,
    toolModels: loadToolModels(env, fileToolModels),
    roleModels: loadRoleModels(env, fileRoles),
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false" && fileConfig.skipPermissions !== false,
    sandbox: env.AGY_SANDBOX === "true" || fileConfig.sandbox === true,
    onFailure: (env.AGY_ON_FAILURE || fileConfig.onFailure) === "strict" ? "strict" : "fallback",
  };

  const teamDefs: Array<[keyof Config, string, number]> = [
    ["teamMaxParallel", "AGY_TEAM_MAX_PARALLEL", 4],
    ["teamPollMs", "AGY_TEAM_POLL_MS", 3000],
    ["teamMemberTimeoutSec", "AGY_TEAM_MEMBER_TIMEOUT_SEC", 300],
    ["teamKillGraceMs", "AGY_TEAM_KILL_GRACE_MS", 5000],
  ];

  for (const [key, envVar, fallback] of teamDefs) {
    const val = positiveInt(env[envVar] ?? (fileConfig[key] as number | undefined), fallback);
    Object.defineProperty(cfg, key, {
      value: val,
      writable: true,
      configurable: true,
      enumerable: env[envVar] !== undefined || fileConfig[key] !== undefined,
    });
  }

  if (parseAttempted && !parseFailed && configPath) {
    const rolesCount = Object.keys(cfg.roleModels).length;
    const toolModelsCount = cfg.toolModels ? Object.keys(cfg.toolModels).length : 0;
    console.error(
      `[agy-bridge] config: ${configPath} (roles: ${rolesCount}, toolModels: ${toolModelsCount})`,
    );
  }

  return cfg;
}
