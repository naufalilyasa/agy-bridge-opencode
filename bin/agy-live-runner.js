#!/usr/bin/env node
// Shim: delegates to bun to run the TypeScript agy-live.ts
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { spawnSync } from "child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const tsFile = join(__dir, "agy-live.ts");
const args = process.argv.slice(2);

const result = spawnSync("bun", [tsFile, ...args], { stdio: "inherit" });

if (result.error) {
  console.error("agy-live requires bun >= 1.3.0 (not found on PATH)");
  process.exit(1);
}

process.exit(result.status ?? 0);
