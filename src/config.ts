import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
   * Per-role model chain overrides (e.g. { oracle: ["Claude Sonnet 4.6 (Thinking)"] })
   * loaded from config file or AGY_ROLE_MODEL_<ROLE> env vars.
   */
  roleModels: Record<string, string[]>;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
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

export function stripJsonComments(raw: string): string {
  let out = "";
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
        out += c;
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
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (c === ",") {
      let j = i + 1;
      while (j < raw.length && (raw[j] === " " || raw[j] === "\t" || raw[j] === "\n" || raw[j] === "\r")) {
        j++;
      }
      if (raw[j] !== "}" && raw[j] !== "]") {
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

  try {
    if (configPath && fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      fileConfig = JSON.parse(stripJsonComments(raw));
    }
  } catch {}

  const fileRoles = (fileConfig.roles || fileConfig.roleModels || {}) as Record<
    string,
    string | string[]
  >;
  const fileTimeouts = (fileConfig.perToolTimeouts || {}) as Record<string, number>;

  return {
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
    roleModels: loadRoleModels(env, fileRoles),
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false" && fileConfig.skipPermissions !== false,
    sandbox: env.AGY_SANDBOX === "true" || fileConfig.sandbox === true,
    onFailure: (env.AGY_ON_FAILURE || fileConfig.onFailure) === "strict" ? "strict" : "fallback",
  };
}
