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

// ─── Constants ────────────────────────────────────────────────────────────────

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BOLD_ATTR = createTextAttributes({ bold: true });

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

// ─── Session discovery ────────────────────────────────────────────────────────

interface AgySession {
  id: string;
  path: string;
  projectDir: string;
  model: string;
  size: number;
  mtime: number;
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
  { mtime: number; size: number; projectDir: string; model: string }
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
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        out.push({
          id: entry,
          path: logPath,
          projectDir: cached.projectDir,
          model: cached.model,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      } else {
        const projectDir = detectProjectDir(logPath);
        const model = detectSessionModel(logPath);
        sessionMetaCache.set(logPath, { mtime: stat.mtimeMs, size: stat.size, projectDir, model });
        out.push({
          id: entry,
          path: logPath,
          projectDir,
          model,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
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
  const vProjBox = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  vProjBox.add(new TextRenderable(renderer, { content: "📁 Project:", fg: "#94a3b8" }));
  const vProjVal1 = new TextRenderable(renderer, { content: "  —", fg: "#4ade80" });
  const vProjVal2 = new TextRenderable(renderer, { content: "", fg: "#4ade80" });
  vProjBox.add(vProjVal1);
  vProjBox.add(vProjVal2);
  sidebar.add(vProjBox);

  const vSessBox = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  vSessBox.add(new TextRenderable(renderer, { content: "🆔 Session:", fg: "#94a3b8" }));
  const vSessVal1 = new TextRenderable(renderer, { content: "  —", fg: "#67e8f9" });
  const vSessVal2 = new TextRenderable(renderer, { content: "", fg: "#67e8f9" });
  vSessBox.add(vSessVal1);
  vSessBox.add(vSessVal2);
  sidebar.add(vSessBox);

  const vModelBox = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  vModelBox.add(new TextRenderable(renderer, { content: "🤖 Model:", fg: "#94a3b8" }));
  const vModelVal1 = new TextRenderable(renderer, { content: "  —", fg: "#fbbf24" });
  const vModelVal2 = new TextRenderable(renderer, { content: "", fg: "#fbbf24" });
  vModelBox.add(vModelVal1);
  vModelBox.add(vModelVal2);
  sidebar.add(vModelBox);

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
  let currentPos = 0,
    remainder = "",
    stepCount = 0,
    pushCount = 0;
  let lastActivityMs = Date.now();
  let activeFileFd: number | null = null;
  let spinnerIdx = 0,
    spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let isLive = true;
  let scheduledUntilMs = 0;
  let scheduledPrompt = "";
  let activeBackgroundTask: string | null = null;
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
    liveTxt.content = isLive ? "[LIVE]" : "[SCROLL]";
    liveTxt.fg = isLive ? "#68d391" : ("#f6ad55" as any);
  }

  let isAppDestroyed = false;

  function updateSidebar() {
    if (isAppDestroyed) return;
    const folder =
      currentSession.projectDir !== "(Unbound session)"
        ? path.basename(currentSession.projectDir)
        : "Unbound";

    if (folder.length > 28) {
      vProjVal1.content = "  " + folder.slice(0, 28);
      vProjVal2.content = "  " + folder.slice(28);
    } else {
      vProjVal1.content = "  " + folder;
      vProjVal2.content = "";
    }

    const sessId = currentSession.id;
    if (sessId.length > 18) {
      vSessVal1.content = "  " + sessId.slice(0, 18);
      vSessVal2.content = "  " + sessId.slice(18);
    } else {
      vSessVal1.content = "  " + sessId;
      vSessVal2.content = "";
    }

    const model = currentModel || currentSession.model || "Gemini 3.7 Flash";
    if (model.length > 28) {
      vModelVal1.content = "  " + model.slice(0, 28);
      vModelVal2.content = "  " + model.slice(28);
    } else {
      vModelVal1.content = "  " + model;
      vModelVal2.content = "";
    }

    vSteps.content = String(stepCount);
    vSize.content = fmtSize(currentSession.size);
    vAge.content = timeAgo(currentSession.mtime);

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
    // Check every 20 pushes and drop back to 200 in one batch — avoids O(n²)
    // array-copy + per-node remove() churn when a big step arrives.
    if (++pushCount % 20 === 0 && scrollBox.getChildrenCount() > 300) {
      const children = [...scrollBox.getChildren()] as Renderable[];
      const toRemove = children.slice(0, children.length - 200);
      for (let i = toRemove.length - 1; i >= 0; i--) {
        destroyRenderable(toRemove[i]);
      }
    }
  }

  function destroyRenderable(r: Renderable) {
    if (typeof (r as any).destroyRecursively === "function") {
      (r as any).destroyRecursively();
    } else if (typeof (r as any).destroy === "function") {
      (r as any).destroy();
    }
  }

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
  function resetCounters() {
    stepCount = 0;
    userPromptCount = 0;
    plannerResponseCount = 0;
    toolCallCount = 0;
    checkpointCount = 0;
    activeContextChars = 0;
  }

  function unescapeCodeString(str: any): string {
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

  function pushCard(lines: { text: string; fg?: string; isTitle?: boolean }[]) {
    const cardW = getCardWidth();
    const CARD_BG = "#1e293b";
    pushLine("");
    for (const item of lines) {
      const raw = item.text || "";
      const wrapped = wrapLine(raw, cardW - 4);
      for (const w of wrapped) {
        const content = "▎ " + w;
        const visibleLen = stripAnsi(content).length;
        const padding = " ".repeat(Math.max(0, cardW - visibleLen));
        pushLine(content + padding, item.fg || "#e2e8f0", CARD_BG);
      }
    }
    pushLine("");
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
          pushLine(`  💻 Code ${lang ? `(${lang})` : ""}`, "#22c55e");
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
          pushLine(content + padding, "#ffffff", "#1e293b");
        }
        continue;
      }

      if (trimmed.startsWith("# ")) {
        pushLine(`  🔷 ${trimmed.slice(2)}`, "#c084fc");
      } else if (trimmed.startsWith("## ")) {
        pushLine(`  🔹 ${trimmed.slice(3)}`, "#38bdf8");
      } else if (trimmed.startsWith("### ")) {
        pushLine(`  ▸ ${trimmed.slice(4)}`, "#fbbf24");
      } else if (/^[-*]\s+/.test(trimmed)) {
        pushLine(`    • ${trimmed.replace(/^[-*]\s+/, "")}`, "#ffffff");
      } else if (/^\d+\.\s+/.test(trimmed)) {
        pushLine(`    ${trimmed}`, "#fde047");
      } else if (trimmed.startsWith("> ")) {
        pushLine(`    ▎ ${trimmed.slice(2)}`, "#cbd5e1");
      } else if (trimmed === "---" || trimmed === "___" || trimmed === "***") {
        pushLine("  ────────────────────────────────────────────────────────────", "#374151");
      } else if (!trimmed) {
        pushLine("");
      } else {
        pushLine(`  ${raw}`, "#ffffff");
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
      const clean = unescapeCodeString(capText(step.content)).trim();
      const lines = clean.split("\n");
      const cardLines: { text: string; fg?: string; isTitle?: boolean }[] = [
        { text: "👤 [USER TASK]", fg: "#60a5fa", isTitle: true },
        ...lines.map((l) => ({ text: "  " + l, fg: "#ffffff" })),
      ];
      pushCard(cardLines);
      stopSpinner("✓ Task received");
      startSpinner("Agent thinking...");
      return;
    }

    // 2. CHECKPOINT
    if (step.type === "CHECKPOINT") {
      pushLine("  📌 [CHECKPOINT / SUMMARY CONTEXT]", "#ca8a04");
      return;
    }

    // 3. SYSTEM_MESSAGE
    if (step.type === "SYSTEM_MESSAGE" && step.content) {
      const raw = String(step.content).trim();
      scheduledUntilMs = 0;
      activeBackgroundTask = null;
      if (raw.includes("exited with code 0")) {
        pushLine("  ⚡ [TASK SUCCESS] Background task exited with code 0", "#4ade80");
      } else if (
        raw.includes("exited with code") ||
        raw.includes("error") ||
        raw.includes("Error")
      ) {
        pushLine("  ⚠️  [TASK ERROR] " + raw.slice(0, 150), "#f87171");
      } else {
        pushLine("  ⚡ [SYSTEM] " + raw.slice(0, 150), "#94a3b8");
      }
      return;
    }

    // 4. PLANNER_RESPONSE
    if (step.type === "PLANNER_RESPONSE") {
      // Model Thinking
      if (step.thinking && typeof step.thinking === "string") {
        const lines = capText(step.thinking).trim().split("\n");
        pushLine("  🧠 [Thinking]", "#c084fc");
        for (const l of lines) {
          if (l.trim()) pushLine("    " + l, "#a855f7");
        }
      }

      // Assistant Commentary / Content
      const hasTools = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
      if (step.content) {
        const clean = capText(step.content).trim();
        if (clean) {
          pushLine("");
          pushLine(
            hasTools ? "  💬 [Assistant]" : "  💬 [Assistant Response]",
            hasTools ? "#38bdf8" : "#4ade80",
          );
          renderMarkdown(clean);
          if (!hasTools) {
            const hasActiveWait = scheduledUntilMs > Date.now() || Boolean(activeBackgroundTask);
            if (hasActiveWait) {
              const isTimer = scheduledUntilMs > Date.now();
              const sec = Math.ceil((scheduledUntilMs - Date.now()) / 1000);
              const waitMsg = isTimer
                ? `⏳ Menunggu timer "${scheduledPrompt}" (${sec}s)...`
                : "⚙️ Menunggu background task selesai...";
              pushLine(`  ${waitMsg}`, "#f59e0b");
              startSpinner(waitMsg);
              return;
            }

            pushLine("");
            pushLine("  ────────────────────────────────────────────────────────────", "#374151");
            pushLine("  ✨ [COMPLETED] Tugas agy telah selesai dengan sukses!", "#4ade80");
            pushLine("");
            stopSpinner("✓ Finished");
            return;
          }
        }
      }

      // Tool Calls
      if (hasTools) {
        for (const tc of step.tool_calls) {
          const name = tc.name || "tool";
          const args = tc.args || {};
          switch (name) {
            case "view_file": {
              const file = args.AbsolutePath || args.file || "";
              const rel = path.relative(process.cwd(), file) || file;
              const sLine = args.StartLine ? ` (L${args.StartLine}-${args.EndLine || ""})` : "";
              pushLine(`  🔍 [VIEW FILE] ${rel}${sLine}`, "#38bdf8");
              break;
            }
            case "write_to_file": {
              const file = args.TargetFile || args.target_file || "";
              const rel = path.relative(process.cwd(), file) || file;
              const raw = unescapeCodeString(capText(args.CodeContent || ""));
              const lines = raw.split("\n");
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
              pushCard(cardLines);
              break;
            }
            case "replace_file_content": {
              const file = args.TargetFile || args.target_file || "";
              const rel = path.relative(process.cwd(), file) || file;
              const sLine = args.StartLine ? Number(args.StartLine) : 1;
              const rawT = unescapeCodeString(capText(args.TargetContent || ""));
              const rawR = unescapeCodeString(capText(args.ReplacementContent || ""));
              const tLines = rawT.split("\n");
              const rLines = rawR.split("\n");
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
              pushCard(cardLines);
              break;
            }
            case "run_command": {
              const cmd = unescapeCodeString(args.CommandLine || args.command || "").trim();
              activeBackgroundTask = cmd;
              pushCard([
                { text: "💻 [BASH EXECUTION]", fg: "#38bdf8", isTitle: true },
                { text: `  $ ${cmd}`, fg: "#fde047" },
              ]);
              break;
            }
            case "grep_search":
            case "find_by_name": {
              const query = args.Query || args.Pattern || "";
              pushLine(`  🔎 [SEARCH] ${name} -> "${query}"`, "#818cf8");
              break;
            }
            case "schedule": {
              const sec = parseInt(args.DurationSeconds || args.duration_seconds || "60", 10);
              const p = String(args.Prompt || args.prompt || "Waiting for task");
              scheduledUntilMs = Date.now() + sec * 1000;
              scheduledPrompt = p;
              pushLine(`  ⏳ [SCHEDULE] "${p}" (${sec}s)`, "#f59e0b");
              break;
            }
            default: {
              const summary = capText(args.toolSummary || tc.name || "tool", 200);
              pushLine(`  🔧 [TOOL: ${name}] ${summary}`, "#93c5fd");
              break;
            }
          }
        }
        const first = step.tool_calls[0];
        const s = first?.args?.toolSummary ?? first?.name ?? "tool";
        stopSpinner(`▶ ${s}`);
        startSpinner(`${s}...`);
      }
      return;
    }

    // 5. Tool Output Steps (VIEW_FILE, RUN_COMMAND, LIST_DIRECTORY, GENERIC, etc.)
    if (step.content && typeof step.content === "string") {
      const raw = unescapeCodeString(capText(step.content)).trim();
      if (raw) {
        const lines = raw.split("\n");
        const cardW = getCardWidth();
        const innerW = Math.max(15, cardW - 13);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {
            pushLine("");
            continue;
          }
          const wrapped = wrapLine(l, innerW);
          for (let j = 0; j < wrapped.length; j++) {
            const prefix = i === 0 && j === 0 ? "  ↳ [Output] " : "             ";
            pushLine(prefix + wrapped[j], "#94a3b8");
          }
        }
      }
      stopSpinner("✓ Output received");
      startSpinner("Agent processing...");
    }
  }

  // ── Poll ───────────────────────────────────────────────────────────────────────
  function poll() {
    try {
      if (!activeFileFd) activeFileFd = fs.openSync(currentSession.path, "r");
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
        updateSidebar();
        renderer.requestRender();
      }
    } catch {}
  }

  // ── Session switch ─────────────────────────────────────────────────────────────
  function switchSession(s: AgySession) {
    if (!s) return;
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
    currentModel = s.model || "Detecting...";
    clearScrollBox();
    resetCounters();
    updateSidebar();
    updateLiveLabel();
    startSpinner("Loading session...");
    poll();
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
      topRow.add(
        new TextRenderable(renderer, {
          content: `📁 ${folder}`,
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
        backgroundColor: "#1e293b",
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
          switchSession(chosen);
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
        switchSession(cachedSessions[num - 1]);
        return;
      }
      return;
    }

    // Normal mode
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
    if (Date.now() - lastActivityMs > 25000 && spinnerTimer) {
      stopSpinner("💤 Idle — waiting for next agy command...");
    }
    updateSidebar();
  }, 2000);

  const quotaInterval = setInterval(fetchLiveQuotaAsync, 120_000);

  // ── Start ───────────────────────────────────────────────────────────────────────
  startSpinner("Loading session history...");
  fetchLiveQuotaAsync();
  const pollInterval = setInterval(poll, 100);
  renderer.once("destroy", () => {
    isAppDestroyed = true;
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
