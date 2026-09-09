import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig, loadConfigCached, _resetConfigCache, stripJsonComments } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults for empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({
      agyPath: "agy",
      timeoutSec: 1200,
      timeoutExplicit: false,
      idleTimeoutSec: 90,
      perToolTimeouts: {},
      maxOutputChars: 50_000,
      defaultModel: undefined,
      toolModels: {},
      roleModels: {},
      skipPermissions: true,
      sandbox: false,
      onFailure: "fallback",
    });
  });

  it("reads overrides from env", () => {
    const c = loadConfig({
      AGY_PATH: "/opt/agy",
      AGY_TIMEOUT: "300",
      AGY_IDLE_TIMEOUT: "45",
      AGY_MAX_OUTPUT_CHARS: "1000",
      AGY_DEFAULT_MODEL: "Gemini 3.1 Pro (High)",
      AGY_SKIP_PERMISSIONS: "false",
      AGY_SANDBOX: "true",
    });
    expect(c.agyPath).toBe("/opt/agy");
    expect(c.timeoutSec).toBe(300);
    expect(c.timeoutExplicit).toBe(true);
    expect(c.idleTimeoutSec).toBe(45);
    expect(c.maxOutputChars).toBe(1000);
    expect(c.defaultModel).toBe("Gemini 3.1 Pro (High)");
    expect(c.skipPermissions).toBe(false);
    expect(c.sandbox).toBe(true);
  });

  it("falls back to defaults on non-numeric values", () => {
    const c = loadConfig({ AGY_TIMEOUT: "abc", AGY_MAX_OUTPUT_CHARS: "-5" });
    expect(c.timeoutSec).toBe(1200);
    expect(c.timeoutExplicit).toBe(false);
    expect(c.maxOutputChars).toBe(50_000);
  });

  it("parses per-tool AGY_TIMEOUT_<TOOL> overrides", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "300", AGY_TIMEOUT_DELEGATE: "900" });
    expect(c.perToolTimeouts).toEqual({ deep_search: 300, delegate: 900 });
  });

  it("ignores non-positive per-tool timeout values", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "abc", AGY_TIMEOUT_DELEGATE: "-5" });
    expect(c.perToolTimeouts).toEqual({});
  });

  it("reads AGY_ON_FAILURE=strict", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "strict" }).onFailure).toBe("strict");
  });

  it("treats unknown AGY_ON_FAILURE values as fallback", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "explode" }).onFailure).toBe("fallback");
  });

  it("parses per-role AGY_ROLE_MODEL_<ROLE> overrides", () => {
    const c = loadConfig({
      AGY_ROLE_MODEL_ORACLE: "Claude Sonnet 4.6 (Thinking),Gemini 3.7 Flash (High)",
      AGY_ROLE_MODEL_GIT_MASTER: "Gemini 3.7 Flash (High)",
    });
    expect(c.roleModels).toEqual({
      oracle: ["Claude Sonnet 4.6 (Thinking)", "Gemini 3.7 Flash (High)"],
      "git-master": ["Gemini 3.7 Flash (High)"],
    });
  });

  it("parses per-tool AGY_TOOL_MODEL_<TOOL> overrides", () => {
    const c = loadConfig({
      AGY_TOOL_MODEL_WEB_LOOKUP: "gemini-3.8-flash-medium",
      AGY_TOOL_MODEL_DELEGATE: "claude-sonnet-4-6,gemini-3.7-flash-high",
    });
    expect(c.toolModels).toEqual({
      web_lookup: ["gemini-3.8-flash-medium"],
      delegate: ["claude-sonnet-4-6", "gemini-3.7-flash-high"],
    });
  });

  it("normalizes toolModels string and array from config file", () => {
    const jsonc = `{
      "toolModels": {
        "web_lookup": "gemini-3.8-flash-medium",
        "deep_search": ["gemini-3.8-flash-medium", "claude-sonnet-4-6"],
        "follow-up": "claude-sonnet-4-6"
      }
    }`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    // simulate file load with temporary AGY_CONFIG_PATH or directly check loader logic
    const c = loadConfig({
      AGY_CONFIG_PATH: path.resolve(__dirname, "../agy.config.json.example"),
    });
    expect(c.toolModels?.web_lookup).toEqual(["gemini-3.7-flash-high"]);
    expect(c.toolModels?.deep_search).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
  });

  it("loads config from AGY_CONFIG_PATH JSON file", () => {
    const c = loadConfig({
      AGY_CONFIG_PATH: path.resolve(__dirname, "../agy.config.json.example"),
    });
    expect(c.defaultModel).toBe("gemini-3.7-flash-high");
    expect(c.toolModels?.web_lookup).toEqual(["gemini-3.7-flash-high"]);
    expect(c.toolModels?.deep_search).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
    expect(c.roleModels.oracle).toEqual(["claude-sonnet-4-6", "gemini-3.7-flash-high"]);
    expect(c.roleModels["git-master"]).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
  });

  it("parses team keys from file config", () => {
    const c = loadConfig({
      AGY_CONFIG_PATH: path.resolve(__dirname, "../agy.config.json.example"),
    });
    expect(c.teamMaxParallel).toBe(4);
    expect(c.teamPollMs).toBe(3000);
    expect(c.teamMemberTimeoutSec).toBe(300);
    expect(c.teamKillGraceMs).toBe(5000);
  });

  it("allows env AGY_TEAM_MAX_PARALLEL to override file value", () => {
    const c = loadConfig({
      AGY_CONFIG_PATH: path.resolve(__dirname, "../agy.config.json.example"),
      AGY_TEAM_MAX_PARALLEL: "8",
      AGY_TEAM_POLL_MS: "1500",
      AGY_TEAM_MEMBER_TIMEOUT_SEC: "600",
      AGY_TEAM_KILL_GRACE_MS: "10000",
    });
    expect(c.teamMaxParallel).toBe(8);
    expect(c.teamPollMs).toBe(1500);
    expect(c.teamMemberTimeoutSec).toBe(600);
    expect(c.teamKillGraceMs).toBe(10000);
  });

  it("returns default team keys when absent from config and env", () => {
    const c = loadConfig({});
    expect(c.teamMaxParallel).toBe(4);
    expect(c.teamPollMs).toBe(3000);
    expect(c.teamMemberTimeoutSec).toBe(300);
    expect(c.teamKillGraceMs).toBe(5000);
  });

  it("falls back to default team keys on non-numeric or non-positive values", () => {
    const c = loadConfig({
      AGY_TEAM_MAX_PARALLEL: "not-a-number",
      AGY_TEAM_POLL_MS: "-3000",
      AGY_TEAM_MEMBER_TIMEOUT_SEC: "0",
      AGY_TEAM_KILL_GRACE_MS: "xyz",
    });
    expect(c.teamMaxParallel).toBe(4);
    expect(c.teamPollMs).toBe(3000);
    expect(c.teamMemberTimeoutSec).toBe(300);
    expect(c.teamKillGraceMs).toBe(5000);
  });

  it("handles JSON with single-line and multi-line comments", () => {
    const jsonc = `
      // Top-level comment
      {
        /* Block comment */
        "defaultModel": "gemini-3.7-flash-high", // trailing comment
        "timeoutSec": 300
      }
    `;
    const c = JSON.parse(stripJsonComments(jsonc));
    expect(c.defaultModel).toBe("gemini-3.7-flash-high");
    expect(c.timeoutSec).toBe(300);
  });

  it("strips trailing commas so live agy_bridge.jsonc with JSONC commas parses", () => {
    const jsonc = `{
      // roles block
      "roles": {
        "oracle": ["gemini-3.8-flash-high", "claude-opus-4-6-thinking"],
        "product": ["gemini-3.8-flash-high", "claude-sonnet-4-6"],
      },
    }`;
    const c = JSON.parse(stripJsonComments(jsonc));
    expect(c.roles.oracle).toEqual(["gemini-3.8-flash-high", "claude-opus-4-6-thinking"]);
    expect(c.roles.product).toEqual(["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
  });

  it("does not strip commas inside strings that precede } or ]", () => {
    const jsonc = `{"note": "a,}b", "list": ["x", "y,"]}`;
    const c = JSON.parse(stripJsonComments(jsonc));
    expect(c.note).toBe("a,}b");
    expect(c.list).toEqual(["x", "y,"]);
  });

  it("(a) parses trailing comma followed by line comment and }", () => {
    const jsonc = `{
      "teamMaxParallel": 4,
      "teamKillGraceMs": 5000, // komentar grace period
    }`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.teamMaxParallel).toBe(4);
    expect(parsed.teamKillGraceMs).toBe(5000);
  });

  it("(b) parses trailing comma followed by block comment and }", () => {
    const jsonc = `{
      "defaultModel": "gemini-3.8-flash-high", /* trailing block comment */
    }`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.defaultModel).toBe("gemini-3.8-flash-high");
  });

  it("(c) parses trailing comma followed by newline and } (regression existing)", () => {
    const jsonc = `{\n  "timeoutSec": 300,\n}`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.timeoutSec).toBe(300);
  });

  it("(d) preserves comma inside string literal even if matching '\"a, }\"'", () => {
    const jsonc = `{"query": "a, }", "nested": ["b, ]", 1]}`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.query).toBe("a, }");
    expect(parsed.nested).toEqual(["b, ]", 1]);
  });

  it("(e) preserves URL 'https://x.com/a' inside string literal without comment corruption", () => {
    const jsonc = `{"endpoint": "https://x.com/a", "status": 200}`;
    const parsed = JSON.parse(stripJsonComments(jsonc));
    expect(parsed.endpoint).toBe("https://x.com/a");
    expect(parsed.status).toBe(200);
  });

  it("(f) prints warning to stderr on parse failure and falls back to defaults", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invalidPath = path.resolve(__dirname, "./fixtures-invalid.jsonc");
    fs.writeFileSync(invalidPath, "{ invalid json content / bad , }");

    try {
      const c = loadConfig({ AGY_CONFIG_PATH: invalidPath });
      expect(c.timeoutSec).toBe(1200);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`\\[agy-bridge\\] WARNING: gagal parse config ${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*`),
        ),
      );
    } finally {
      if (fs.existsSync(invalidPath)) fs.unlinkSync(invalidPath);
      consoleErrorSpy.mockRestore();
    }
  });

  it("(g) prints info log to stderr and no warning when valid config is loaded", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const validPath = path.resolve(__dirname, "../agy.config.json.example");
      const c = loadConfig({ AGY_CONFIG_PATH: validPath });
      expect(c.defaultModel).toBe("gemini-3.7-flash-high");

      const errorCalls = consoleErrorSpy.mock.calls.map((call) => call.join(" "));
      const hasWarning = errorCalls.some((msg) => msg.includes("WARNING: gagal parse config"));
      expect(hasWarning).toBe(false);

      const hasInfo = errorCalls.some((msg) =>
        msg.includes(`[agy-bridge] config: ${validPath} (roles:`),
      );
      expect(hasInfo).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("loadConfigCached (hot-reload mtime cache)", () => {
  let tmpFile: string;

  beforeEach(() => {
    _resetConfigCache();
    tmpFile = path.join(os.tmpdir(), `agy-bridge-test-${Date.now()}.jsonc`);
  });

  afterEach(() => {
    _resetConfigCache();
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  it("returns cached config on repeated calls when file mtime is unchanged", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ defaultModel: "gemini-3.7-flash-high" }));
    const c1 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
    expect(c1.defaultModel).toBe("gemini-3.7-flash-high");
    // Second call — same mtime, must return same object reference (cache hit)
    const c2 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
    expect(c2).toBe(c1);
  });

  it("re-reads config when file mtime changes (touch → new value visible)", async () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ defaultModel: "gemini-3.7-flash-high" }));
    const c1 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
    expect(c1.defaultModel).toBe("gemini-3.7-flash-high");

    // Wait ≥1 ms then write a new value — on most filesystems this changes mtime
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(tmpFile, JSON.stringify({ defaultModel: "claude-sonnet-4-6" }));

    // Force a different mtime by touching the file's timestamps explicitly
    const now = new Date();
    fs.utimesSync(tmpFile, now, new Date(now.getTime() + 1000));

    const c2 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
    expect(c2.defaultModel).toBe("claude-sonnet-4-6");
    expect(c2).not.toBe(c1);
  });

  it("falls back to cached config when file disappears on reload (statSync throws)", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Populate cache with valid config
      fs.writeFileSync(tmpFile, JSON.stringify({ defaultModel: "gemini-3.7-flash-high" }));
      const c1 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
      expect(c1.defaultModel).toBe("gemini-3.7-flash-high");

      // Remove the file — next statSync throws ENOENT
      fs.unlinkSync(tmpFile);

      // Should fall back to old cache + log warning
      const c2 = loadConfigCached({ AGY_CONFIG_PATH: tmpFile });
      expect(c2.defaultModel).toBe("gemini-3.7-flash-high");
      expect(c2).toBe(c1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/WARNING: config reload failed/),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("falls back gracefully when config file is absent on first load (no cache yet)", () => {
    // Point to a file that does not exist — first load, no cache
    const c = loadConfigCached({ AGY_CONFIG_PATH: "/nonexistent-path/missing.jsonc" });
    // Should return defaults, not throw
    expect(c.agyPath).toBe("agy");
    expect(c.timeoutSec).toBe(1200);
  });
});
