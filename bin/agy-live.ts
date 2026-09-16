#!/usr/bin/env bun
/**
 * agy-live — Realtime monitor for Antigravity CLI sessions
 * Built with @opentui/core — requires: bun >= 1.3.0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextNodeRenderable,
  ScrollBoxRenderable,
  createTextAttributes,
  parseColor,
  type Renderable,
} from "@opentui/core";

const esmRequire = createRequire(import.meta.url);

// ─── Constants ────────────────────────────────────────────────────────────────

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const CONVERSATION_DB_PATH = path.join(
  os.homedir(),
  ".gemini",
  "antigravity-cli",
  "conversation_summaries.db",
);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOLD_ATTR = createTextAttributes({ bold: true });

export const DEFAULT_STALE_MS = 90_000;

export const STYLE = {
  CARD_BG: "#1e293b",
  ACCENT: {
    user: "#60a5fa",
    tool: "#38bdf8",
    thinking: "#c084fc",
    error: "#f87171",
  },
  BORDER_CHARS: {
    topLeft: " ",
    topRight: " ",
    bottomLeft: " ",
    bottomRight: " ",
    horizontal: " ",
    vertical: "┃",
    topT: " ",
    bottomT: " ",
    leftT: " ",
    rightT: " ",
    cross: " ",
  },
  GUTTER: "  ",
} as const;

// Perf guards: bound per-tick file reads and per-step rendering so a giant
// transcript / giant single step can't allocate huge buffers or create tens of
// thousands of renderables in one synchronous pass (the "crash after long run").
const MAX_POLL_READ = 262_144; // max bytes read per poll tick (256KB)
const MAX_STEP_CHARS = 50_000; // max chars rendered per step (~1250 wrapped lines)

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKJHF]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function capText(s: unknown, max = MAX_STEP_CHARS): string {
  if (s == null) return "";
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n… [truncated ${(str.length - max).toLocaleString()} chars]`;
}

// ─── Session State & Database ─────────────────────────────────────────────────

export type SessionState = "running" | "idle" | "stuck" | "killed" | "unknown";

export interface ConversationSummaryRow {
  conversation_id: string;
  title?: string;
  preview?: string;
  step_count?: number;
  last_modified_time?: string | number | Date;
  last_user_input_time?: string | number | Date;
  status?: string;
  not_fully_idle?: number | boolean;
  killed?: number | boolean;
  agent_name?: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
}

export function parseSqliteDate(val: unknown): number {
  if (!val) return 0;
  if (typeof val === "number") return val;
  if (val instanceof Date) return val.getTime();
  if (typeof val === "string") {
    let s = val.trim();
    if (!s || s.startsWith("0001-01-01")) return 0;
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(s)) {
      s = s.replace(" ", "T");
    }
    if (!s.endsWith("Z") && !/[+-]\d{2}(?::?\d{2})?$/.test(s)) {
      s = s + "Z";
    }
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

const transcriptLiveCache = new Map<string, { mtimeMs: number | undefined; at: number }>();
const TRANSCRIPT_LIVE_TTL_MS = 1000;

export function getTranscriptLiveMs(
  conversationId: string,
  now = Date.now(),
): number | undefined {
  if (!conversationId) return undefined;
  // #4 perf: memoize per conversation so per-descendant liveness checks don't fire
  // a fresh statSync for every session on every 250ms UI tick. Cache the ABSOLUTE
  // mtime (not the relative age) so the returned age stays correct as `now` advances;
  // the `now >= hit.at` guard rejects clock-skew-backwards cache hits.
  const hit = transcriptLiveCache.get(conversationId);
  if (hit && now >= hit.at && now - hit.at < TRANSCRIPT_LIVE_TTL_MS) {
    return hit.mtimeMs === undefined ? undefined : Math.max(0, now - hit.mtimeMs);
  }
  const logPath = path.join(
    BRAIN_DIR,
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  let mtimeMs: number | undefined;
  try {
    mtimeMs = fs.statSync(logPath).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  transcriptLiveCache.set(conversationId, { mtimeMs, at: now });
  return mtimeMs === undefined ? undefined : Math.max(0, now - mtimeMs);
}

export function deriveSessionState(
  row: ConversationSummaryRow | null | undefined,
  opts?: { now?: number; staleMs?: number; liveMs?: number; inFlight?: boolean },
): SessionState {
  if (!row) return "unknown";
  if (row.killed) return "killed";

  const status = row.status ?? "";
  const notFullyIdle = Boolean(row.not_fully_idle);
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const liveMs = opts?.liveMs;
  const inFlight = Boolean(opts?.inFlight);
  const isTranscriptFresh = liveMs != null && liveMs < staleMs;

  const isBusy =
    notFullyIdle ||
    (status !== "" && status !== "CASCADE_RUN_STATUS_IDLE") ||
    isTranscriptFresh ||
    inFlight;

  if (isBusy) {
    const modTime = parseSqliteDate(row.last_modified_time);
    const dbAge = now - modTime;
    // #8: a future DB timestamp (clock skew) must not look "fresh".
    const isDbFresh = modTime > 0 && dbAge >= 0 && dbAge < staleMs;
    // #2: an unset/zero last_modified_time only implies "running" when we have NO
    // transcript signal. With a known transcript age, staleness wins — otherwise a
    // dead child row stays "running" forever and the auto-follow locks onto it.
    const unknownDbOnly = liveMs === undefined && modTime <= 0;
    if (isDbFresh || isTranscriptFresh || inFlight || unknownDbOnly) {
      return "running";
    }
    return "stuck";
  }

  if (status === "CASCADE_RUN_STATUS_IDLE" && !notFullyIdle) {
    return "idle";
  }

  return "unknown";
}

let dbOpenWarned = false;

export class SummaryDbReader {
  private db: any = null;
  private isClosed = false;

  private init() {
    if (this.db || this.isClosed || !fs.existsSync(CONVERSATION_DB_PATH)) return;
    try {
      if (typeof (globalThis as any).Bun !== "undefined") {
        const { Database } = esmRequire("bun:sqlite");
        let handle: any;
        try {
          handle = new Database(CONVERSATION_DB_PATH, { readonly: true });
          handle.query("SELECT 1").get();
        } catch {
          try {
            handle?.close();
          } catch {}
          handle = new Database(CONVERSATION_DB_PATH);
        }
        try {
          handle.run("PRAGMA busy_timeout = 5000;");
        } catch {}
        this.db = { type: "bun", handle };
      } else {
        const { DatabaseSync } = esmRequire("node:sqlite");
        let handle: any;
        try {
          handle = new DatabaseSync(CONVERSATION_DB_PATH, { readOnly: true });
          handle.prepare("SELECT 1").get();
        } catch {
          try {
            handle?.close();
          } catch {}
          handle = new DatabaseSync(CONVERSATION_DB_PATH);
        }
        try {
          handle.exec("PRAGMA busy_timeout = 5000;");
        } catch {}
        this.db = { type: "node", handle };
      }
    } catch (err) {
      this.db = null;
      if (!dbOpenWarned) {
        dbOpenWarned = true;
        console.error(
          "[agy-live] Warning: unable to open conversation_summaries.db in readonly mode:",
          (err as any)?.message || err,
        );
      }
    }
  }

  getSummary(conversationId: string): ConversationSummaryRow | null {
    if (!conversationId) return null;
    this.init();
    if (!this.db) return null;
    try {
      if (this.db.type === "bun") {
        const query = this.db.handle.query(
          "SELECT conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, status, not_fully_idle, killed, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
        );
        return (query.get(conversationId) as ConversationSummaryRow) || null;
      }
      if (this.db.type === "node") {
        const stmt = this.db.handle.prepare(
          "SELECT conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, status, not_fully_idle, killed, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
        );
        return (stmt.get(conversationId) as ConversationSummaryRow) || null;
      }
    } catch {
      return null;
    }
    return null;
  }

  getDescendants(parentId: string): ConversationSummaryRow[] {
    if (!parentId) return [];
    this.init();
    if (!this.db) return [];
    try {
      const sql = `
WITH RECURSIVE descendants(conversation_id) AS (
  SELECT conversation_id FROM conversation_summaries WHERE parent_conversation_id = ?
  UNION ALL
  SELECT c.conversation_id FROM conversation_summaries c
  JOIN descendants d ON c.parent_conversation_id = d.conversation_id
)
SELECT c.conversation_id, c.title, c.preview, c.step_count, c.last_modified_time, c.last_user_input_time, c.status, c.not_fully_idle, c.killed, c.agent_name, c.parent_conversation_id, c.nesting_depth
FROM conversation_summaries c
JOIN descendants d ON c.conversation_id = d.conversation_id
WHERE c.conversation_id != ?
ORDER BY c.last_modified_time DESC
      `.trim();
      if (this.db.type === "bun") {
        const query = this.db.handle.query(sql);
        return (query.all(parentId, parentId) as ConversationSummaryRow[]) || [];
      }
      if (this.db.type === "node") {
        const stmt = this.db.handle.prepare(sql);
        return (stmt.all(parentId, parentId) as ConversationSummaryRow[]) || [];
      }
    } catch {
      return [];
    }
    return [];
  }

  getLatest(): ConversationSummaryRow | null {
    this.init();
    if (!this.db) return null;
    try {
      const sql = `SELECT conversation_id, title, preview, step_count, last_modified_time, last_user_input_time, status, not_fully_idle, killed, agent_name, parent_conversation_id, nesting_depth FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 1`;
      if (this.db.type === "bun") {
        return (this.db.handle.query(sql).get() as ConversationSummaryRow) || null;
      }
      if (this.db.type === "node") {
        return (this.db.handle.prepare(sql).get() as ConversationSummaryRow) || null;
      }
    } catch {
      return null;
    }
    return null;
  }

  close() {
    this.isClosed = true;
    if (this.db) {
      try {
        if (this.db.type === "bun") this.db.handle.close();
        if (this.db.type === "node") this.db.handle.close();
      } catch {}
      this.db = null;
    }
  }
}

export const summaryReader = new SummaryDbReader();

// ─── Card & DOM Render Helpers ────────────────────────────────────────────────

export function destroyRenderable(r: Renderable) {
  if (typeof (r as any).destroyRecursively === "function") {
    (r as any).destroyRecursively();
  } else if (typeof (r as any).destroy === "function") {
    (r as any).destroy();
  }
}

export type PageItem =
  | { kind: "line"; text: string; fg?: string; bg?: string }
  | { kind: "card"; accent: string; lines: { text: string; fg?: string; isTitle?: boolean }[] };

export const domBoxes = new WeakMap<PageItem, BoxRenderable>();

let pushCount = 0;

export function notePushes(n: number, scrollBox: any) {
  pushCount += n;
  if (
    Math.floor(pushCount / 20) > Math.floor((pushCount - n) / 20) &&
    scrollBox &&
    typeof scrollBox.getChildrenCount === "function" &&
    scrollBox.getChildrenCount() > 300
  ) {
    const children = [...scrollBox.getChildren()] as Renderable[];
    const toRemove = children.slice(0, children.length - 200);
    for (let i = toRemove.length - 1; i >= 0; i--) {
      destroyRenderable(toRemove[i]);
    }
  }
}

export function createCardLineText(
  renderer: any,
  line: { text: string; fg?: string },
): TextRenderable {
  return new TextRenderable(renderer, {
    content: line.text,
    fg: line.fg,
    wrapMode: "word",
    selectable: true,
    selectionBg: "#2563eb",
    selectionFg: "#ffffff",
  } as any);
}

export function buildCardBox(
  renderer: any,
  parent: any,
  opts: {
    title?: string;
    lines: { text: string; fg?: string; isTitle?: boolean }[];
    accent?: string;
  },
): BoxRenderable {
  const titleLine = opts.lines.find((l) => l.isTitle);
  const accent =
    opts.accent ||
    titleLine?.fg ||
    STYLE.ACCENT.tool;
  const box = new BoxRenderable(renderer, {
    border: ["left"],
    borderColor: accent,
    customBorderChars: STYLE.BORDER_CHARS,
    backgroundColor: STYLE.CARD_BG,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    width: "100%",
    flexShrink: 0,
  });

  const allLines = [...opts.lines];
  if (opts.title && !titleLine) {
    allLines.unshift({ text: opts.title, fg: accent, isTitle: true });
  }

  for (const line of allLines) {
    const lineWithFg = line.isTitle && !line.fg ? { ...line, fg: accent } : line;
    box.add(createCardLineText(renderer, lineWithFg));
  }

  if (parent && typeof parent.add === "function") {
    parent.add(box);
  }

  return box;
}

export function cardAppend(
  item: PageItem,
  line: { text: string; fg?: string },
): boolean {
  if (item.kind !== "card") return false;
  item.lines.push(line);
  const box = domBoxes.get(item);
  if (box && (box as any).isDestroyed) {
    domBoxes.delete(item);
    return false;
  }
  if (box) {
    const ctx = (box as any).ctx ?? (box as any).renderer;
    box.add(createCardLineText(ctx, line));
    return true;
  }
  return false;
}

export function replayPageInto(
  renderer: any,
  parent: any,
  items: PageItem[],
): void {
  for (const item of items) {
    if (item.kind === "line") {
      const opts: any = { content: item.text, fg: item.fg, wrapMode: "none", width: "100%" };
      if (item.bg) opts.bg = item.bg;
      parent.add(new TextRenderable(renderer, opts));
    } else if (item.kind === "card") {
      buildCardBox(renderer, parent, {
        lines: item.lines,
        accent: item.accent,
      });
    }
  }
}

// ─── Left-Pane Header (C4) ───────────────────────────────────────────────────

export interface LeftPaneHeaderOpts {
  sessionId: string;
  projectDir?: string;
  model?: string;
  state?: SessionState | string;
  followingChildId?: string | null;
}

export function formatLeftPaneHeader(opts: LeftPaneHeaderOpts): {
  info: string;
  pill: string;
  pillFg: string;
  fullText: string;
} {
  const sid8 = (opts.sessionId || "").slice(0, 8);
  const proj =
    opts.projectDir && opts.projectDir !== "(Unbound session)"
      ? path.basename(opts.projectDir)
      : "Unbound";
  const model = opts.model || "Gemini 3.7 Flash";
  const state = (opts.state || "unknown").toLowerCase();

  let pill = "? UNKNOWN";
  let pillFg = "#6b7280";

  switch (state) {
    case "running":
      pill = opts.followingChildId ? "● RUN (child)" : "● RUNNING";
      pillFg = "#4ade80";
      break;
    case "idle":
      pill = "○ IDLE";
      pillFg = "#94a3b8";
      break;
    case "stuck":
      pill = "▲ STUCK";
      pillFg = "#fbbf24";
      break;
    case "killed":
      pill = "✕ KILLED";
      pillFg = "#ef4444";
      break;
    case "unknown":
    default:
      pill = "? UNKNOWN";
      pillFg = "#6b7280";
      break;
  }

  const info = `${sid8} · ${proj} · ${model}`;
  const fullText = ` ${info} ${pill} `;
  return { info, pill, pillFg, fullText };
}

function getRenderableText(node: any): string {
  if (!node) return "";
  if (Array.isArray(node.chunks)) {
    return node.chunks.map((c: any) => c.text ?? "").join("");
  }
  if (Array.isArray(node.content?.chunks)) {
    return node.content.chunks.map((c: any) => c.text ?? "").join("");
  }
  return String(node.content ?? "");
}

export function buildLeftPaneHeader(
  renderer: any,
  opts: LeftPaneHeaderOpts,
): BoxRenderable {
  const formatted = formatLeftPaneHeader(opts);
  const hdr = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    backgroundColor: "#1a1a2e",
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    gap: 1,
    overflow: "hidden",
  });

  const infoTxt = new TextRenderable(renderer, {
    content: formatted.info,
    fg: "#94a3b8",
  });

  const pillTxt = new TextRenderable(renderer, {
    content: formatted.pill,
    fg: formatted.pillFg as any,
    attributes: BOLD_ATTR,
  });

  hdr.add(infoTxt);
  hdr.add(pillTxt);

  Object.defineProperty(hdr, "text", {
    get() {
      const iText = getRenderableText(infoTxt);
      const pText = getRenderableText(pillTxt);
      return ` ${iText} ${pText} `;
    },
    configurable: true,
  });
  Object.defineProperty(hdr, "content", {
    get() {
      return (hdr as any).text;
    },
    configurable: true,
  });

  return hdr;
}

export function updateLeftPaneHeader(
  hdr: BoxRenderable,
  opts: LeftPaneHeaderOpts,
): void {
  if (!hdr || (hdr as any).isDestroyed) return;
  const formatted = formatLeftPaneHeader(opts);
  const children = (hdr as any).getChildren?.() || [];
  const infoTxt = children[0] as TextRenderable | undefined;
  const pillTxt = children[1] as TextRenderable | undefined;

  if (infoTxt && !(infoTxt as any).isDestroyed) {
    infoTxt.content = formatted.info;
  }
  if (pillTxt && !(pillTxt as any).isDestroyed) {
    pillTxt.content = formatted.pill;
    pillTxt.fg = formatted.pillFg as any;
  }
}

export function unescapeCodeString(str: any): string {
  if (!str || typeof str !== "string") return "";
  let clean = str;
  if (
    clean.includes("\\n") ||
    clean.includes('\\"') ||
    clean.includes("\\t") ||
    clean.includes("\\r")
  ) {
    clean = clean
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "  ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (clean.startsWith('"') && clean.endsWith('"') && clean.length >= 2) {
    clean = clean.slice(1, -1);
  }
  return clean;
}

export type RouteAction =
  | { type: "open_card"; item: PageItem; accent: string }
  | { type: "append"; item: PageItem; line: { text: string; fg?: string } }
  | { type: "bare"; text: string; fg?: string };

export interface RouteContext {
  renderer: any;
  parent: any;
  pages: PageItem[][];
  pageMode: boolean;
  pushLine: (txt: string, fg?: string, bg?: string) => void;
  notePushes: (n: number, scrollBox?: any) => void;
}

export function routeStep(
  step: any,
  q: { pending: (PageItem | null)[] },
  emit: (a: RouteAction) => void,
): void {
  if (!step) return;

  // 1. Hard resets: USER_INPUT, CHECKPOINT, SYSTEM_MESSAGE
  if (
    step.type === "USER_INPUT" ||
    step.type === "CHECKPOINT" ||
    step.type === "SYSTEM_MESSAGE"
  ) {
    q.pending.length = 0;
    return;
  }

  // 2. ERROR_MESSAGE: clears q.pending, renders bare, never consumes a slot
  if (step.type === "ERROR_MESSAGE") {
    q.pending.length = 0;
    const raw = String(step.error || step.content || "Error");
    emit({ type: "bare", text: `⚠️  [ERROR] ${raw}`, fg: STYLE.ACCENT.error });
    return;
  }

  // 3. PLANNER_RESPONSE: tool calls or turn-final assistant text
  if (step.type === "PLANNER_RESPONSE") {
    const hasTools = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
    if (hasTools) {
      for (const tc of step.tool_calls) {
        const name = tc.name || "tool";
        const args = tc.args || {};
        switch (name) {
          case "write_to_file": {
            const file = args.TargetFile || args.target_file || "";
            const rel = file ? path.relative(process.cwd(), file) || file : "";
            const raw = unescapeCodeString(capText(args.CodeContent || ""));
            const lines = raw ? raw.split("\n") : [];
            const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
              { text: `📝 [WRITE FILE] ${rel}`, fg: "#4ade80", isTitle: true },
            ];
            if (raw) {
              for (let k = 0; k < lines.length; k++) {
                cardLines.push({
                  text: `  + ${String(1 + k).padStart(4)}: ${lines[k]}`,
                  fg: "#4ade80",
                });
              }
            }
            const item: PageItem = {
              kind: "card",
              accent: STYLE.ACCENT.tool,
              lines: cardLines,
            };
            q.pending.push(item);
            emit({ type: "open_card", item, accent: STYLE.ACCENT.tool });
            break;
          }
          case "replace_file_content": {
            const file = args.TargetFile || args.target_file || "";
            const rel = file ? path.relative(process.cwd(), file) || file : "";
            const sLine = args.StartLine ? Number(args.StartLine) : 1;
            const rawT = unescapeCodeString(capText(args.TargetContent || ""));
            const rawR = unescapeCodeString(capText(args.ReplacementContent || ""));
            const tLines = rawT ? rawT.split("\n") : [];
            const rLines = rawR ? rawR.split("\n") : [];
            const total = Math.max(tLines.length, rLines.length);

            const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
              { text: `✏️  [DIFF EDIT] ${rel} (Line ${sLine})`, fg: "#fbbf24", isTitle: true },
            ];

            for (let k = 0; k < total; k++) {
              if (k < tLines.length && k < rLines.length && tLines[k] !== rLines[k]) {
                cardLines.push({
                  text: `  - ${String(sLine + k).padStart(4)}: ${tLines[k]}`,
                  fg: "#f87171",
                });
                cardLines.push({
                  text: `  + ${String(sLine + k).padStart(4)}: ${rLines[k]}`,
                  fg: "#4ade80",
                });
              } else if (k < tLines.length && k >= rLines.length) {
                cardLines.push({
                  text: `  - ${String(sLine + k).padStart(4)}: ${tLines[k]}`,
                  fg: "#f87171",
                });
              } else if (k < rLines.length && k >= tLines.length) {
                cardLines.push({
                  text: `  + ${String(sLine + k).padStart(4)}: ${rLines[k]}`,
                  fg: "#4ade80",
                });
              } else if (k < rLines.length) {
                cardLines.push({
                  text: `    ${String(sLine + k).padStart(4)}: ${rLines[k]}`,
                  fg: "#94a3b8",
                });
              }
            }
            const item: PageItem = {
              kind: "card",
              accent: STYLE.ACCENT.tool,
              lines: cardLines,
            };
            q.pending.push(item);
            emit({ type: "open_card", item, accent: STYLE.ACCENT.tool });
            break;
          }
          case "run_command": {
            const cmd = unescapeCodeString(args.CommandLine || args.command || "").trim();
            const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
              { text: "💻 [BASH EXECUTION]", fg: "#38bdf8", isTitle: true },
              { text: `  $ ${cmd}`, fg: "#fde047" },
            ];
            const item: PageItem = {
              kind: "card",
              accent: STYLE.ACCENT.tool,
              lines: cardLines,
            };
            q.pending.push(item);
            emit({ type: "open_card", item, accent: STYLE.ACCENT.tool });
            break;
          }
          case "view_file": {
            const file = args.AbsolutePath || args.file || "";
            const rel = file ? path.relative(process.cwd(), file) || file : "";
            const sLine = args.StartLine ? ` (L${args.StartLine}-${args.EndLine || ""})` : "";
            q.pending.push(null);
            emit({ type: "bare", text: `🔍 [VIEW FILE] ${rel}${sLine}`, fg: "#38bdf8" });
            break;
          }
          case "grep_search":
          case "find_by_name": {
            const query = args.Query || args.Pattern || "";
            q.pending.push(null);
            emit({ type: "bare", text: `🔎 [SEARCH] ${name} -> "${query}"`, fg: "#818cf8" });
            break;
          }
          case "schedule": {
            const sec = parseInt(args.DurationSeconds || args.duration_seconds || "60", 10);
            const p = String(args.Prompt || args.prompt || "Waiting for task");
            q.pending.push(null);
            emit({ type: "bare", text: `⏳ [SCHEDULE] "${p}" (${sec}s)`, fg: "#f59e0b" });
            break;
          }
          default: {
            const summary = capText(args.toolSummary || tc.name || "tool", 200);
            q.pending.push(null);
            emit({ type: "bare", text: `🔧 [TOOL: ${name}] ${summary}`, fg: "#93c5fd" });
            break;
          }
        }
      }
      return;
    } else if (step.content) {
      // Turn-final assistant text (assistant text with NO tool_calls)
      q.pending.length = 0;
      return;
    }
    return;
  }

  // 4. Tool Output Steps (GENERIC, etc. with step.content)
  if (step.content && typeof step.content === "string") {
    const target =
      step.status === "RUNNING" && q.pending.length > 0
        ? q.pending[0]
        : q.pending.shift();
    const raw = unescapeCodeString(capText(step.content)).trim();
    if (raw) {
      const lines = raw.split("\n");
      if (target) {
        for (const l of lines) {
          emit({
            type: "append",
            item: target,
            line: { text: l.trimEnd(), fg: "#94a3b8" },
          });
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {
            emit({ type: "bare", text: "", fg: "#94a3b8" });
            continue;
          }
          const text = i === 0 ? `↳ [Output] ${l.trimEnd()}` : l.trimEnd();
          emit({ type: "bare", text, fg: "#94a3b8" });
        }
      }
    }
  }
}

export function applyRouteAction(action: RouteAction, ctx: RouteContext): void {
  switch (action.type) {
    case "open_card": {
      let page = ctx.pages[ctx.pages.length - 1];
      if (!page || page.length >= 200) {
        page = [];
        ctx.pages.push(page);
      }
      page.push(action.item);
      if (!ctx.pageMode) {
        const box = buildCardBox(ctx.renderer, ctx.parent, {
          lines: action.item.lines,
          accent: action.accent,
        });
        domBoxes.set(action.item, box);
        ctx.notePushes(action.item.lines.length, ctx.parent);
      }
      break;
    }
    case "append": {
      const added = cardAppend(action.item, action.line);
      if (added) {
        ctx.notePushes(1, ctx.parent);
      }
      break;
    }
    case "bare": {
      ctx.pushLine(STYLE.GUTTER + action.text, action.fg);
      break;
    }
  }
}

export function runSelfTest(): void {
  function assertTest(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`❌ Assertion failed: ${msg}`);
      process.exit(1);
    }
  }

  const now = 1_700_000_000_000;
  const staleMs = 60_000;

  // Date parsing assertions
  assertTest(
    parseSqliteDate("2026-09-15 16:46:13.060725+00:00") ===
      Date.parse("2026-09-15T16:46:13.060725+00:00"),
    "parseSqliteDate with timezone offset",
  );
  assertTest(
    parseSqliteDate("2026-09-15 16:46:13") === Date.parse("2026-09-15T16:46:13Z"),
    "parseSqliteDate naive string",
  );
  assertTest(
    parseSqliteDate("2026-09-15 16:46:13Z") === Date.parse("2026-09-15T16:46:13Z"),
    "parseSqliteDate ISO string",
  );
  assertTest(parseSqliteDate("0001-01-01 00:00:00+00:00") === 0, "parseSqliteDate zero date");
  assertTest(parseSqliteDate("") === 0, "parseSqliteDate empty string");
  assertTest(parseSqliteDate(null) === 0, "parseSqliteDate null");

  // 1. Killed
  const s1 = deriveSessionState({ conversation_id: "1", killed: 1 }, { now, staleMs });
  assertTest(s1 === "killed", `Expected killed, got ${s1}`);

  // 2. Running (busy & DB fresh)
  const s2 = deriveSessionState(
    {
      conversation_id: "2",
      status: "CASCADE_RUN_STATUS_RUNNING",
      not_fully_idle: 1,
      last_modified_time: new Date(now - 5000).toISOString(),
    },
    { now, staleMs },
  );
  assertTest(s2 === "running", `Expected running, got ${s2}`);

  // 3. Running (DB stale, but transcript live stream fresh)
  const s2b = deriveSessionState(
    {
      conversation_id: "2b",
      status: "CASCADE_RUN_STATUS_RUNNING",
      not_fully_idle: 1,
      last_modified_time: new Date(now - 120_000).toISOString(),
    },
    { now, staleMs, liveMs: 3000 },
  );
  assertTest(s2b === "running", `Expected running on fresh transcript live stream, got ${s2b}`);

  // 4a. Idle
  const s3 = deriveSessionState(
    {
      conversation_id: "3",
      status: "CASCADE_RUN_STATUS_IDLE",
      not_fully_idle: 0,
    },
    { now, staleMs },
  );
  assertTest(s3 === "idle", `Expected idle, got ${s3}`);

  // 4b. Idle with stale transcript (real mtime > staleMs) -> remains idle
  const s3b = deriveSessionState(
    {
      conversation_id: "3b",
      status: "CASCADE_RUN_STATUS_IDLE",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 120_000).toISOString(),
    },
    { now, staleMs, liveMs: 120_000 },
  );
  assertTest(s3b === "idle", `Expected idle for idle status with stale transcript, got ${s3b}`);

  // 4c. Idle status with fresh transcript (turn streaming before DB commit) -> running
  const s3c = deriveSessionState(
    {
      conversation_id: "3c",
      status: "CASCADE_RUN_STATUS_IDLE",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 120_000).toISOString(),
    },
    { now, staleMs, liveMs: 2000 },
  );
  assertTest(s3c === "running", `Expected running for fresh transcript write, got ${s3c}`);

  // 5. Busy-stale = stuck (DB stale AND transcript live stream stale)
  const s4 = deriveSessionState(
    {
      conversation_id: "4",
      status: "CASCADE_RUN_STATUS_RUNNING",
      not_fully_idle: 1,
      last_modified_time: new Date(now - 120_000).toISOString(),
    },
    { now, staleMs, liveMs: 90_000 },
  );
  assertTest(s4 === "stuck", `Expected stuck, got ${s4}`);

  // 6. Blank legacy = unknown
  const s5 = deriveSessionState(
    {
      conversation_id: "5",
      status: "",
      not_fully_idle: 0,
      killed: 0,
    },
    { now, staleMs },
  );
  assertTest(s5 === "unknown", `Expected unknown, got ${s5}`);

  // 7a. Fresh busy with blank status = running
  const s6 = deriveSessionState(
    {
      conversation_id: "6",
      status: "",
      not_fully_idle: 1,
      last_modified_time: new Date(now - 10_000).toISOString(),
    },
    { now, staleMs },
  );
  assertTest(s6 === "running", `Expected running, got ${s6}`);

  // 7b. Descendant child with blank status & fresh transcript -> running (auto-follow trigger)
  const s6b = deriveSessionState(
    {
      conversation_id: "6b",
      status: "",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 300_000).toISOString(),
    },
    { now, staleMs, liveMs: 4000 },
  );
  assertTest(s6b === "running", `Expected running for active child with fresh transcript, got ${s6b}`);

  // 7c. Descendant child with blank status & stale transcript -> unknown (not running)
  const s6c = deriveSessionState(
    {
      conversation_id: "6c",
      status: "",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 300_000).toISOString(),
    },
    { now, staleMs, liveMs: 300_000 },
  );
  assertTest(s6c === "unknown", `Expected unknown for idle child with stale transcript, got ${s6c}`);

  // 8. Null row = unknown
  const s7 = deriveSessionState(null, { now, staleMs });
  assertTest(s7 === "unknown", `Expected unknown for null, got ${s7}`);

  // 9. getTranscriptLiveMs helper checks
  assertTest(getTranscriptLiveMs("") === undefined, "getTranscriptLiveMs empty id returns undefined");
  assertTest(
    getTranscriptLiveMs("non-existent-uuid-test") === undefined,
    "getTranscriptLiveMs missing file returns undefined",
  );

  // 10. inFlight overrides stale transcript mtime to running
  const s8 = deriveSessionState(
    {
      conversation_id: "8",
      status: "CASCADE_RUN_STATUS_IDLE",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 120_000).toISOString(),
    },
    { now, staleMs, liveMs: 120_000, inFlight: true },
  );
  assertTest(
    s8 === "running",
    `Expected running for inFlight session with stale transcript, got ${s8}`,
  );

  const s8b = deriveSessionState(
    {
      conversation_id: "8b",
      status: "",
      not_fully_idle: 0,
      last_modified_time: new Date(now - 300_000).toISOString(),
    },
    { now, staleMs, liveMs: 300_000, inFlight: true },
  );
  assertTest(
    s8b === "running",
    `Expected running for inFlight session with blank status, got ${s8b}`,
  );

  const s8c = deriveSessionState(
    {
      conversation_id: "8c",
      killed: 1,
    },
    { now, staleMs, inFlight: true },
  );
  assertTest(s8c === "killed", `Expected killed taking precedence over inFlight, got ${s8c}`);

  const sZero = deriveSessionState(
    {
      conversation_id: "zero",
      status: "CASCADE_RUN_STATUS_RUNNING",
      last_modified_time: "0001-01-01 00:00:00",
      killed: 0,
      not_fully_idle: 0,
    },
    { now, staleMs, liveMs: staleMs * 5 },
  );
  assertTest(sZero === "stuck", `Expected stuck for zero-date + stale transcript, got ${sZero}`);

  const sFuture = deriveSessionState(
    {
      conversation_id: "skew",
      status: "CASCADE_RUN_STATUS_RUNNING",
      last_modified_time: new Date(now + staleMs * 4).toISOString(),
      killed: 0,
      not_fully_idle: 0,
    },
    { now, staleMs, liveMs: staleMs * 5 },
  );
  assertTest(sFuture === "stuck", `Expected stuck for future DB timestamp, got ${sFuture}`);

  // 26. pushCard Box assertion: left-accent border and STYLE.CARD_BG background
  const stubRenderer: any = {
    requestRender: () => {},
    registerLifecyclePass: () => {},
    unregisterLifecyclePass: () => {},
  };
  const stubRoot: any = {
    width: 80,
    children: [] as any[],
    add(child: any) {
      this.children.push(child);
    },
  };
  function selfTestPushCard(
    lines: { text: string; fg?: string; isTitle?: boolean }[],
    kind?: "user" | "tool" | "thinking" | "error",
  ) {
    const accent =
      kind ? STYLE.ACCENT[kind] : (lines.find((l) => l.isTitle)?.fg ?? STYLE.ACCENT.tool);
    return buildCardBox(stubRenderer, stubRoot, { lines, accent });
  }

  const cardBox = selfTestPushCard(
    [
      { text: "Test Card Title", fg: STYLE.ACCENT.tool, isTitle: true },
      { text: "Test line 1" },
    ],
    "tool",
  );

  const isCardBg =
    (cardBox.backgroundColor as any) === STYLE.CARD_BG ||
    (typeof cardBox.backgroundColor?.equals === "function" &&
      cardBox.backgroundColor.equals(parseColor(STYLE.CARD_BG)));

  assertTest(
    Array.isArray(cardBox.border) &&
      cardBox.border.includes("left") &&
      Boolean(isCardBg) &&
      stubRoot.children.includes(cardBox),
    "pushCard into stubbed root constructs a Box with border containing 'left' and backgroundColor === STYLE.CARD_BG",
  );

  // 27. T3 PageItem card replay & domBoxes assertions
  const replayedCardItem: PageItem = {
    kind: "card",
    accent: STYLE.ACCENT.tool,
    lines: [
      { text: "-removed", fg: "#f87171" },
      { text: "+added", fg: "#4ade80" },
    ],
  };
  const replayedLine1: PageItem = { kind: "line", text: "Line 1", fg: "#d1d5db" };
  const replayedLine2: PageItem = { kind: "line", text: "Line 2", fg: "#d1d5db" };
  const replayedLineWithBg: PageItem = {
    kind: "line",
    text: "Line with bg",
    fg: "#ffffff",
    bg: STYLE.CARD_BG,
  };
  const testPages: PageItem[][] = [
    [replayedCardItem, replayedLine1, replayedLine2, replayedLineWithBg],
  ];

  const replayRoot: any = {
    width: 80,
    children: [] as any[],
    add(child: any) {
      this.children.push(child);
    },
  };

  replayPageInto(stubRenderer, replayRoot, testPages[0]);

  const replayedCardBox = replayRoot.children.find(
    (c: any) => c instanceof BoxRenderable,
  );
  const isReplayedCardBg =
    replayedCardBox &&
    ((replayedCardBox.backgroundColor as any) === STYLE.CARD_BG ||
      (typeof replayedCardBox.backgroundColor?.equals === "function" &&
        replayedCardBox.backgroundColor.equals(parseColor(STYLE.CARD_BG))));

  assertTest(
    Boolean(
      replayedCardBox &&
        Array.isArray(replayedCardBox.border) &&
        replayedCardBox.border.includes("left") &&
        isReplayedCardBg,
    ),
    "replayPageInto constructs a Box child with border including 'left' and backgroundColor === STYLE.CARD_BG",
  );

  assertTest(
    !domBoxes.has(replayedCardItem),
    "replayed box is NOT present in domBoxes (live-only WeakMap registry)",
  );

  assertTest(
    replayedCardItem.kind === "card" &&
      replayedCardItem.lines[0]?.fg === "#f87171" &&
      replayedCardItem.lines[1]?.fg === "#4ade80",
    "PageItem preserves per-line fg values intact across replay",
  );

  const replayedBgTr = replayRoot.children[3];
  const replayedNoBgTr = replayRoot.children[1];
  const isTextCardBg =
    replayedBgTr &&
    ((replayedBgTr as any).bg === STYLE.CARD_BG ||
      (replayedBgTr as any).backgroundColor === STYLE.CARD_BG ||
      (typeof (replayedBgTr as any).bg?.equals === "function" &&
        (replayedBgTr as any).bg.equals(parseColor(STYLE.CARD_BG))));
  const hasNoBg =
    replayedNoBgTr &&
    (!(replayedNoBgTr as any).bg ||
      (replayedNoBgTr as any).bg.a === 0 ||
      !(replayedNoBgTr as any).bg.equals?.(parseColor(STYLE.CARD_BG)));

  assertTest(
    Boolean(isTextCardBg && hasNoBg),
    "PageItem line background survives replay with STYLE.CARD_BG while unstyled lines have no bg set",
  );

  // 28. T3 prune-safety: cardAppend with destroyed box
  const liveCardItem: PageItem = {
    kind: "card",
    accent: STYLE.ACCENT.tool,
    lines: [{ text: "initial live line" }],
  };
  const liveRoot: any = {
    children: [] as any[],
    add(child: any) {
      this.children.push(child);
    },
  };
  const liveBox = buildCardBox(stubRenderer, liveRoot, {
    lines: liveCardItem.lines,
    accent: liveCardItem.accent,
  });
  domBoxes.set(liveCardItem, liveBox);
  assertTest(domBoxes.has(liveCardItem), "live card box registered in domBoxes");

  liveBox.destroy();

  let appendThrew = false;
  try {
    cardAppend(liveCardItem, { text: "appended after prune", fg: "#4ade80" });
  } catch {
    appendThrew = true;
  }

  assertTest(
    !appendThrew &&
      liveCardItem.lines.length === 2 &&
      liveCardItem.lines[1]?.text === "appended after prune" &&
      !domBoxes.has(liveCardItem),
    "prune-safety: cardAppend appends model line, does not throw, and cleans up destroyed domBoxes entry",
  );

  // 29. T4 routeStep selftest (a): bash-call step then two output entries
  const qA: { pending: (PageItem | null)[] } = { pending: [] };
  const actionsA: RouteAction[] = [];
  const emitA = (a: RouteAction) => actionsA.push(a);

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "run_command",
          args: { CommandLine: "echo hello" },
        },
      ],
    },
    qA,
    emitA,
  );

  routeStep(
    {
      type: "GENERIC",
      status: "RUNNING",
      content: "running output chunk",
    },
    qA,
    emitA,
  );

  routeStep(
    {
      type: "GENERIC",
      status: "DONE",
      content: "final output chunk",
    },
    qA,
    emitA,
  );

  const openedCardA = actionsA[0]?.type === "open_card" ? actionsA[0].item : null;
  assertTest(
    actionsA.length > 0 &&
      actionsA[0].type === "open_card" &&
      actionsA.slice(1).every((a) => a.type === "append" && a.item === openedCardA) &&
      actionsA.filter((a) => a.type === "bare").length === 0,
    "T4 (a): bash-call step then two output entries emits one open_card, appends to the same item, and zero bare",
  );

  // 30. T4 routeStep selftest (b): view_file step + output -> pending [null], output -> bare actions, no card item
  const qB: { pending: (PageItem | null)[] } = { pending: [] };
  const actionsB: RouteAction[] = [];
  const emitB = (a: RouteAction) => actionsB.push(a);

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "view_file",
          args: { AbsolutePath: "/tmp/foo.ts", StartLine: 1, EndLine: 10 },
        },
      ],
    },
    qB,
    emitB,
  );

  assertTest(
    qB.pending.length === 1 && qB.pending[0] === null,
    "T4 (b): view_file step pushes [null] to q.pending",
  );

  routeStep(
    {
      type: "GENERIC",
      content: "file line 1\nfile line 2",
    },
    qB,
    emitB,
  );

  assertTest(
    actionsB.every((a) => a.type === "bare") &&
      actionsB.length === 3 &&
      actionsB.every((a) => (a as any).item === undefined),
    "T4 (b): view_file and output emit bare actions only with no card item created",
  );

  // 31. T4 routeStep selftest (c): MULTI-TOOL step [write, run_command] then two output steps -> FIFO
  const qC: { pending: (PageItem | null)[] } = { pending: [] };
  const actionsC: RouteAction[] = [];
  const emitC = (a: RouteAction) => actionsC.push(a);

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [
        {
          name: "write_to_file",
          args: { TargetFile: "/tmp/test.ts", CodeContent: "test" },
        },
        {
          name: "run_command",
          args: { CommandLine: "bun test" },
        },
      ],
    },
    qC,
    emitC,
  );

  const openCardsC = actionsC.filter((a) => a.type === "open_card");
  assertTest(
    openCardsC.length === 2 &&
      openCardsC[0].type === "open_card" &&
      openCardsC[1].type === "open_card" &&
      openCardsC[0].item !== openCardsC[1].item,
    "T4 (c): multi-tool step opened 2 distinct card items",
  );

  const writeCardC = (openCardsC[0] as any).item;
  const bashCardC = (openCardsC[1] as any).item;

  const outActionsC1: RouteAction[] = [];
  routeStep(
    { type: "GENERIC", status: "DONE", content: "written ok" },
    qC,
    (a) => outActionsC1.push(a),
  );

  const outActionsC2: RouteAction[] = [];
  routeStep(
    { type: "GENERIC", status: "DONE", content: "test passed" },
    qC,
    (a) => outActionsC2.push(a),
  );

  assertTest(
    outActionsC1.length > 0 &&
      outActionsC1.every((a) => a.type === "append" && a.item === writeCardC) &&
      outActionsC2.length > 0 &&
      outActionsC2.every((a) => a.type === "append" && a.item === bashCardC),
    "T4 (c): FIFO output routing lands first on write card and second on bash card",
  );

  // 32. T4 routeStep selftest (d): card opened, then assistant text step -> q.pending cleared; straggler output -> bare
  const qD: { pending: (PageItem | null)[] } = { pending: [] };
  const actionsD: RouteAction[] = [];
  const emitD = (a: RouteAction) => actionsD.push(a);

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
    },
    qD,
    emitD,
  );
  assertTest(qD.pending.length === 1, "T4 (d): card opened into q.pending");

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      content: "All tasks completed.",
    },
    qD,
    emitD,
  );
  assertTest(qD.pending.length === 0, "T4 (d): turn-final assistant text clears q.pending");

  const stragglerActions: RouteAction[] = [];
  routeStep(
    { type: "GENERIC", content: "delayed straggler output" },
    qD,
    (a) => stragglerActions.push(a),
  );
  assertTest(
    stragglerActions.length > 0 && stragglerActions.every((a) => a.type === "bare"),
    "T4 (d): straggler output with empty q.pending renders bare",
  );

  // 33. T4 routeStep selftest (e): ERROR_MESSAGE step -> q.pending cleared and bare action emitted — never consumes a pending slot
  const qE: { pending: (PageItem | null)[] } = { pending: [] };
  const dummyCard: PageItem = { kind: "card", accent: STYLE.ACCENT.tool, lines: [] };
  qE.pending.push(dummyCard);

  const actionsE: RouteAction[] = [];
  routeStep(
    {
      type: "ERROR_MESSAGE",
      error: "Connection timeout",
    },
    qE,
    (a) => actionsE.push(a),
  );

  assertTest(
    qE.pending.length === 0 &&
      actionsE.length === 1 &&
      actionsE[0].type === "bare" &&
      actionsE[0].text.includes("Connection timeout") &&
      actionsE[0].fg === STYLE.ACCENT.error,
    "T4 (e): ERROR_MESSAGE step clears q.pending, emits bare action, and never consumes a slot",
  );

  // 34. T4 routeStep selftest (f): scan-mode: routeStep+applyRouteAction with ctx.pageMode=true -> items recorded in pages, ZERO DOM inserts
  const pagesF: PageItem[][] = [];
  let domInsertsF = 0;
  const mockParentF: any = {
    add: () => {
      domInsertsF++;
    },
  };
  const ctxF: RouteContext = {
    renderer: stubRenderer,
    parent: mockParentF,
    pages: pagesF,
    pageMode: true,
    pushLine: (txt, fg, bg) => {
      let page = pagesF[pagesF.length - 1];
      if (!page || page.length >= 200) {
        page = [];
        pagesF.push(page);
      }
      page.push({ kind: "line", text: txt, fg, bg });
    },
    notePushes: () => {},
  };
  const qF: { pending: (PageItem | null)[] } = { pending: [] };

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "echo test" } }],
    },
    qF,
    (a) => applyRouteAction(a, ctxF),
  );
  routeStep(
    {
      type: "GENERIC",
      content: "test output line 1\ntest output line 2",
    },
    qF,
    (a) => applyRouteAction(a, ctxF),
  );

  assertTest(
    pagesF.length > 0 &&
      pagesF[0].length === 1 &&
      pagesF[0][0].kind === "card" &&
      pagesF[0][0].lines.length === 4 &&
      domInsertsF === 0,
    "T4 (f): scan-mode with ctx.pageMode=true records items into pages with ZERO DOM inserts",
  );

  // 35. T4 WIRING case (g): fresh pages + stub/test root, run FULL chain routeStep -> applyRouteAction
  const pagesG: PageItem[][] = [];
  const rootG: any = {
    children: [] as any[],
    add(child: any) {
      this.children.push(child);
    },
  };
  const ctxG: RouteContext = {
    renderer: stubRenderer,
    parent: rootG,
    pages: pagesG,
    pageMode: false,
    pushLine: (txt, fg, bg) => {
      let page = pagesG[pagesG.length - 1];
      if (!page || page.length >= 200) {
        page = [];
        pagesG.push(page);
      }
      page.push({ kind: "line", text: txt, fg, bg });
    },
    notePushes: () => {},
  };
  const qG: { pending: (PageItem | null)[] } = { pending: [] };

  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "whoami" } }],
    },
    qG,
    (a) => applyRouteAction(a, ctxG),
  );

  const openedCardItem = pagesG[0]?.[0];
  assertTest(
    openedCardItem !== undefined && openedCardItem.kind === "card",
    "T4 (g): opened card item exists in pages",
  );
  const registeredBox = domBoxes.get(openedCardItem);
  assertTest(
    registeredBox !== undefined && registeredBox instanceof BoxRenderable,
    "T4 (g): domBoxes.get(openedItem) returns a real BoxRenderable",
  );

  const initialModelLinesG = openedCardItem.kind === "card" ? openedCardItem.lines.length : 0;
  const initialDomChildrenG = (registeredBox as any).getChildren().length;

  routeStep(
    {
      type: "GENERIC",
      content: "user_ubuntu\nline2",
    },
    qG,
    (a) => applyRouteAction(a, ctxG),
  );

  const finalModelLinesG = openedCardItem.kind === "card" ? openedCardItem.lines.length : 0;
  const finalDomChildrenG = (registeredBox as any).getChildren().length;

  assertTest(
    finalModelLinesG > initialModelLinesG && finalDomChildrenG > initialDomChildrenG,
    "T4 (g): after append actions BOTH item.lines.length grew AND box child count grew (single identity)",
  );

  // 36. T4 WIRING case (h): static assertions on routeStep call sites, 13-space removal, and card width check
  const selfSource = fs.readFileSync(__filename, "utf8");
  const routeStepMatches = selfSource.match(/routeStep\s*\(\s*step\s*,/g) || [];
  assertTest(
    routeStepMatches.length >= 2,
    `T4 (h): routeStep(step is called at >= 2 production call sites (found ${routeStepMatches.length})`,
  );
  const thirteenSpacesLiteral = '"' + " ".repeat(13) + '"';
  assertTest(
    !selfSource.includes(thirteenSpacesLiteral),
    "T4 (h): 13-space literal dump has zero hits in the file",
  );
  const targetWidthFn = ["getCard", "Width"].join("");
  const cardWidthMatches = selfSource.match(new RegExp(targetWidthFn, "g")) || [];
  assertTest(
    cardWidthMatches.length === 3,
    `T4 (h): ${targetWidthFn} matches ONLY definition + pushLine + renderMarkdown (found ${cardWidthMatches.length})`,
  );

  // 37. T4 QA flood test: 500-line output action-set into one card item
  const floodPages: PageItem[][] = [];
  const floodRoot: any = {
    children: [] as any[],
    add(child: any) {
      this.children.push(child);
    },
  };
  const floodCtx: RouteContext = {
    renderer: stubRenderer,
    parent: floodRoot,
    pages: floodPages,
    pageMode: false,
    pushLine: () => {},
    notePushes: () => {},
  };
  const floodQ = { pending: [] as (PageItem | null)[] };
  routeStep(
    {
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "run_command", args: { CommandLine: "yes" } }],
    },
    floodQ,
    (a) => applyRouteAction(a, floodCtx),
  );
  const rootCountBefore = floodRoot.children.length;
  const floodLines = Array.from({ length: 500 }, (_, i) => `flood line ${i}`).join("\n");
  routeStep(
    { type: "GENERIC", content: floodLines },
    floodQ,
    (a) => applyRouteAction(a, floodCtx),
  );
  const rootCountAfter = floodRoot.children.length;
  const floodCardItem = floodPages[0][0];
  assertTest(
    floodCardItem.kind === "card" &&
      floodCardItem.lines.length >= 501 &&
      rootCountAfter - rootCountBefore < 5,
    "T4 flood QA: 500-line output appends to card item lines while transcript root child-count delta < 5",
  );

  // 38. T5 Left-pane header line (C4) assertions
  const testRenderer5: any = {
    requestRender: () => {},
    registerLifecyclePass: () => {},
    unregisterLifecyclePass: () => {},
  };
  const testLeftPane = new BoxRenderable(testRenderer5, {
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
    overflow: "hidden",
  });
  const testScrollBox = new BoxRenderable(testRenderer5, { flexGrow: 1 });
  const testFooterBar = new BoxRenderable(testRenderer5, { height: 1 });

  const fixtureSession5 = {
    id: "f83a1b2c-9012-3456-789a-bcdef0123456",
    projectDir: "/Users/dev/workspace/my-project",
    model: "gemini-3.7-flash",
  };

  const headerBox5 = buildLeftPaneHeader(testRenderer5, {
    sessionId: fixtureSession5.id,
    projectDir: fixtureSession5.projectDir,
    model: fixtureSession5.model,
    state: "running",
  });

  testLeftPane.add(headerBox5);
  testLeftPane.add(testScrollBox);
  testLeftPane.add(testFooterBar);

  const headerNode5 = (testLeftPane.getChildren() as any[])[0];
  assertTest(
    headerNode5 === headerBox5,
    "T5: header node exists as first child of leftPane",
  );
  assertTest(
    headerNode5.text.includes("f83a1b2c"),
    "T5: header text contains session id (first 8 chars) after fixture session start",
  );
  assertTest(
    headerNode5.text.includes("my-project"),
    "T5: header text contains project basename",
  );
  assertTest(
    headerNode5.text.includes("gemini-3.7-flash"),
    "T5: header text contains model",
  );
  assertTest(
    headerNode5.text.includes("RUNNING"),
    "T5: header text contains running state pill",
  );

  // Adversarial check: state change updates header (anti-stale-state)
  updateLeftPaneHeader(headerBox5, {
    sessionId: fixtureSession5.id,
    projectDir: fixtureSession5.projectDir,
    model: fixtureSession5.model,
    state: "killed",
  });

  assertTest(
    headerNode5.text.includes("KILLED") && !headerNode5.text.includes("RUNNING"),
    "T5 (stale_state): header text reflects new state (KILLED) after fixture state change, not stale state",
  );

  // Failure scenario: teardown / destruction does not throw
  let teardownException5 = false;
  try {
    destroyRenderable(testLeftPane);
    updateLeftPaneHeader(headerBox5, {
      sessionId: fixtureSession5.id,
      projectDir: fixtureSession5.projectDir,
      model: fixtureSession5.model,
      state: "unknown",
    });
  } catch {
    teardownException5 = true;
  }
  assertTest(!teardownException5, "T5: header pill text updates/teardown executes without throwing");

  // Production wiring assertions
  const paneHdrAddIdx = selfSource.indexOf("leftPane.add(leftPaneHdr)");
  const scrollBoxAddIdx = selfSource.indexOf("leftPane.add(scrollBox)");
  assertTest(
    paneHdrAddIdx !== -1 && scrollBoxAddIdx !== -1 && paneHdrAddIdx < scrollBoxAddIdx,
    "T5 (wiring): leftPaneHdr is added to leftPane before scrollBox",
  );
  assertTest(
    selfSource.includes("updateLeftPaneHeader(leftPaneHdr,"),
    "T5 (wiring): updateLeftPaneHeader is wired into updateLiveLabel",
  );

  console.log("✔ deriveSessionState self-tests passed (25 assertions).");
  console.log("✔ pushCard Box self-test passed (1 assertion).");
  console.log("✔ PageItem card replay & domBoxes self-tests passed (5 assertions).");
  console.log("✔ routeStep & applyRouteAction FIFO cards self-tests passed (9 assertions).");
  console.log("✔ left-pane header line self-tests passed (9 assertions).");
}

export function runDbTest(): void {
  if (!fs.existsSync(CONVERSATION_DB_PATH)) {
    console.error(`❌ DB file not found: ${CONVERSATION_DB_PATH}`);
    process.exit(1);
  }
  const row = summaryReader.getLatest();
  if (!row) {
    console.error(`❌ Failed to read most-recent row from: ${CONVERSATION_DB_PATH}`);
    process.exit(1);
  }
  const now = Date.now();
  const liveMs = getTranscriptLiveMs(row.conversation_id, now);
  const state = deriveSessionState(row, { now, liveMs });
  console.log(`✔ DB read success (readonly):`);
  console.log(`  conversation_id: ${row.conversation_id}`);
  console.log(`  title:           ${row.title || "(no title)"}`);
  console.log(`  status:          ${row.status || "(empty)"}`);
  console.log(`  not_fully_idle:  ${row.not_fully_idle}`);
  console.log(`  last_modified:   ${row.last_modified_time}`);
  console.log(`  derived_state:   ${state}`);
  const descendants = summaryReader.getDescendants(row.conversation_id);
  console.log(`  descendants:     ${descendants.length} found`);
}

export function runStateQuery(targetId: string): void {
  if (!targetId) {
    console.error("❌ Missing session ID");
    process.exit(1);
  }
  let resolvedId = targetId;
  let row = summaryReader.getSummary(resolvedId);
  if (!row) {
    if (fs.existsSync(BRAIN_DIR)) {
      const dirs = fs.readdirSync(BRAIN_DIR);
      // #5: exact hit wins; otherwise collect every prefix match and refuse to guess
      // when a short prefix is ambiguous (two sessions can share an 8-char prefix).
      const matches = dirs.filter((d) => d === targetId || d.startsWith(targetId));
      const exact = matches.find((d) => d === targetId);
      const candidates = exact ? [exact] : matches;
      if (candidates.length > 1) {
        console.error(`❌ Ambiguous prefix '${targetId}' matches ${candidates.length} sessions:`);
        for (const c of candidates.slice(0, 10)) console.error(`   ${c}`);
        process.exit(1);
      }
      if (candidates.length === 1) {
        resolvedId = candidates[0];
        row = summaryReader.getSummary(resolvedId);
      }
    }
  }
  if (!row) {
    console.error(`❌ Session not found in DB or brain: ${targetId}`);
    process.exit(1);
  }

  const now = Date.now();
  const liveMs = getTranscriptLiveMs(resolvedId, now);
  const state = deriveSessionState(row, { now, liveMs });
  const ageSec = liveMs != null ? `${(liveMs / 1000).toFixed(1)}s` : "missing";

  console.log(`conversation_id: ${resolvedId}`);
  console.log(`title:           ${row.title || "(no title)"}`);
  console.log(`status:          ${row.status || "(empty)"}`);
  console.log(`not_fully_idle:  ${row.not_fully_idle ?? 0}`);
  console.log(`last_modified:   ${row.last_modified_time || "(none)"}`);
  console.log(`transcript_age:  ${ageSec}`);
  console.log(`derived_state:   ${state}`);
}

if (process.argv.includes("--selftest")) {
  runSelfTest();
  process.exit(0);
}

if (process.argv.includes("--dbtest")) {
  runDbTest();
  process.exit(0);
}

const stateIdx = process.argv.indexOf("--state");
if (stateIdx !== -1) {
  const argId = process.argv[stateIdx + 1];
  if (!argId || argId.startsWith("-")) {
    console.error("❌ Usage: agy-live --state <conversation_id>");
    process.exit(1);
  }
  runStateQuery(argId);
  process.exit(0);
}

// ─── Session discovery ────────────────────────────────────────────────────────

export interface AgySession {
  id: string;
  path: string;
  projectDir: string;
  model: string;
  size: number;
  mtime: number;
  title?: string;
}

function detectSessionModel(logPath: string): string {
  try {
    const fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    // Read first 64KB and last 64KB to find the model setting fast
    const bufLen = Math.min(65536, size);
    const buf = Buffer.alloc(bufLen);
    fs.readSync(fd, buf, 0, bufLen, 0);
    let text = buf.toString("utf8");

    if (size > 65536) {
      const endBuf = Buffer.alloc(bufLen);
      fs.readSync(fd, endBuf, 0, bufLen, size - bufLen);
      text += "\n" + endBuf.toString("utf8");
    }
    fs.closeSync(fd);

    const rx = /setting `Model Selection`.*?\bto\s+([^<\n]+?)(?:\.\s|\.\n|\.<|$)/gi;
    let lastModel = "Gemini 3.7 Flash";
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      if (m[1]) lastModel = m[1].replace(/\.+$/, "").trim();
    }
    return lastModel;
  } catch {
    return "Gemini 3.7 Flash";
  }
}

const sessionMetaCache = new Map<
  string,
  { mtime: number; size: number; projectDir: string; model: string; title: string }
>();

function getAllSessions(): AgySession[] {
  if (!fs.existsSync(BRAIN_DIR)) return [];
  const out: AgySession[] = [];
  for (const entry of fs.readdirSync(BRAIN_DIR)) {
    const logPath = path.join(BRAIN_DIR, entry, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(logPath)) continue;
    try {
      const stat = fs.statSync(logPath);
      const cached = sessionMetaCache.get(logPath);
      let projectDir: string;
      let model: string;
      let title: string;
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        projectDir = cached.projectDir;
        model = cached.model;
        title = cached.title;
      } else {
        projectDir = detectProjectDir(logPath);
        model = detectSessionModel(logPath);
        const row = summaryReader.getSummary(entry);
        title = row?.title?.trim() || "";
        sessionMetaCache.set(logPath, {
          mtime: stat.mtimeMs,
          size: stat.size,
          projectDir,
          model,
          title,
        });
      }
      out.push({
        id: entry,
        path: logPath,
        projectDir,
        model,
        size: stat.size,
        mtime: stat.mtimeMs,
        title,
      });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function detectProjectDir(logPath: string): string {
  try {
    const fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(32768, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    const rx = /(?:AbsolutePath|Cwd|SearchPath|DirectoryPath)[^:]*:\s*"?\\?"?([^"',\\]+)/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      let dir = m[1].trim();
      try {
        if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
        for (let i = 0; i < 6; i++) {
          if (
            [".git", "settings.gradle", "package.json"].some((f) =>
              fs.existsSync(path.join(dir, f)),
            )
          )
            return dir;
          const p = path.dirname(dir);
          if (p === dir) break;
          dir = p;
        }
      } catch {}
    }
  } catch {}
  return "(Unbound session)";
}

function findProjectSession(ss: AgySession[]): AgySession | null {
  const cwd = process.cwd();
  return (
    ss.find((s) => s.projectDir !== "(Unbound session)" && cwd.startsWith(s.projectDir)) ?? null
  );
}

function fmtSize(b: number): string {
  const k = b / 1024;
  return k > 1024 ? (k / 1024).toFixed(1) + " MB" : k.toFixed(0) + " KB";
}
function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : `${Math.floor(s / 3600)}h ago`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const sessions = getAllSessions();
  if (!sessions.length) {
    console.error("❌ No agy sessions found in ~/.gemini/antigravity-cli/brain/");
    process.exit(1);
  }

  const arg = process.argv[2];
  let currentSession =
    (arg ? sessions.find((s) => s.id.startsWith(arg)) : null) ??
    findProjectSession(sessions) ??
    sessions[0];

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 20,
    screenMode: "alternate-screen",
    backgroundColor: "#0d1117",
  });

  const SIDEBAR_W = 34;

  // ── Root: flexDirection row, full screen ────────────────────────────────────
  renderer.root.flexDirection = "row";
  renderer.root.width = "100%";
  renderer.root.height = "100%";

  class FastScrollAccel {
    tick() {
      return 3;
    }
    reset() {}
  }

  // ── Left pane (Log View & Switcher Host) ───────────────────────────────────
  const leftPane = new BoxRenderable(renderer, {
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
    overflow: "hidden",
  });

  const initialSummary = summaryReader.getSummary(currentSession.id);
  const initialLiveMs = getTranscriptLiveMs(currentSession.id);
  const initialState = deriveSessionState(initialSummary, {
    now: Date.now(),
    liveMs: initialLiveMs,
  });

  const leftPaneHdr = buildLeftPaneHeader(renderer, {
    sessionId: currentSession.id,
    projectDir: currentSession.projectDir,
    model: currentSession.model,
    state: initialState,
  });

  const scrollBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    scrollAcceleration: new FastScrollAccel(),
  });
  scrollBox.focusable = false; // prevent focus capture — let renderer.keyInput handle all keys

  const selBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    backgroundColor: "#0d1117",
  });
  selBox.focusable = false;

  const contextBox = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    backgroundColor: "#0d1117",
  });
  contextBox.focusable = false;

  const footerBar = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    backgroundColor: "#1a1a2e",
    flexDirection: "row",
    alignItems: "center",
    paddingX: 1,
    gap: 1,
  });
  const statusTxt = new TextRenderable(renderer, {
    content: "⠋ Loading...",
    fg: "#63b3ed",
    flexGrow: 1,
  });
  const liveTxt = new TextRenderable(renderer, { content: "[LIVE]", fg: "#68d391" });
  footerBar.add(statusTxt);
  footerBar.add(liveTxt);

  leftPane.add(leftPaneHdr);
  leftPane.add(scrollBox);
  leftPane.add(footerBar);

  // ── Separator ────────────────────────────────────────────────────────────────
  const sep = new BoxRenderable(renderer, { width: 1, height: "100%", backgroundColor: "#374151" });

  // ── Right Sidebar (sticky) ───────────────────────────────────────────────────
  const sidebar = new BoxRenderable(renderer, {
    width: SIDEBAR_W,
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#111827",
    paddingX: 1,
    overflow: "hidden",
  });

  const sbHdr = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    backgroundColor: "#0e7490",
  });
  sbHdr.add(
    new TextRenderable(renderer, {
      content: " ℹ️  MONITOR & STATS",
      fg: "#000000",
      attributes: BOLD_ATTR,
    }),
  );
  sidebar.add(sbHdr);

  function addDiv() {
    const d = new BoxRenderable(renderer, { width: "100%", height: 1 });
    d.add(new TextRenderable(renderer, { content: "─".repeat(SIDEBAR_W - 2), fg: "#374151" }));
    sidebar.add(d);
  }
  function addSbLabel(txt: string) {
    const r = new BoxRenderable(renderer, { width: "100%", height: 1 });
    r.add(new TextRenderable(renderer, { content: txt, fg: "#fbbf24", attributes: BOLD_ATTR }));
    sidebar.add(r);
  }
  function addSbRow(label: string, valFg = "#e2e8f0"): TextRenderable {
    const row = new BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row" });
    row.add(new TextRenderable(renderer, { content: label, fg: "#94a3b8", width: 12 }));
    const val = new TextRenderable(renderer, { content: "—", fg: valFg, flexGrow: 1 });
    row.add(val);
    sidebar.add(row);
    return val;
  }
  function addSbKey(key: string, desc: string) {
    const row = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      gap: 1,
    });
    row.add(new TextRenderable(renderer, { content: `[${key}]`, fg: "#fbbf24", width: 8 }));
    row.add(new TextRenderable(renderer, { content: desc, fg: "#94a3b8" }));
    sidebar.add(row);
  }

  addDiv();
  const vTitleBox = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  vTitleBox.add(new TextRenderable(renderer, { content: "📌 Title:", fg: "#94a3b8" }));
  const vTitleVal1 = new TextRenderable(renderer, { content: "  —", fg: "#f472b6" });
  vTitleBox.add(vTitleVal1);
  sidebar.add(vTitleBox);

  const vState = addSbRow("⚡ State:", "#4ade80");
  const vProj = addSbRow("📁 Project:", "#4ade80");
  const vSess = addSbRow("🆔 Session:", "#67e8f9");
  const vModel = addSbRow("🤖 Model:", "#fbbf24");
  const vSteps = addSbRow("🔢 Steps:", "#e2e8f0");
  const vSize = addSbRow("📄 Size:", "#e2e8f0");
  const vAge = addSbRow("🕒 Updated:", "#e2e8f0");

  addDiv();
  addSbLabel("🧠 CONTEXT & QUOTA");
  const vCtxLoad = addSbRow("• Context:", "#38bdf8");
  const vCtxBar = new BoxRenderable(renderer, { width: "100%", height: 1 });
  const vCtxBarTxt = new TextRenderable(renderer, {
    content: "  [░░░░░░░░░░░░] 0%",
    fg: "#94a3b8",
  });
  vCtxBar.add(vCtxBarTxt);
  sidebar.add(vCtxBar);

  const vQuotaG5h = addSbRow("• Gemini 5h:", "#4ade80");
  const vQuotaG5hBar = new BoxRenderable(renderer, { width: "100%", height: 1 });
  const vQuotaG5hBarTxt = new TextRenderable(renderer, {
    content: "  [░░░░░░░░░░░░] --%",
    fg: "#94a3b8",
  });
  vQuotaG5hBar.add(vQuotaG5hBarTxt);
  sidebar.add(vQuotaG5hBar);

  const vQuotaGWk = addSbRow("• Gemini Wk:", "#fbbf24");
  const vQuotaGWkBar = new BoxRenderable(renderer, { width: "100%", height: 1 });
  const vQuotaGWkBarTxt = new TextRenderable(renderer, {
    content: "  [░░░░░░░░░░░░] --%",
    fg: "#94a3b8",
  });
  vQuotaGWkBar.add(vQuotaGWkBarTxt);
  sidebar.add(vQuotaGWkBar);

  const vQuotaC5h = addSbRow("• Claude 5h:", "#4ade80");
  const vQuotaC5hBar = new BoxRenderable(renderer, { width: "100%", height: 1 });
  const vQuotaC5hBarTxt = new TextRenderable(renderer, {
    content: "  [░░░░░░░░░░░░] --%",
    fg: "#94a3b8",
  });
  vQuotaC5hBar.add(vQuotaC5hBarTxt);
  sidebar.add(vQuotaC5hBar);

  const vQuotaCWk = addSbRow("• Claude Wk:", "#fbbf24");
  const vQuotaCWkBar = new BoxRenderable(renderer, { width: "100%", height: 1 });
  const vQuotaCWkBarTxt = new TextRenderable(renderer, {
    content: "  [░░░░░░░░░░░░] --%",
    fg: "#94a3b8",
  });
  vQuotaCWkBar.add(vQuotaCWkBarTxt);
  sidebar.add(vQuotaCWkBar);

  addDiv();
  addSbLabel("⌨️  KEYBINDINGS");
  addSbKey("↑/↓/k/j", "Scroll log");
  addSbKey("PgUp/Dn", "Fast scroll");
  addSbKey("g", "Scroll to top");
  addSbKey("G", "Live (bottom)");
  addSbKey("s", "Switch session");
  addSbKey("c", "Full context");
  addSbKey("Drag/Select", "Copy on release");
  addSbKey("q/Esc", "Quit");

  renderer.root.add(leftPane);
  renderer.root.add(sep);
  renderer.root.add(sidebar);

  // ── State ─────────────────────────────────────────────────────────────────────
  let rootWatchedSession = currentSession;
  let followingChildId: string | null = null;
  let userPinned = false;
  let pinnedSawActive = false; // #3: only auto-unpin a pinned session that actually ran
  let lastDescendantScanMs = 0; // #4: throttle the descendant CTE scan
  let cachedDescendants: ConversationSummaryRow[] = [];
  let currentSummaryRow: ConversationSummaryRow | null = summaryReader.getSummary(
    rootWatchedSession.id,
  );
  let currentDerivedState: SessionState = deriveSessionState(currentSummaryRow, {
    now: Date.now(),
    liveMs: getTranscriptLiveMs(rootWatchedSession.id),
  });
  let lastDbCheckMs = 0;

  let currentPos = 0,
    remainder = "",
    stepCount = 0;
  let lastActivityMs = Date.now();
  let activeFileFd: number | null = null;
  let spinnerIdx = 0,
    spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let isLive = true;
  let scheduledUntilMs = 0;
  let scheduledPrompt = "";
  let activeBackgroundTask: string | null = null;
  // Pagination: fixed-size chunks (PAGE_SIZE lines) of the WHOLE session file —
  // page 1 = start of session. Full history is parsed once (strings only, no
  // DOM) on first page-mode entry; pages then grow in realtime as poll parses
  // new steps. DOM renders only the viewed page on switch.
  const PAGE_SIZE = 200; // ponytail: fixed chunk size; raise for denser pages
  let pages: PageItem[][] = [];

  function recordPageItem(item: PageItem) {
    if (!recording) return;
    let page = pages[pages.length - 1];
    if (!page || page.length >= PAGE_SIZE) {
      page = [];
      pages.push(page);
    }
    page.push(item);
  }
  let pageIndex = 0;
  let pageMode = false;
  let historyScanned = false;
  let recording = false;
  let currentModel = currentSession.model || "Detecting...";
  let userPromptCount = 0,
    plannerResponseCount = 0,
    toolCallCount = 0,
    checkpointCount = 0;
  let activeContextChars = 0;
  let isViewingContext = false;

  interface AgyQuota {
    category: string;
    period: string;
    percentRemaining: number;
    resetsAt: string;
  }

  let liveQuotas: AgyQuota[] = [];
  let isFetchingQuota = false;

  function makeMeterBar(
    pct: number,
    width = 12,
    remainingMode = false,
  ): { bar: string; color: string } {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clamped / 100) * width);
    const empty = Math.max(0, width - filled);
    const bar = `  [${"█".repeat(filled)}${"░".repeat(empty)}] ${clamped.toFixed(0)}%`;

    let color = "#4ade80";
    if (remainingMode) {
      if (clamped < 20) color = "#f87171";
      else if (clamped < 50) color = "#fbbf24";
      else color = "#4ade80";
    } else {
      if (clamped > 80) color = "#f87171";
      else if (clamped > 50) color = "#fbbf24";
      else color = "#4ade80";
    }
    return { bar, color };
  }

  function renderQuota(valueRow: TextRenderable, barTxt: TextRenderable, q: AgyQuota | undefined) {
    if (q) {
      valueRow.content = `${q.percentRemaining}% left`;
      const m = makeMeterBar(q.percentRemaining, 12, true);
      barTxt.content = m.bar;
      barTxt.fg = m.color as any;
    } else {
      valueRow.content = "—";
      barTxt.content = "  [░░░░░░░░░░░░] --%";
      barTxt.fg = "#6b7280" as any;
    }
  }

  function fetchLiveQuotaAsync(onDone?: () => void) {
    if (isFetchingQuota) return;
    isFetchingQuota = true;
    const proc = spawn("agy", ["-p", "/usage"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout?.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      isFetchingQuota = false;
      if (code === 0 && buf.trim()) {
        const lines = buf.trim().split("\n");
        const list: AgyQuota[] = [];
        for (const l of lines) {
          const parts = l.split("\t").map((s) => s.trim());
          if (parts.length >= 4) {
            const pct = parseInt(parts[2].replace("%", ""), 10);
            list.push({
              category: parts[0],
              period: parts[1],
              percentRemaining: isNaN(pct) ? 0 : pct,
              resetsAt: parts[3],
            });
          }
        }
        if (list.length > 0) {
          liveQuotas = list;
          updateSidebar();
          if (isViewingContext) renderContextView();
          renderer.requestRender();
        }
      }
      onDone?.();
    });
    proc.on("error", () => {
      isFetchingQuota = false;
    });
  }

  function getModelContextLimit(modelName: string): number {
    const norm = (modelName || "").toLowerCase();
    if (
      norm.includes("gemini") ||
      norm.includes("flash") ||
      (norm.includes("pro") && !norm.includes("claude"))
    ) {
      return 1_000_000;
    }
    if (
      norm.includes("claude") ||
      norm.includes("sonnet") ||
      norm.includes("opus") ||
      norm.includes("haiku")
    ) {
      return 200_000;
    }
    if (norm.includes("gpt-4o") || norm.includes("o1") || norm.includes("o3")) {
      return 128_000;
    }
    return 200_000;
  }

  function scrollToBottom() {
    isLive = true;
    scrollBox.stickyScroll = true;
    scrollBox.scrollTo(scrollBox.scrollHeight);
  }
  function scrollToTop() {
    isLive = false;
    scrollBox.stickyScroll = false;
    scrollBox.scrollTo(0);
  }

  function updateLiveLabel() {
    if (isSelectingSession || isViewingContext) return;
    if (pageMode) {
      liveTxt.content = `[PAGE ${pageIndex + 1}/${pages.length}]`;
      liveTxt.fg = "#fbbf24" as any;
      updateLeftPaneHeader(leftPaneHdr, {
        sessionId: currentSession.id,
        projectDir: currentSession.projectDir,
        model: currentModel || currentSession.model,
        state: currentDerivedState,
        followingChildId,
      });
      return;
    }

    const pageSuffix = pages.length ? ` [PAGE ${pages.length}/${pages.length}]` : "";
    const followPrefix = followingChildId ? `[FOLLOWING] ` : "";

    switch (currentDerivedState) {
      case "running":
        liveTxt.content = `${followPrefix}[RUNNING]${pageSuffix}`;
        liveTxt.fg = isLive ? ("#4ade80" as any) : ("#f6ad55" as any);
        break;
      case "idle":
        liveTxt.content = `${followPrefix}[IDLE]${pageSuffix}`;
        liveTxt.fg = "#94a3b8" as any;
        break;
      case "stuck":
        liveTxt.content = `${followPrefix}[STUCK]${pageSuffix}`;
        liveTxt.fg = "#fbbf24" as any;
        break;
      case "killed":
        liveTxt.content = `${followPrefix}[KILLED]${pageSuffix}`;
        liveTxt.fg = "#ef4444" as any;
        break;
      case "unknown":
      default:
        liveTxt.content = `${followPrefix}[UNKNOWN]${pageSuffix}`;
        liveTxt.fg = "#6b7280" as any;
        break;
    }

    updateLeftPaneHeader(leftPaneHdr, {
      sessionId: currentSession.id,
      projectDir: currentSession.projectDir,
      model: currentModel || currentSession.model,
      state: currentDerivedState,
      followingChildId,
    });
  }

  let isAppDestroyed = false;

  function updateSidebar() {
    if (isAppDestroyed) return;
    const titleStr =
      currentSummaryRow?.title?.trim() ||
      currentSession.title?.trim() ||
      (currentSession.projectDir !== "(Unbound session)"
        ? path.basename(currentSession.projectDir)
        : currentModel || "Antigravity Session");

    vTitleVal1.content = "  " + (titleStr.length > 28 ? titleStr.slice(0, 27) + "…" : titleStr);

    switch (currentDerivedState) {
      case "running":
        vState.content = followingChildId ? "● RUN (child)" : "● RUNNING";
        vState.fg = "#4ade80" as any;
        break;
      case "idle":
        vState.content = "○ IDLE";
        vState.fg = "#94a3b8" as any;
        break;
      case "stuck":
        vState.content = "▲ STUCK";
        vState.fg = "#fbbf24" as any;
        break;
      case "killed":
        vState.content = "✕ KILLED";
        vState.fg = "#ef4444" as any;
        break;
      case "unknown":
      default:
        vState.content = "? UNKNOWN";
        vState.fg = "#6b7280" as any;
        break;
    }

    const folder =
      currentSession.projectDir !== "(Unbound session)"
        ? path.basename(currentSession.projectDir)
        : "Unbound";
    vProj.content = folder.length > 18 ? folder.slice(0, 17) + "…" : folder;

    const sessId = currentSession.id;
    if (followingChildId) {
      vSess.content = `↳ ${sessId.slice(0, 8)} (sub)`;
    } else {
      vSess.content = sessId.slice(0, 12) + "…";
    }

    const model = currentModel || currentSession.model || "Gemini 3.7 Flash";
    vModel.content = model.length > 18 ? model.slice(0, 17) + "…" : model;

    vSteps.content = String(stepCount);
    vSize.content = fmtSize(currentSession.size);
    const liveAge = getTranscriptLiveMs(currentSession.id);
    vAge.content = liveAge != null ? timeAgo(Date.now() - liveAge) : timeAgo(currentSession.mtime);

    const limit = getModelContextLimit(model);
    const estimatedActiveTokens = Math.round((activeContextChars + 32000) / 4);
    const pct = Math.min(100, (estimatedActiveTokens / limit) * 100);
    vCtxLoad.content = `${(estimatedActiveTokens / 1000).toFixed(1)}K (${pct.toFixed(0)}%)`;

    const ctxMeter = makeMeterBar(pct, 12, false);
    vCtxBarTxt.content = ctxMeter.bar;
    vCtxBarTxt.fg = ctxMeter.color as any;

    const qG5h = liveQuotas.find(
      (q) => q.category === "Gemini Models" && q.period.includes("Five Hour"),
    );
    const qGWk = liveQuotas.find(
      (q) => q.category === "Gemini Models" && q.period.includes("Weekly"),
    );
    const qC5h = liveQuotas.find(
      (q) => q.category === "Claude and GPT models" && q.period.includes("Five Hour"),
    );
    const qCWk = liveQuotas.find(
      (q) => q.category === "Claude and GPT models" && q.period.includes("Weekly"),
    );

    renderQuota(vQuotaG5h, vQuotaG5hBarTxt, qG5h);
    renderQuota(vQuotaGWk, vQuotaGWkBarTxt, qGWk);
    renderQuota(vQuotaC5h, vQuotaC5hBarTxt, qC5h);
    renderQuota(vQuotaCWk, vQuotaCWkBarTxt, qCWk);

    if (!isSelectingSession && !isViewingContext) updateLiveLabel();
  }

  function setStatus(txt: string) {
    if (isSelectingSession || isViewingContext) return;
    statusTxt.content = txt;
    updateSidebar();
  }

  function startSpinner(txt: string) {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = setInterval(() => {
      const now = Date.now();
      if (now < scheduledUntilMs) {
        const rem = Math.ceil((scheduledUntilMs - now) / 1000);
        setStatus(
          `${SPINNER[spinnerIdx++ % SPINNER.length]} ⏳ [SCHEDULE] "${scheduledPrompt || "Waiting"}" (${rem}s)`,
        );
      } else {
        setStatus(`${SPINNER[spinnerIdx++ % SPINNER.length]} ${txt}`);
      }
    }, 100);
  }
  function stopSpinner(msg?: string) {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (msg) setStatus(msg);
  }

  // ── Clipboard & Selection Helpers ─────────────────────────────────────────────
  function copyToClipboard(text: string): boolean {
    if (!text) return false;
    let copied = false;
    if (process.platform === "darwin") {
      try {
        const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
        proc.stdin?.write(text);
        proc.stdin?.end();
        copied = true;
      } catch {}
    } else if (process.platform === "win32") {
      try {
        const proc = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"] });
        proc.stdin?.write(text);
        proc.stdin?.end();
        copied = true;
      } catch {}
    } else {
      try {
        const proc = spawn("xclip", ["-selection", "clipboard"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        proc.stdin?.write(text);
        proc.stdin?.end();
        copied = true;
      } catch {}
    }
    try {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      process.stdout.write(`\x1b]52;c;${b64}\x07`);
      copied = true;
    } catch {}
    return copied;
  }

  function getSelectedText(): string {
    const sel = (renderer as any).currentSelection;
    if (!sel) return "";
    const selected = sel.selectedRenderables || [];
    const lines: string[] = [];
    for (const r of selected) {
      if (typeof r.getSelectedText === "function") {
        const txt = r.getSelectedText();
        if (txt) lines.push(txt);
      }
    }
    return lines.join("\n");
  }

  // Auto-copy on text selection drag
  renderer.on("selection" as any, () => {
    const text = getSelectedText();
    if (text) {
      copyToClipboard(text);
      setStatus(`📋 Copied ${text.length} chars to clipboard`);
      setTimeout(() => {
        if (!isSelectingSession) setStatus("⠋ Ready");
      }, 1500);
    }
  });

  function formatMarkdownLinks(text: string): string {
    return text.replace(/\[([^\]]+)\]\((?:file|https?):[^\)]+\)/g, "$1");
  }

  function parseMarkdownSpans(
    line: string,
    defaultFg = "#ffffff",
  ): { text: string; bold?: boolean; fg?: string }[] {
    const clean = formatMarkdownLinks(line);
    const spans: { text: string; bold?: boolean; fg?: string }[] = [];
    const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(clean)) !== null) {
      if (match.index > lastIdx) {
        spans.push({ text: clean.slice(lastIdx, match.index), fg: defaultFg });
      }
      const token = match[0];
      if (token.startsWith("**") && token.endsWith("**")) {
        const inner = token.slice(2, -2).trim();
        spans.push({ text: inner, bold: true, fg: "#ffffff" });
      } else if (token.startsWith("`") && token.endsWith("`")) {
        const inner = token.slice(1, -1);
        spans.push({ text: inner, bold: true, fg: "#22c55e" });
      }
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < clean.length) {
      spans.push({ text: clean.slice(lastIdx), fg: defaultFg });
    }
    return spans;
  }

  // ── Log push ──────────────────────────────────────────────────────────────────
  function pushLine(txt: string, fg = "#d1d5db", bg?: string) {
    recordPageItem({ kind: "line", text: txt, fg, bg });
    if (pageMode) return; // viewing an old page — record only, DOM untouched
    const formatted = formatMarkdownLinks(txt);
    const clean = stripAnsi(formatted) || " ";
    const cardW = getCardWidth();
    const lines = clean.length > cardW && !bg ? wrapLine(clean, cardW) : [clean];

    for (const l of lines) {
      const hasMarkdown = l.includes("**") || l.includes("`");
      if (!hasMarkdown) {
        const opts: any = {
          content: l,
          fg,
          wrapMode: "none",
          width: "100%",
          selectable: true,
          selectionBg: "#2563eb",
          selectionFg: "#ffffff",
        };
        if (bg) opts.bg = bg;
        scrollBox.add(new TextRenderable(renderer, opts));
      } else {
        const opts: any = {
          wrapMode: "none",
          width: "100%",
          selectable: true,
          selectionBg: "#2563eb",
          selectionFg: "#ffffff",
        };
        if (bg) opts.bg = bg;
        const tr = new TextRenderable(renderer, opts);
        const spans = parseMarkdownSpans(l, fg);
        for (const s of spans) {
          const node = new TextNodeRenderable({
            fg: s.fg || fg,
            attributes: s.bold ? BOLD_ATTR : 0,
          });
          node.add(s.text);
          tr.add(node);
        }
        scrollBox.add(tr);
      }
    }

    // Rolling window: keep scrollBox nodes tight to prevent Yoga layout lag.
    notePushes(1, scrollBox);
  }

  const q: { pending: (PageItem | null)[] } = { pending: [] };
  const ctx: RouteContext = {
    renderer,
    parent: scrollBox,
    get pages() {
      return pages;
    },
    get pageMode() {
      return pageMode;
    },
    pushLine,
    notePushes,
  };

  // ── Clear scrollbox ────────────────────────────────────────────────────────────
  function clearScrollBox() {
    const children = [...scrollBox.getChildren()] as Renderable[];
    for (let i = children.length - 1; i >= 0; i--) {
      destroyRenderable(children[i]);
    }
    scrollBox.scrollTop = 0;
    scrollBox.scrollLeft = 0;
    scrollBox.stickyScroll = true;
  }

  // ── Pagination (arrow left/right) ─────────────────────────────────────────────
  function scanFullHistory() {
    if (historyScanned) return;
    let fd: number | null = null;
    try {
      fd = fs.openSync(currentSession.path, "r");
      const size = fs.fstatSync(fd).size;
      pageMode = true; // suppress DOM adds while scanning; DOM rendered after
      recording = true;
      resetCounters(); // scan re-counts from the true session start
      q.pending.length = 0;
      let pos = 0;
      let rem = "";
      while (pos < size) {
        const len = Math.min(MAX_POLL_READ, size - pos);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        pos += len;
        const chunk = rem + buf.toString("utf8");
        const rawLines = chunk.split("\n");
        rem = rawLines.pop() ?? "";
        for (const raw of rawLines) {
          const t = raw.trim();
          if (!t) continue;
          try {
            renderStep(JSON.parse(t));
          } catch {}
        }
      }
      historyScanned = true;
      // Live tail already rendered its portion into DOM; the scan recorded the
      // same lines into pages. Rewind live cursor to scan end — poll continues
      // from there with zero gaps and zero duplicates.
      currentPos = pos;
      remainder = "";
    } catch {
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }

  function renderPageIntoDom(idx: number) {
    const pg = pages[Math.max(0, Math.min(idx, pages.length - 1))];
    if (!pg) return;
    clearScrollBox();
    scrollBox.stickyScroll = false;
    replayPageInto(renderer, scrollBox, pg);
    renderer.requestRender();
  }

  function enterPageMode(idx: number) {
    scanFullHistory();
    if (!pages.length) return;
    pageMode = true;
    isLive = false;
    pageIndex = Math.max(0, Math.min(idx, pages.length - 1));
    renderPageIntoDom(pageIndex);
    updateLiveLabel();
    renderer.requestRender();
  }

  function exitPageMode() {
    // Exiting page mode does not rebuild the DOM; a card open in replayed history receives model-only appends until next page switch.
    pageMode = false;
    updateLiveLabel();
    renderer.requestRender();
  }

  function pagePrev() {
    if (!pageMode) {
      // From LIVE: show the current (last) page from its start — that's the
      // "review how this sub-agent did its prompt" view.
      enterPageMode(Math.max(0, pages.length - 1));
      return;
    }
    if (pageIndex <= 0) return;
    enterPageMode(pageIndex - 1);
  }

  function pageNext() {
    if (!pageMode) return;
    if (pageIndex >= pages.length - 1) {
      // Right past the last page → back to LIVE tail.
      exitPageMode();
      scrollToBottom();
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    enterPageMode(pageIndex + 1);
  }
  function resetCounters() {
    stepCount = 0;
    userPromptCount = 0;
    plannerResponseCount = 0;
    toolCallCount = 0;
    checkpointCount = 0;
    activeContextChars = 0;
  }

  function wrapLine(text: string, maxWidth: number): string[] {
    if (!text && text !== "") return [""];
    const clean = String(text).replace(/\t/g, "  ").replace(/\r/g, "");
    if (maxWidth <= 10 || clean.length <= maxWidth) return [clean];

    const indentMatch = clean.match(/^\s*/);
    const indent = indentMatch ? indentMatch[0] + "  " : "  ";

    const chunks: string[] = [];
    let remaining = clean;
    let isFirst = true;
    let iterations = 0;

    while (remaining.length > 0 && iterations++ < 500) {
      const curMax = isFirst ? maxWidth : Math.max(10, maxWidth - indent.length);
      if (curMax <= 0 || remaining.length <= curMax) {
        chunks.push(isFirst ? remaining : indent + remaining);
        break;
      }
      let breakIdx = -1;
      const slice = remaining.slice(0, curMax);
      for (let i = slice.length - 1; i >= Math.floor(curMax * 0.6); i--) {
        if ([" ", ",", ".", "(", ")", "{", "}", ";", ":", "/", "-", "\n"].includes(slice[i])) {
          breakIdx = i + 1;
          break;
        }
      }
      if (breakIdx <= 0) {
        breakIdx = curMax;
      }
      const chunkPart = remaining.slice(0, breakIdx);
      chunks.push(isFirst ? chunkPart : indent + chunkPart);
      const next = remaining.slice(breakIdx);
      if (next.length === remaining.length) {
        chunks.push(next);
        break;
      }
      remaining = next;
      isFirst = false;
    }
    return chunks;
  }

  function getCardWidth(): number {
    const termW = renderer.width || 80;
    // Total terminal width minus sidebar (32), sep (1), scrollbar track (2), and right padding (2)
    return Math.max(30, termW - 37);
  }

  function pushCard(
    lines: { text: string; fg?: string; isTitle?: boolean }[],
    kind?: "user" | "tool" | "thinking" | "error",
  ) {
    const accent =
      kind ? STYLE.ACCENT[kind] : (lines.find((l) => l.isTitle)?.fg ?? STYLE.ACCENT.tool);
    const item: PageItem = {
      kind: "card",
      accent,
      lines: lines.map((l) => ({ ...l })),
    };
    recordPageItem(item);
    if (pageMode) return;
    const box = buildCardBox(renderer, scrollBox, { lines, accent });
    domBoxes.set(item, box);
    notePushes(lines.length, scrollBox);
    return box;
  }

  function renderMarkdown(mdText: string) {
    const clean = formatMarkdownLinks(unescapeCodeString(mdText));
    const lines = clean.split("\n");
    let inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      if (trimmed.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        if (inCodeBlock) {
          const lang = trimmed.slice(3).trim();
          pushLine("");
          pushLine(STYLE.GUTTER + `💻 Code ${lang ? `(${lang})` : ""}`, "#22c55e");
        } else {
          pushLine("");
        }
        continue;
      }

      if (inCodeBlock) {
        const cardW = getCardWidth();
        const wrapped = wrapLine(raw, cardW - 4);
        for (const w of wrapped) {
          const content = "▎ " + w;
          const visibleLen = stripAnsi(content).length;
          const padding = " ".repeat(Math.max(0, cardW - visibleLen));
          pushLine(content + padding, "#ffffff", STYLE.CARD_BG);
        }
        continue;
      }

      if (trimmed.startsWith("# ")) {
        pushLine(STYLE.GUTTER + `🔷 ${trimmed.slice(2)}`, "#c084fc");
      } else if (trimmed.startsWith("## ")) {
        pushLine(STYLE.GUTTER + `🔹 ${trimmed.slice(3)}`, "#38bdf8");
      } else if (trimmed.startsWith("### ")) {
        pushLine(STYLE.GUTTER + `▸ ${trimmed.slice(4)}`, "#fbbf24");
      } else if (/^[-*]\s+/.test(trimmed)) {
        pushLine(STYLE.GUTTER + `  • ${trimmed.replace(/^[-*]\s+/, "")}`, "#ffffff");
      } else if (/^\d+\.\s+/.test(trimmed)) {
        pushLine(STYLE.GUTTER + `  ${trimmed}`, "#fde047");
      } else if (trimmed.startsWith("> ")) {
        pushLine(STYLE.GUTTER + `  ▎ ${trimmed.slice(2)}`, "#cbd5e1");
      } else if (trimmed === "---" || trimmed === "___" || trimmed === "***") {
        pushLine(STYLE.GUTTER + "────────────────────────────────────────────────────────────", "#374151");
      } else if (!trimmed) {
        pushLine("");
      } else {
        pushLine(STYLE.GUTTER + raw, "#ffffff");
      }
    }
  }

  // ── Step renderer (rich formatting for all Antigravity step types) ─────────────
  function renderStep(step: any) {
    lastActivityMs = Date.now();
    stepCount++;

    // Token counting & Model detection
    if (
      step.content &&
      ["USER_INPUT", "GENERIC", "SYSTEM_MESSAGE", "CHECKPOINT"].includes(step.type)
    ) {
      if (typeof step.content === "string" && step.content.includes("Model Selection")) {
        const match = step.content.match(
          /setting `Model Selection`.*?\bto\s+([^<\n]+?)(?:\.\s|\.\n|\.<|$)/i,
        );
        if (match) {
          currentModel = match[1].replace(/\.+$/, "").trim();
          updateSidebar();
        }
      }
    }

    // Step counters & live context load in memory
    if (step.type === "USER_INPUT") userPromptCount++;
    if (step.type === "PLANNER_RESPONSE") plannerResponseCount++;
    if (step.tool_calls && Array.isArray(step.tool_calls)) toolCallCount += step.tool_calls.length;
    if (step.type === "CHECKPOINT") {
      checkpointCount++;
      activeContextChars = step.content ? String(step.content).length : 12000;
    } else {
      if (step.content) activeContextChars += String(step.content).length;
      if (step.thinking) activeContextChars += String(step.thinking).length;
      if (step.tool_calls) activeContextChars += JSON.stringify(step.tool_calls).length;
    }
    try {
      currentSession.size = fs.fstatSync(activeFileFd!).size;
    } catch {}

    // 1. USER_INPUT
    if (step.type === "USER_INPUT" && step.content) {
      scheduledUntilMs = 0;
      activeBackgroundTask = null;
      q.pending.length = 0;
      const clean = unescapeCodeString(capText(step.content)).trim();
      const lines = clean.split("\n");
      const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
        { text: "👤 [USER TASK]", fg: "#60a5fa", isTitle: true },
        ...lines.map((l) => ({ text: "  " + l, fg: "#ffffff" })),
      ];
      pushCard(cardLines, "user");
      stopSpinner("✓ Task received");
      startSpinner("Agent thinking...");
      return;
    }

    // 2. CHECKPOINT
    if (step.type === "CHECKPOINT") {
      q.pending.length = 0;
      pushLine(STYLE.GUTTER + "📌 [CHECKPOINT / SUMMARY CONTEXT]", "#ca8a04");
      return;
    }

    // 3. SYSTEM_MESSAGE
    if (step.type === "SYSTEM_MESSAGE" && step.content) {
      const raw = String(step.content).trim();
      scheduledUntilMs = 0;
      activeBackgroundTask = null;
      q.pending.length = 0;
      if (raw.includes("exited with code 0")) {
        pushLine(STYLE.GUTTER + "⚡ [TASK SUCCESS] Background task exited with code 0", "#4ade80");
      } else if (
        raw.includes("exited with code") ||
        raw.includes("error") ||
        raw.includes("Error")
      ) {
        pushLine(STYLE.GUTTER + "⚠️  [TASK ERROR] " + raw.slice(0, 150), "#f87171");
      } else {
        pushLine(STYLE.GUTTER + "⚡ [SYSTEM] " + raw.slice(0, 150), "#94a3b8");
      }
      return;
    }

    // 3b. ERROR_MESSAGE
    if (step.type === "ERROR_MESSAGE") {
      scheduledUntilMs = 0;
      activeBackgroundTask = null;
      routeStep(step, q, (a) => applyRouteAction(a, ctx));
      stopSpinner("✕ Error");
      return;
    }

    // 4. PLANNER_RESPONSE
    if (step.type === "PLANNER_RESPONSE") {
      // Model Thinking
      if (step.thinking && typeof step.thinking === "string") {
        const lines = capText(step.thinking).trim().split("\n");
        const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
          { text: "🧠 [Thinking]", fg: "#c084fc", isTitle: true },
          ...lines.map((l) => ({ text: l, fg: "#a855f7" })),
        ];
        pushCard(cardLines, "thinking");
      }

      // Assistant Commentary / Content
      const hasTools = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
      if (step.content) {
        const clean = capText(step.content).trim();
        if (clean) {
          pushLine("");
          pushLine(
            STYLE.GUTTER + (hasTools ? "💬 [Assistant]" : "💬 [Assistant Response]"),
            hasTools ? "#38bdf8" : "#4ade80",
          );
          renderMarkdown(clean);
          if (!hasTools) {
            routeStep(step, q, (a) => applyRouteAction(a, ctx));
            const hasActiveWait = scheduledUntilMs > Date.now() || Boolean(activeBackgroundTask);
            if (hasActiveWait) {
              const isTimer = scheduledUntilMs > Date.now();
              const sec = Math.ceil((scheduledUntilMs - Date.now()) / 1000);
              const waitMsg = isTimer
                ? `⏳ Menunggu timer "${scheduledPrompt}" (${sec}s)...`
                : "⚙️ Menunggu background task selesai...";
              pushLine(STYLE.GUTTER + waitMsg, "#f59e0b");
              startSpinner(waitMsg);
              return;
            }

            pushLine("");
            pushLine(STYLE.GUTTER + "────────────────────────────────────────────────────────────", "#374151");
            pushLine(STYLE.GUTTER + "✨ [COMPLETED] Tugas agy telah selesai dengan sukses!", "#4ade80");
            pushLine("");
            stopSpinner("✓ Finished");
            return;
          }
        }
      }

      // Tool Calls
      if (hasTools) {
        for (const tc of step.tool_calls) {
          if (tc.name === "run_command") {
            const cmd = unescapeCodeString(tc.args?.CommandLine || tc.args?.command || "").trim();
            activeBackgroundTask = cmd;
          } else if (tc.name === "schedule") {
            const sec = parseInt(tc.args?.DurationSeconds || tc.args?.duration_seconds || "60", 10);
            const p = String(tc.args?.Prompt || tc.args?.prompt || "Waiting for task");
            scheduledUntilMs = Date.now() + sec * 1000;
            scheduledPrompt = p;
          }
        }
        routeStep(step, q, (a) => applyRouteAction(a, ctx));
        const first = step.tool_calls[0];
        const s = first?.args?.toolSummary ?? first?.name ?? "tool";
        stopSpinner(`▶ ${s}`);
        startSpinner(`${s}...`);
        return;
      }
      return;
    }

    // 5. Tool Output Steps (VIEW_FILE, RUN_COMMAND, LIST_DIRECTORY, GENERIC, etc.)
    if (step.content && typeof step.content === "string") {
      // The agent stays in-flight only until a command's output step lands. A
      // status!=="RUNNING" output is a completed command; status==="RUNNING" output is
      // an async background task still executing and must leave the marker intact.
      if (step.status !== "RUNNING") activeBackgroundTask = null;
      routeStep(step, q, (a) => applyRouteAction(a, ctx));
      stopSpinner("✓ Output received");
      startSpinner("Agent processing...");
    }
  }

  function getSessionForId(id: string, fallbackSession: AgySession): AgySession {
    const logPath = path.join(BRAIN_DIR, id, ".system_generated", "logs", "transcript.jsonl");
    let size = 0;
    // A missing/unreadable transcript must NOT read as freshly active -> 0 (stale).
    let mtime = 0;
    try {
      const st = fs.statSync(logPath);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {}
    const cached = sessionMetaCache.get(logPath);
    let projectDir = fallbackSession.projectDir;
    let model = fallbackSession.model;
    let title = "";
    if (cached && cached.mtime === mtime && cached.size === size) {
      projectDir = cached.projectDir;
      model = cached.model;
      title = cached.title;
    } else {
      if (fs.existsSync(logPath)) {
        model = detectSessionModel(logPath);
        projectDir = detectProjectDir(logPath);
        if (projectDir === "(Unbound session)") projectDir = fallbackSession.projectDir;
      }
      const row = summaryReader.getSummary(id);
      title = row?.title?.trim() || "";
      sessionMetaCache.set(logPath, { mtime, size, projectDir, model, title });
    }
    return {
      id,
      path: logPath,
      projectDir,
      model,
      size,
      mtime,
      title,
    };
  }

  function descendantsThrottled(now: number): ConversationSummaryRow[] {
    // #4: the recursive-CTE descendant scan (and its per-descendant stat) is too
    // costly for the 250ms UI tick, so refresh the candidate set at most every 1.5s.
    if (now - lastDescendantScanMs >= 1500) {
      cachedDescendants = summaryReader.getDescendants(rootWatchedSession.id);
      lastDescendantScanMs = now;
    }
    return cachedDescendants;
  }

  function pollDbState() {
    const now = Date.now();
    if (now - lastDbCheckMs < 250) return;
    lastDbCheckMs = now;

    // A silent long-running command never touches the transcript, so the in-flight claim
    // is bounded by how long the watched transcript has been frozen: no write for over 30
    // minutes means the agent process died mid-command (killed/crashed), so we stop
    // claiming running and let the session settle. This bounds the bash-latch zombie
    // without falsely idling a real build that streams output under that window.
    const activeTaskLiveMs = currentSession
      ? getTranscriptLiveMs(currentSession.id, now)
      : undefined;
    const isCommandInFlight =
      Boolean(activeBackgroundTask) &&
      (activeTaskLiveMs === undefined || activeTaskLiveMs < 30 * 60_000);
    const isCurrentActive = isCommandInFlight || scheduledUntilMs > now;
    // #1: deliberately EXCLUDE spinnerTimer. The sidebar starts the spinner when
    // state==running; feeding spinnerTimer back in as an activity signal would latch
    // the state to running forever (the idle/stuck stop-branches never fire) and
    // resurrect the exact false-running bug. Transcript freshness + the two bounded
    // wait signals cover genuine in-flight turns.

    if (userPinned) {
      const liveMs = getTranscriptLiveMs(rootWatchedSession.id, now);
      const inFlight =
        currentSession?.id === rootWatchedSession.id && isCurrentActive;
      const pinnedRow = summaryReader.getSummary(rootWatchedSession.id);
      const pinnedState = deriveSessionState(pinnedRow, {
        now,
        liveMs,
        inFlight,
      });
      currentSummaryRow = pinnedRow;
      currentDerivedState = pinnedState;
      // #3: honor the user's manual selection. Only resume auto-follow after a
      // pinned session that actually RAN has settled to idle — never unpin one the
      // user picked that is simply already idle (else the viewport is hijacked ~250ms
      // after selection, which is how an idle session got shown as a live child again).
      if (pinnedState === "running") {
        pinnedSawActive = true;
      } else if (pinnedSawActive) {
        // Reached only on a non-running state. Release the pin on ANY settled state,
        // not just "idle": most legacy rows are blank-status and derive as "unknown",
        // so gating on "idle" would strand the pin forever and never resume auto-follow.
        userPinned = false;
        pinnedSawActive = false;
      }
      return;
    }

    const rootInFlight =
      currentSession?.id === rootWatchedSession.id && isCurrentActive;
    const rootLiveMs = getTranscriptLiveMs(rootWatchedSession.id, now);
    const rootRow = summaryReader.getSummary(rootWatchedSession.id);
    const rootState = deriveSessionState(rootRow, {
      now,
      liveMs: rootLiveMs,
      inFlight: rootInFlight,
    });

    if (followingChildId) {
      const childInFlight =
        currentSession?.id === followingChildId && isCurrentActive;
      const childLiveMs = getTranscriptLiveMs(followingChildId, now);
      const childRow = summaryReader.getSummary(followingChildId);
      const childState = deriveSessionState(childRow, {
        now,
        liveMs: childLiveMs,
        inFlight: childInFlight,
      });

      if (childState === "running") {
        currentSummaryRow = childRow;
        currentDerivedState = childState;
      } else {
        const descendants = descendantsThrottled(now);
        const nextRunning = descendants.find((d) => {
          if (d.conversation_id === followingChildId) return false;
          const dLiveMs = getTranscriptLiveMs(d.conversation_id, now);
          return deriveSessionState(d, { now, liveMs: dLiveMs }) === "running";
        });

        if (nextRunning) {
          followingChildId = nextRunning.conversation_id;
          currentSummaryRow = nextRunning;
          currentDerivedState = "running";
          const childSess = getSessionForId(nextRunning.conversation_id, rootWatchedSession);
          switchSession(childSess, true);
        } else {
          followingChildId = null;
          currentSummaryRow = rootRow;
          currentDerivedState = rootState;
          switchSession(rootWatchedSession, false);
        }
      }
    } else {
      const descendants = descendantsThrottled(now);
      const runningChild = descendants.find((d) => {
        const dLiveMs = getTranscriptLiveMs(d.conversation_id, now);
        return deriveSessionState(d, { now, liveMs: dLiveMs }) === "running";
      });

      if (runningChild) {
        followingChildId = runningChild.conversation_id;
        currentSummaryRow = runningChild;
        currentDerivedState = "running";
        const childSess = getSessionForId(runningChild.conversation_id, rootWatchedSession);
        switchSession(childSess, true);
      } else {
        currentSummaryRow = rootRow;
        currentDerivedState = rootState;
      }
    }
  }

  // ── Poll ───────────────────────────────────────────────────────────────────────
  function poll() {
    try {
      pollDbState();

      if (!activeFileFd) {
        if (!fs.existsSync(currentSession.path)) return;
        activeFileFd = fs.openSync(currentSession.path, "r");
      }
      const stat = fs.fstatSync(activeFileFd);
      if (stat.size < currentPos) {
        currentPos = 0;
        remainder = "";
        clearScrollBox();
        resetCounters();
      }
      if (currentPos === 0 && stat.size > 50_000) {
        // Fast seek to last 50KB on initial load to avoid processing hundreds of past steps
        currentPos = Math.max(0, stat.size - 50_000);
      }
      const readEnd = Math.min(stat.size, currentPos + MAX_POLL_READ);
      if (readEnd === currentPos) return;
      const len = readEnd - currentPos;
      const buf = Buffer.alloc(len);
      fs.readSync(activeFileFd, buf, 0, len, currentPos);
      currentPos = readEnd;
      const chunk = remainder + buf.toString("utf8");
      const rawLines = chunk.split("\n");
      remainder = rawLines.pop() ?? "";
      let newCount = 0;
      for (const raw of rawLines) {
        const t = raw.trim();
        if (t) {
          try {
            renderStep(JSON.parse(t));
            newCount++;
          } catch {}
        }
      }
      if (newCount > 0) {
        lastActivityMs = Date.now();
        updateSidebar();
        if (pageMode)
          updateLiveLabel(); // pages grew in realtime; refresh x/y
        else renderer.requestRender();
      }
    } catch {}
  }

  // ── Session switch ─────────────────────────────────────────────────────────────
  function switchSession(s: AgySession, isAutoFollow = false) {
    if (!s) return;
    if (currentSession && currentSession.id === s.id && activeFileFd != null) {
      return;
    }
    if (activeFileFd != null) {
      try {
        fs.closeSync(activeFileFd);
      } catch {}
      activeFileFd = null;
    }
    currentSession = s;
    currentPos = 0;
    remainder = "";
    isLive = true;
    pageMode = false;
    pageIndex = 0;
    pages = [];
    q.pending.length = 0;
    historyScanned = false;
    recording = false;
    scheduledUntilMs = 0;
    activeBackgroundTask = null;
    // Drop the descendant cache on switch so auto-follow can't act on the PREVIOUS
    // root session's children inside the 1.5s throttle window.
    lastDescendantScanMs = 0;
    cachedDescendants = [];
    currentModel = s.model || "Detecting...";
    clearScrollBox();
    resetCounters();
    updateSidebar();
    updateLiveLabel();
    if (isAutoFollow) {
      const childTitle = currentSummaryRow?.title?.trim() || s.id.slice(0, 8);
      startSpinner(`following: ${childTitle} (${s.id.slice(0, 8)})`);
    } else {
      startSpinner("Loading session...");
    }
    // Fast-seek loads ~50KB of history in one poll batch; OpenTUI stickyScroll
    // only pins the view if it was already at the bottom BEFORE the children
    // grew, so a switch lands at the top. Jump explicitly after load.
    scrollToBottom();
    renderer.requestRender();
    // Second pass once Yoga computed the new content height (scrollHeight is
    // stale before the first layout after the bulk add).
    setTimeout(() => {
      scrollToBottom();
      renderer.requestRender();
    }, 0);
  }

  // ── Session selector (display toggle) ──────────────────────────────────────────
  let isSelectingSession = false,
    selectorCursor = 0;
  let cachedSessions = [...sessions];

  function renderSelectorList() {
    const children = [...selBox.getChildren()] as Renderable[];
    for (let i = children.length - 1; i >= 0; i--) destroyRenderable(children[i]);

    if (!cachedSessions.length) {
      const emptyBox = new BoxRenderable(renderer, {
        width: "100%",
        paddingX: 1,
        paddingY: 1,
      });
      emptyBox.add(
        new TextRenderable(renderer, {
          content: "No sessions found",
          fg: "#6b7280",
        }),
      );
      selBox.add(emptyBox);
      return;
    }

    const maxItems = Math.max(
      1,
      Math.min(cachedSessions.length, Math.floor(((renderer.height || 24) - 4) / 2)),
    );
    if (selectorCursor >= maxItems) selectorCursor = Math.max(0, maxItems - 1);

    for (let i = 0; i < maxItems; i++) {
      const s = cachedSessions[i];
      if (!s) continue;
      const sel = i === selectorCursor;
      const folder = s.projectDir !== "(Unbound session)" ? path.basename(s.projectDir) : "Unbound";
      const itemBox = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "column",
        backgroundColor: sel ? "#1e3a8a" : i % 2 === 0 ? "#0d1117" : "#111827",
        paddingX: 1,
      });

      const topRow = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        gap: 1,
      });
      topRow.add(
        new TextRenderable(renderer, { content: sel ? "▶" : " ", fg: "#fbbf24", width: 2 }),
      );
      topRow.add(
        new TextRenderable(renderer, {
          content: String(i + 1).padStart(2),
          fg: "#6b7280",
          width: 2,
        }),
      );
      const titleDisplay = s.title ? `📁 ${folder} — ${s.title}` : `📁 ${folder}`;
      topRow.add(
        new TextRenderable(renderer, {
          content: titleDisplay,
          fg: sel ? "#ffffff" : "#38bdf8",
          attributes: sel ? BOLD_ATTR : 0,
          flexGrow: 1,
        }),
      );
      topRow.add(
        new TextRenderable(renderer, { content: fmtSize(s.size), fg: "#6b7280", width: 8 }),
      );
      topRow.add(
        new TextRenderable(renderer, {
          content: timeAgo(s.mtime),
          fg: sel ? "#fbbf24" : "#6b7280",
          width: 10,
        }),
      );
      itemBox.add(topRow);

      const botRow = new BoxRenderable(renderer, {
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 5,
        gap: 2,
      });
      botRow.add(
        new TextRenderable(renderer, {
          content: `🆔 ${s.id}`,
          fg: sel ? "#93c5fd" : "#64748b",
        }),
      );
      botRow.add(
        new TextRenderable(renderer, {
          content: `🤖 ${s.model}`,
          fg: sel ? "#fde047" : "#a78bfa",
        }),
      );
      itemBox.add(botRow);

      selBox.add(itemBox);
    }
  }

  function openSelector() {
    if (isAppDestroyed || isSelectingSession) return;
    if (isViewingContext) closeContextView();
    isSelectingSession = true;
    cachedSessions = getAllSessions();
    const maxItems = Math.max(
      1,
      Math.min(cachedSessions.length, Math.floor(((renderer.height || 24) - 4) / 2)),
    );
    const foundIdx = cachedSessions.findIndex((ss) => ss.id === currentSession.id);
    selectorCursor = foundIdx >= 0 && foundIdx < maxItems ? foundIdx : 0;
    renderSelectorList();
    leftPane.remove(scrollBox);
    leftPane.insertBefore(selBox, footerBar);
    statusTxt.content = "[↑/↓/k/j] nav   [Enter] select   [Esc/q] cancel";
    liveTxt.content = `[${cachedSessions.length} SESS]`;
    liveTxt.fg = "#fbbf24" as any;
    renderer.requestRender();
  }

  function redrawSelector() {
    if (isAppDestroyed || !isSelectingSession) return;
    renderSelectorList();
    renderer.requestRender();
  }

  function closeSelector() {
    if (isAppDestroyed || !isSelectingSession) return;
    isSelectingSession = false;
    lastModalToggleTime = 0;
    leftPane.remove(selBox);
    leftPane.insertBefore(scrollBox, footerBar);
    if (!spinnerTimer) {
      statusTxt.content = "💤 Idle — waiting for next agy command...";
    }
    updateLiveLabel();
    renderer.requestRender();
  }

  // ── Context Full View Modal ──────────────────────────────────────────────────
  function renderContextView() {
    const children = [...contextBox.getChildren()] as Renderable[];
    for (let i = children.length - 1; i >= 0; i--) destroyRenderable(children[i]);

    const model = currentModel || currentSession.model || "Gemini 3.7 Flash";
    const limit = getModelContextLimit(model);
    const estimatedActiveTokens = Math.round((activeContextChars + 32000) / 4);
    const pct = Math.min(100, (estimatedActiveTokens / limit) * 100);
    const folder =
      currentSession.projectDir !== "(Unbound session)"
        ? currentSession.projectDir
        : "(Unbound session)";

    function addContextCard(
      title: string,
      lines: { label: string; value: string; valFg?: string }[],
    ) {
      const card = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "column",
        backgroundColor: STYLE.CARD_BG,
        paddingX: 1,
        marginY: 1,
      });
      const hdr = new BoxRenderable(renderer, { width: "100%", height: 1 });
      hdr.add(
        new TextRenderable(renderer, {
          content: `▎ ${title}`,
          fg: "#38bdf8",
          attributes: BOLD_ATTR,
        }),
      );
      card.add(hdr);
      for (const row of lines) {
        const r = new BoxRenderable(renderer, { width: "100%", height: 1, flexDirection: "row" });
        r.add(
          new TextRenderable(renderer, { content: `  ${row.label}`, fg: "#94a3b8", width: 24 }),
        );
        r.add(
          new TextRenderable(renderer, {
            content: row.value,
            fg: row.valFg || "#ffffff",
            flexGrow: 1,
          }),
        );
        card.add(r);
      }
      contextBox.add(card);
    }

    // Card 1: Session & Model Overview
    addContextCard("SESSION & MODEL OVERVIEW", [
      { label: "Session ID:", value: currentSession.id, valFg: "#67e8f9" },
      { label: "Workspace Root:", value: folder, valFg: "#4ade80" },
      { label: "Active Model:", value: model, valFg: "#fbbf24" },
      {
        label: "Context Window Limit:",
        value: `${(limit / 1000).toLocaleString()}K tokens (100%)`,
        valFg: "#e2e8f0",
      },
      { label: "Transcript Size:", value: fmtSize(currentSession.size), valFg: "#e2e8f0" },
    ]);

    // Card 2: Active Context Window Load
    const barWidth = 24;
    const filled = Math.min(barWidth, Math.round((pct / 100) * barWidth));
    const empty = Math.max(0, barWidth - filled);
    const barStr = "█".repeat(filled) + "░".repeat(empty);
    const barColor = pct > 80 ? "#f87171" : pct > 50 ? "#fbbf24" : "#4ade80";

    addContextCard("LIVE CONTEXT LOAD IN MEMORY", [
      {
        label: "Active Window Load:",
        value: `${(estimatedActiveTokens / 1000).toFixed(1)}K / ${(limit / 1000).toFixed(0)}K tokens`,
        valFg: "#38bdf8",
      },
      { label: "Context Utilization:", value: `${pct.toFixed(2)}% used`, valFg: barColor },
      { label: "Visual Meter:", value: `[${barStr}]`, valFg: barColor },
      {
        label: "Compacted Slices:",
        value: `${checkpointCount} checkpoints (auto-compacted)`,
        valFg: "#a78bfa",
      },
    ]);

    // Card 4: Live Server Subscription Quota (/usage)
    const quotaRows = liveQuotas.map((q) => {
      const cat = q.category.replace(" models", "").replace(" Models", "");
      const per = q.period.replace(" Limit Remaining", "");
      let resetFmt = "";
      try {
        const d = new Date(q.resetsAt);
        resetFmt = ` (resets ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")})`;
      } catch {}
      const m = makeMeterBar(q.percentRemaining, 14, true);
      return {
        label: `${cat} ${per}:`,
        value: `${q.percentRemaining}% left  ${m.bar.trim()}${resetFmt}`,
        valFg: m.color,
      };
    });

    quotaRows.push({
      label: "Quota Limit Status:",
      value: "✅ Normal (Active subscription / No 429 throttle)",
      valFg: "#22c55e",
    });

    addContextCard("LIVE SUBSCRIPTION QUOTA (/usage)", quotaRows);

    // Card 5: Step Counters & Events
    addContextCard("STEP BREAKDOWN & EVENTS", [
      { label: "Total Steps Logged:", value: `${stepCount} steps`, valFg: "#ffffff" },
      { label: "User Prompts:", value: `${userPromptCount} turns`, valFg: "#38bdf8" },
      { label: "Planner Steps:", value: `${plannerResponseCount} responses`, valFg: "#c084fc" },
      { label: "Tool Invocations:", value: `${toolCallCount} calls`, valFg: "#fbbf24" },
      { label: "Checkpoints:", value: `${checkpointCount} compactions`, valFg: "#a78bfa" },
    ]);

    // Card 6: Injected Rules & Protocols
    addContextCard("INJECTED DIRECTIVES & RULES", [
      {
        label: "Global Protocol:",
        value: "Caveman Communication + Ponytail Engineering Ladder",
        valFg: "#4ade80",
      },
      {
        label: "Project Architecture:",
        value: "Clean Architecture MVVM (Pure Kotlin Domain)",
        valFg: "#38bdf8",
      },
      {
        label: "CodeGraph / Memory:",
        value: "Auto-Recall agentmemory + CodeGraph MCP",
        valFg: "#fbbf24",
      },
    ]);
  }

  function openContextView() {
    if (isAppDestroyed || isViewingContext) return;
    if (isSelectingSession) closeSelector();
    isViewingContext = true;
    fetchLiveQuotaAsync();
    renderContextView();
    leftPane.remove(scrollBox);
    leftPane.insertBefore(contextBox, footerBar);
    statusTxt.content = "[↑/↓/k/j] scroll   [Esc/q/c] return to log";
    liveTxt.content = "[CONTEXT]";
    liveTxt.fg = "#38bdf8" as any;
    renderer.requestRender();
  }

  function closeContextView() {
    if (isAppDestroyed || !isViewingContext) return;
    isViewingContext = false;
    leftPane.remove(contextBox);
    leftPane.insertBefore(scrollBox, footerBar);
    if (!spinnerTimer) {
      statusTxt.content = "💤 Idle — waiting for next agy command...";
    }
    updateLiveLabel();
    renderer.requestRender();
  }

  function exitApp(code = 0) {
    if (isAppDestroyed) return;
    isAppDestroyed = true;
    summaryReader.close();
    clearInterval(pollInterval);
    clearInterval(sidebarInterval);
    clearInterval(quotaInterval);
    if (spinnerTimer) clearInterval(spinnerTimer);
    if (activeFileFd != null) {
      try {
        fs.closeSync(activeFileFd);
      } catch {}
    }
    try {
      renderer.destroy();
    } catch {}
    process.exit(code);
  }

  let lastKeyTime = 0;
  let lastKeySig = "";
  let lastModalToggleTime = 0;

  // ── Unified Keyboard Handler ──────────────────────────────────────────────────
  function handleKey(name: string, seq = "", ctrl = false, shift = false) {
    if (isAppDestroyed) return;
    const now = Date.now();
    const sig = `${name}:${seq}:${ctrl}:${shift}`;
    if (sig === lastKeySig && now - lastKeyTime < 40) return;
    lastKeyTime = now;
    lastKeySig = sig;

    const keyLower = (name || "").toLowerCase();
    const seqLower = (seq || "").toLowerCase();

    if (ctrl && keyLower === "c") {
      exitApp(0);
      return;
    }

    if (isViewingContext) {
      if (keyLower === "escape" || keyLower === "q" || keyLower === "c" || seqLower === "c") {
        closeContextView();
        return;
      }
      if (keyLower === "up" || keyLower === "k") {
        contextBox.scrollTop = Math.max(0, contextBox.scrollTop - 2);
        renderer.requestRender();
        return;
      }
      if (keyLower === "down" || keyLower === "j") {
        contextBox.scrollTop = Math.min(contextBox.scrollHeight, contextBox.scrollTop + 2);
        renderer.requestRender();
        return;
      }
      if (keyLower === "pageup") {
        contextBox.scrollTop = Math.max(0, contextBox.scrollTop - 8);
        renderer.requestRender();
        return;
      }
      if (keyLower === "pagedown") {
        contextBox.scrollTop = Math.min(contextBox.scrollHeight, contextBox.scrollTop + 8);
        renderer.requestRender();
        return;
      }
      return;
    }

    if (isSelectingSession) {
      if (keyLower === "escape" || keyLower === "q") {
        closeSelector();
        return;
      }
      if (keyLower === "s" || seqLower === "s") {
        if (now - lastModalToggleTime < 100) return;
        lastModalToggleTime = now;
        closeSelector();
        return;
      }
      if (keyLower === "up" || keyLower === "k") {
        selectorCursor = Math.max(0, selectorCursor - 1);
        redrawSelector();
        return;
      }
      if (keyLower === "down" || keyLower === "j") {
        const maxItems = Math.max(
          1,
          Math.min(cachedSessions.length, Math.floor(((renderer.height || 24) - 4) / 2)),
        );
        const maxI = Math.max(0, maxItems - 1);
        selectorCursor = Math.min(maxI, selectorCursor + 1);
        redrawSelector();
        return;
      }
      if (keyLower === "return" || keyLower === "enter") {
        const chosen = cachedSessions[selectorCursor];
        if (chosen) {
          closeSelector();
          userPinned = true;
          pinnedSawActive = false; // #3: freshly pinned — don't auto-unpin until it runs then settles
          rootWatchedSession = chosen;
          followingChildId = null;
          currentSummaryRow = summaryReader.getSummary(chosen.id);
          currentDerivedState = deriveSessionState(currentSummaryRow, {
            now: Date.now(),
            liveMs: getTranscriptLiveMs(chosen.id),
          });
          switchSession(chosen, false);
        }
        return;
      }
      const num = parseInt(name, 10);
      const maxItems = Math.max(
        1,
        Math.min(cachedSessions.length, Math.floor(((renderer.height || 24) - 4) / 2)),
      );
      if (!isNaN(num) && num >= 1 && num <= maxItems) {
        closeSelector();
        const chosen = cachedSessions[num - 1];
        if (chosen) {
          userPinned = true;
          pinnedSawActive = false; // #3: freshly pinned — don't auto-unpin until it runs then settles
          rootWatchedSession = chosen;
          followingChildId = null;
          currentSummaryRow = summaryReader.getSummary(chosen.id);
          currentDerivedState = deriveSessionState(currentSummaryRow, {
            now: Date.now(),
            liveMs: getTranscriptLiveMs(chosen.id),
          });
          switchSession(chosen, false);
        }
        return;
      }
      return;
    }

    // Normal mode
    if (pageMode && (keyLower === "q" || keyLower === "escape")) {
      // Don't kill the app while reviewing pages — return to LIVE first.
      exitPageMode();
      scrollToBottom();
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if (keyLower === "left") {
      pagePrev();
      return;
    }
    if (keyLower === "right") {
      pageNext();
      return;
    }
    if (keyLower === "q" || keyLower === "escape") {
      exitApp(0);
      return;
    }
    if (keyLower === "s" || seqLower === "s") {
      if (now - lastModalToggleTime < 100) return;
      lastModalToggleTime = now;
      openSelector();
      return;
    }
    if (keyLower === "c" || seqLower === "c") {
      openContextView();
      return;
    }
    if (keyLower === "g" && !shift && seq !== "G") {
      scrollToTop();
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if ((keyLower === "g" && shift) || seq === "G") {
      scrollToBottom();
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if (keyLower === "up" || keyLower === "k") {
      isLive = false;
      scrollBox.stickyScroll = false;
      scrollBox.scrollTop = Math.max(0, scrollBox.scrollTop - 3);
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if (keyLower === "down" || keyLower === "j") {
      scrollBox.scrollTop = Math.min(scrollBox.scrollHeight, scrollBox.scrollTop + 3);
      if (scrollBox.scrollTop >= scrollBox.scrollHeight - 2) {
        isLive = true;
        scrollBox.stickyScroll = true;
      }
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if (keyLower === "pageup") {
      isLive = false;
      scrollBox.stickyScroll = false;
      scrollBox.scrollTop = Math.max(
        0,
        scrollBox.scrollTop - Math.max(1, (renderer.height || 24) - 4),
      );
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
    if (keyLower === "pagedown") {
      scrollBox.scrollTop = Math.min(
        scrollBox.scrollHeight,
        scrollBox.scrollTop + Math.max(1, (renderer.height || 24) - 4),
      );
      if (scrollBox.scrollTop >= scrollBox.scrollHeight - 2) {
        isLive = true;
        scrollBox.stickyScroll = true;
      }
      updateLiveLabel();
      renderer.requestRender();
      return;
    }
  }

  // OpenTUI native key handler (exclusive)
  renderer.keyInput.on("keypress", (key) => {
    handleKey(key.name, key.sequence, key.ctrl, key.shift);
  });

  // ── Process Crash & Exit Handlers ──────────────────────────────────────────────
  process.on("uncaughtException", (err) => {
    try {
      fs.writeFileSync("/tmp/agy-crash.log", (err?.stack || String(err)) + "\n");
    } catch {}
    exitApp(1);
  });
  process.on("unhandledRejection", (err: any) => {
    try {
      fs.writeFileSync("/tmp/agy-crash.log", (err?.stack || String(err)) + "\n");
    } catch {}
    exitApp(1);
  });

  // ── Idle + sidebar refresh ──────────────────────────────────────────────────────
  const sidebarInterval = setInterval(() => {
    if (isAppDestroyed) return;
    pollDbState();
    const hasActiveWait =
      scheduledUntilMs > Date.now() || Boolean(activeBackgroundTask);
    if (currentDerivedState === "running" && !spinnerTimer) {
      startSpinner("Agent processing...");
    } else if (currentDerivedState === "idle" && spinnerTimer && !hasActiveWait) {
      stopSpinner("💤 Idle — session idle");
    } else if (currentDerivedState === "stuck" && spinnerTimer && !hasActiveWait) {
      stopSpinner("⚠️ Stuck / Waiting (no activity for >60s)");
    } else if (
      Date.now() - lastActivityMs > 25000 &&
      spinnerTimer &&
      currentDerivedState !== "running" &&
      !hasActiveWait
    ) {
      stopSpinner("💤 Idle — waiting for next agy command...");
    }
    updateSidebar();
  }, 1000);

  const quotaInterval = setInterval(fetchLiveQuotaAsync, 120_000);

  // ── Start ───────────────────────────────────────────────────────────────────────
  startSpinner("Loading session history...");
  fetchLiveQuotaAsync();
  updateSidebar();
  const pollInterval = setInterval(poll, 100);
  renderer.once("destroy", () => {
    isAppDestroyed = true;
    summaryReader.close();
    clearInterval(pollInterval);
    clearInterval(sidebarInterval);
    clearInterval(quotaInterval);
    if (spinnerTimer) clearInterval(spinnerTimer);
    if (activeFileFd != null) {
      try {
        fs.closeSync(activeFileFd);
      } catch {}
    }
  });
  poll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
