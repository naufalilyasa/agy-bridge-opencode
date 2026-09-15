#!/usr/bin/env node
// agy-live launcher: single source of truth is the repo agy-live.ts, run under bun.
import { spawnSync } from "node:child_process";
const tsFile = "/Users/ctp-itdev2/agy-bridge/bin/agy-live.ts";
const result = spawnSync("bun", [tsFile, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error("agy-live requires bun >= 1.3.0 (not found on PATH)");
  process.exit(1);
}
process.exit(result.status ?? 0);
