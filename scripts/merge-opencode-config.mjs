#!/usr/bin/env node
// merge-opencode-config.mjs — surgically merge agy-bridge entries into an
// EXISTING opencode.jsonc WITHOUT overwriting the user's config.
//
//   node merge-opencode-config.mjs <configPath> <agyBridgeDir> <agyPath>
//
// What it does (and ONLY this):
//   1. plugin[]: pins "oh-my-openagent@<OMO_VERSION>" (replaces any existing
//      oh-my-openagent entry) and ensures "./plugins/agy-delegate-guard.js".
//      Creates the plugin[] key if missing.
//   2. mcp{}:   ensures the "agy-bridge" MCP server entry with the standard
//      per-tool AGY_TIMEOUT environment, paths resolved to absolute form.
//      Creates the mcp{} key if missing.
// Nothing else is touched. JSONC (comments + trailing commas) is preserved.
//
// Exit codes: 0 = config updated, 2 = already up to date, 3 = error.
import fs from "node:fs";
import path from "node:path";

const OMO_VERSION = "4.19.4";
const AGY_BRIDGE_MCP = `"agy-bridge": {
      "type": "local",
      "command": ["node", "__AGY_BRIDGE_DIR__/dist/index.js"],
      "enabled": true,
      "timeout": 5400000,
      "environment": {
        "AGY_PATH": "__AGY_PATH__",
        "AGY_MAX_OUTPUT_CHARS": "50000",
        "AGY_ON_FAILURE": "fallback",
        "AGY_IDLE_TIMEOUT": "600",
        "AGY_TIMEOUT_DELEGATE": "3600",
        "AGY_TIMEOUT_FOLLOW_UP": "3600",
        "AGY_TIMEOUT_ANALYZE_FILES": "900",
        "AGY_TIMEOUT_ADVERSARIAL_REVIEW": "900",
        "AGY_TIMEOUT_DEEP_SEARCH": "600",
        "AGY_TIMEOUT_WEB_LOOKUP": "180"
      }
    }`;

function findKeyEnd(text, key) {
  const m = new RegExp(`"${key}"\\s*:`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;
  const open = text[i];
  if (open !== "[" && open !== "{") return null;
  const close = open === "[" ? "]" : "}";
  let depth = 0,
    inStr = false,
    inLine = false,
    inBlock = false;
  for (let k = i; k < text.length; k++) {
    const c = text[k],
      n = text[k + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        k++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "/" && n === "/") inLine = true;
    else if (c === "/" && n === "*") inBlock = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { end: k };
    }
  }
  return null;
}

function findRootObjectEnd(text) {
  let depth = 0,
    inStr = false,
    inLine = false,
    inBlock = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k],
      n = text[k + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false;
        k++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "/" && n === "/") inLine = true;
    else if (c === "/" && n === "*") inBlock = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { end: k };
    }
  }
  return null;
}

// Index of last significant char (not whitespace, not inside a line comment)
// before `closer`.
function findLastNonWhitespace(text, closer) {
  let inLineComment = false;
  let lastSignificant = -1;
  for (let i = 0; i < closer; i++) {
    const c = text[i],
      n = text[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = i;
  }
  return lastSignificant;
}

function insertEntry(text, closer, entry, pad) {
  const lastSig = findLastNonWhitespace(text, closer);
  let out = text;
  let insertPos = closer;
  if (lastSig >= 0 && text[lastSig] !== "," && text[lastSig] !== "[" && text[lastSig] !== "{") {
    out = out.slice(0, lastSig + 1) + "," + out.slice(lastSig + 1);
    insertPos++;
  }
  return out.slice(0, insertPos) + "\n" + pad + entry + out.slice(insertPos);
}

function ensurePlugin(text) {
  let found = findKeyEnd(text, "plugin");
  let out = text;
  if (!found) {
    const root = findRootObjectEnd(out);
    if (!root) return text;
    return insertEntry(
      out,
      root.end,
      `"plugin": [\n    "oh-my-openagent@${OMO_VERSION}",\n    "./plugins/agy-delegate-guard.js"\n  ]`,
      "  ",
    );
  }
  if (!out.slice(0, found.end).includes(`"oh-my-openagent@${OMO_VERSION}"`)) {
    if (/("oh-my-openagent@)[^"]*(")/.test(out)) {
      out = out.replace(/("oh-my-openagent@)[^"]*(")/, `$1${OMO_VERSION}$2`);
    } else {
      out = insertEntry(out, found.end, `"oh-my-openagent@${OMO_VERSION}"`, "    ");
    }
  }
  if (!out.includes('"./plugins/agy-delegate-guard.js"')) {
    const f2 = findKeyEnd(out, "plugin");
    out = insertEntry(out, f2.end, '"./plugins/agy-delegate-guard.js"', "    ");
  }
  return out;
}

function ensureMcpAgyBridge(text, agyBridgeDir, agyPath) {
  const normBridgeDir = agyBridgeDir.replace(/\\/g, "/");
  const normAgyPath = agyPath.replace(/\\/g, "/");
  let found = findKeyEnd(text, "mcp");
  let out = text;
  if (!found) {
    const root = findRootObjectEnd(out);
    if (!root) return text;
    const block = AGY_BRIDGE_MCP.replaceAll("__AGY_BRIDGE_DIR__", normBridgeDir).replaceAll(
      "__AGY_PATH__",
      normAgyPath,
    );
    return insertEntry(out, root.end, `"mcp": {\n    ${block}\n  }`, "  ");
  }
  if (out.slice(0, found.end).includes('"agy-bridge"')) return out;
  const block = AGY_BRIDGE_MCP.replaceAll("__AGY_BRIDGE_DIR__", normBridgeDir).replaceAll(
    "__AGY_PATH__",
    normAgyPath,
  );
  return insertEntry(out, found.end, block, "    ");
}

function backup(p) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = path.join(path.dirname(p), `${path.basename(p)}.backup-${ts}`);
  fs.copyFileSync(p, bak);
  return bak;
}

function main() {
  const [configPath, agyBridgeDir, agyPath] = process.argv.slice(2);
  if (!configPath || !agyBridgeDir || !agyPath) {
    console.error("usage: merge-opencode-config.mjs <configPath> <agyBridgeDir> <agyPath>");
    process.exit(3);
  }
  if (!fs.existsSync(configPath)) {
    console.error(`config not found: ${configPath}`);
    process.exit(3);
  }
  const text = fs.readFileSync(configPath, "utf8");
  const merged = ensureMcpAgyBridge(ensurePlugin(text), agyBridgeDir, agyPath);
  if (merged === text) {
    console.log("opencode.jsonc: already up to date (no changes needed)");
    process.exit(2);
  }
  const bak = backup(configPath);
  fs.writeFileSync(configPath, merged);
  console.log(`opencode.jsonc: merged agy-bridge entries (backup: ${bak})`);
  process.exit(0);
}

main();
