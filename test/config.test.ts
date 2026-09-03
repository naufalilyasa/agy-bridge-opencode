import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { loadConfig, stripJsonComments } from "../src/config.js";

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

  it("loads config from AGY_CONFIG_PATH JSON file", () => {
    const c = loadConfig({
      AGY_CONFIG_PATH: path.resolve(__dirname, "../agy.config.json.example"),
    });
    expect(c.defaultModel).toBe("gemini-3.7-flash-high");
    expect(c.roleModels.oracle).toEqual(["claude-sonnet-4-6", "gemini-3.7-flash-high"]);
    expect(c.roleModels["git-master"]).toEqual(["gemini-3.7-flash-high", "claude-sonnet-4-6"]);
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
});
