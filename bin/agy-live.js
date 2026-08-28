#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
};

function stripAnsi(str) {
  if (!str) return "";
  return String(str).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function visibleLength(str) {
  return stripAnsi(str).length;
}

function truncateAnsi(str, maxLen) {
  if (!str) return "";
  let visible = 0;
  let result = "";
  const parts = String(str).split(/(\x1b\[[0-9;]*[a-zA-Z])/);
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      result += part;
    } else {
      for (const ch of part) {
        if (visible >= maxLen) {
          result += C.reset;
          return result;
        }
        result += ch;
        visible++;
      }
    }
  }
  return result;
}

function padLine(str, targetWidth) {
  const visible = visibleLength(str);
  if (visible >= targetWidth) return truncateAnsi(str, targetWidth);
  return str + " ".repeat(targetWidth - visible);
}

function getSidebarWidth(width) {
  return Math.min(36, Math.max(26, Math.floor(width * 0.32)));
}

function getLogViewportWidth() {
  const width = Math.max(55, (process.stdout.columns || 80) - 1);
  const sidebarWidth = getSidebarWidth(width);
  return Math.max(20, width - sidebarWidth - 1);
}

function getTerminalWidth() {
  return getLogViewportWidth();
}

function fitText(text, maxLen) {
  if (!text) return "";
  const clean = String(text).replace(/\t/g, "  ").replace(/\r/g, "");
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 3)) + "...";
}

function unescapeCodeString(str) {
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

function wrapLine(text, maxWidth) {
  if (!text && text !== "") return [""];
  const clean = String(text).replace(/\t/g, "  ").replace(/\r/g, "");
  if (clean.length <= maxWidth) return [clean];

  const indentMatch = clean.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] + "  " : "  ";

  const chunks = [];
  let remaining = clean;
  let isFirst = true;

  while (remaining.length > 0) {
    const curMax = isFirst ? maxWidth : Math.max(10, maxWidth - indent.length);
    if (remaining.length <= curMax) {
      chunks.push(isFirst ? remaining : indent + remaining);
      break;
    }
    let breakIdx = -1;
    const slice = remaining.slice(0, curMax);
    for (let i = slice.length - 1; i >= Math.floor(curMax * 0.6); i--) {
      if ([" ", ",", ".", "(", ")", "{", "}", ";", ":", "/", "-"].includes(slice[i])) {
        breakIdx = i + 1;
        break;
      }
    }
    if (breakIdx === -1) {
      breakIdx = curMax;
    }
    const chunkPart = remaining.slice(0, breakIdx);
    chunks.push(isFirst ? chunkPart : indent + chunkPart);
    remaining = remaining.slice(breakIdx).trimStart();
    isFirst = false;
  }
  return chunks;
}

function formatLineNum(num, width = 4) {
  return String(num).padStart(width, " ");
}

function isAgyRuntimeError(text) {
  if (!text || typeof text !== "string") return false;
  return /(?:Agent execution terminated due to error|Error ID:\s*[0-9a-f-]+|experiencing high traffic|RESOURCE_EXHAUSTED \(code 429\)|rate limit exceeded|UNAVAILABLE \(code 503\)|model is overloaded|servers are experiencing high traffic)/i.test(
    text,
  );
}

function isCommandOrBuildError(text) {
  if (!text || typeof text !== "string") return false;
  return /(?:BUILD FAILED|Compilation error|CompilationWork|Unresolved reference|Syntax error|Argument type mismatch|exited with code [1-9]|FAILURE:)/i.test(
    text,
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
let spinnerTimer = null;
let lastStatusText = "Menunggu aktivitas agy...";
let startTime = Date.now();
let lastActivityTime = Date.now();
let isCompleted = false;
let isIdle = false;

let scheduledUntilMs = 0;
let scheduledPrompt = "";
let activeBackgroundTask = null;
let stepCount = 0;

let currentSession = null;
let activeFileFd = null;
let currentPos = 0;
let remainder = "";
let isSelectingSession = false;
let selectCursorIdx = 0;
let cachedSessionsList = [];

// TUI Viewport Buffer & Scrolling State
const logLines = [];
let scrollOffset = 0;
let redrawScheduled = false;

// Token Estimator State (~chars / 4)
let totalPromptChars = 0;
let totalThinkingChars = 0;
let totalOutputChars = 0;

function formatTokenCount(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "k";
  return String(num);
}

function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  setImmediate(() => {
    redrawScheduled = false;
    redrawUI();
  });
}

function startSpinner(text) {
  if (isCompleted) return;
  if (text) lastStatusText = text;
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    if (isCompleted) {
      stopSpinner();
      return;
    }
    spinnerIdx++;
    scheduleRedraw();
  }, 100);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

function printHeader(session) {
  currentSession = session;
  scheduleRedraw();
}

function renderBottomBar(width) {
  const now = Date.now();
  if (now < scheduledUntilMs) {
    isIdle = false;
    const remainingSec = Math.ceil((scheduledUntilMs - now) / 1000);
    const frame = SPINNER[spinnerIdx % SPINNER.length];
    return (
      "  " +
      C.yellow +
      C.bold +
      frame +
      " ⏳ [WAITING SCHEDULE] " +
      C.reset +
      C.white +
      scheduledPrompt +
      C.reset +
      " " +
      C.cyan +
      "(" +
      remainingSec +
      "s tersisa)" +
      C.reset
    );
  }

  const timeSinceLastActivity = now - lastActivityTime;
  if (timeSinceLastActivity > 25000 && !isIdle && scheduledUntilMs <= now) {
    isIdle = true;
  }

  if (isIdle) {
    return (
      "  " +
      C.dim +
      "💤 Menunggu delegasi/perintah agy berikutnya... (" +
      Math.floor(timeSinceLastActivity / 1000) +
      "s idle)" +
      C.reset
    );
  }

  const elapsed = Math.floor((now - startTime) / 1000);
  const frame = SPINNER[spinnerIdx % SPINNER.length];
  return (
    "  " +
    C.cyan +
    frame +
    C.reset +
    " " +
    C.bold +
    lastStatusText +
    C.reset +
    " " +
    C.dim +
    "(" +
    elapsed +
    "s)" +
    C.reset
  );
}

function redrawUI() {
  if (isSelectingSession) return;
  if (!currentSession) return;

  const width = Math.max(55, (process.stdout.columns || 80) - 1);
  const rows = Math.max(12, process.stdout.rows || 24);

  const sidebarWidth = Math.min(36, Math.max(26, Math.floor(width * 0.32)));
  const leftWidth = Math.max(20, width - sidebarWidth - 1);

  let buf = "\x1b[?25l\x1b[H"; // Hide cursor and move to (1,1)

  // 1. Top Headers (2 Columns)
  const leftHeader =
    C.bgBlue + C.white + C.bold + padLine("  📜 AGY ACTIVITY LOG", leftWidth) + C.reset;
  const rightHeader =
    C.bgCyan + C.black + C.bold + padLine("  ℹ️ MONITOR & STATS", sidebarWidth) + C.reset;
  buf += leftHeader + C.gray + "│" + C.reset + rightHeader + "\n";

  // Top Border
  buf += C.gray + "━".repeat(leftWidth) + "┿" + "━".repeat(sidebarWidth) + C.reset + "\n";

  // 2. Prepare Sidebar Content Lines
  const estPromptTokens = Math.round(totalPromptChars / 4);
  const estThinkingTokens = Math.round(totalThinkingChars / 4);
  const estOutputTokens = Math.round(totalOutputChars / 4);
  const estTotalTokens = estPromptTokens + estThinkingTokens + estOutputTokens;

  const folderName =
    currentSession.projectDir && currentSession.projectDir !== "(Unbound session)"
      ? path.basename(currentSession.projectDir)
      : "Unbound";

  const sizeKb = Math.round(currentSession.size / 1024);
  const sizeDisplay = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + " MB" : sizeKb + " KB";

  const sidebarLines = [
    " " + C.dim + "📁 Project:" + C.reset,
    "  " + C.green + C.bold + fitText(folderName, sidebarWidth - 4) + C.reset,
    " " + C.dim + "🆔 Session:" + C.reset,
    "  " + C.cyan + currentSession.id.slice(0, 10) + "..." + C.reset,
    " " + C.dim + "🔢 Steps  : " + C.white + stepCount + " steps" + C.reset,
    " " + C.dim + "📄 LogSize: " + C.white + sizeDisplay + C.reset,
    C.gray + " " + "─".repeat(Math.max(4, sidebarWidth - 3)) + C.reset,
    " " + C.yellow + C.bold + "📊 EST. TOKENS (~ch/4):" + C.reset,
    "  " +
      C.dim +
      "• Prompt   :" +
      C.reset +
      " " +
      C.white +
      formatTokenCount(estPromptTokens) +
      C.reset,
    "  " +
      C.dim +
      "• Thinking :" +
      C.reset +
      " " +
      C.magenta +
      formatTokenCount(estThinkingTokens) +
      C.reset,
    "  " +
      C.dim +
      "• Output   :" +
      C.reset +
      " " +
      C.green +
      formatTokenCount(estOutputTokens) +
      C.reset,
    "  " +
      C.dim +
      "• Total    :" +
      C.reset +
      " " +
      C.yellow +
      C.bold +
      formatTokenCount(estTotalTokens) +
      C.reset,
    C.gray + " " + "─".repeat(Math.max(4, sidebarWidth - 3)) + C.reset,
    " " + C.yellow + C.bold + "⌨️  KEYBINDINGS:" + C.reset,
    "  " + C.yellow + "[s]" + C.reset + " Ganti Sesi",
    "  " + C.yellow + "[c]" + C.reset + " Bersihkan",
    "  " + C.yellow + "[↑/↓/PgUp/Dn]" + C.reset + " Scroll",
    "  " + C.yellow + "[q]" + C.reset + " Keluar",
  ];

  // 3. Viewport Rows (Rows 3 to rows - 2)
  const headerHeight = 2;
  const footerHeight = 2; // divider + bottom status bar
  const vHeight = Math.max(1, rows - headerHeight - footerHeight);

  // Clamp scrollOffset
  const maxScroll = Math.max(0, logLines.length - vHeight);
  if (scrollOffset > maxScroll) scrollOffset = maxScroll;
  if (scrollOffset < 0) scrollOffset = 0;

  const endIdx = Math.max(0, logLines.length - scrollOffset);
  const startIdx = Math.max(0, endIdx - vHeight);
  const visibleLogSlice = logLines.slice(startIdx, endIdx);

  for (let i = 0; i < vHeight; i++) {
    const leftText = i < visibleLogSlice.length ? visibleLogSlice[i] : "";
    const rightText = i < sidebarLines.length ? sidebarLines[i] : "";
    buf +=
      padLine(leftText, leftWidth) +
      C.gray +
      "│" +
      C.reset +
      padLine(rightText, sidebarWidth) +
      "\n";
  }

  // 4. Bottom Divider & Status Bar
  buf += C.gray + "━".repeat(width) + C.reset + "\n";

  const scrollStatus =
    scrollOffset > 0
      ? C.yellow + C.bold + ` [SCROLL: +${scrollOffset} baris ke atas | 'G' ke bawah]` + C.reset
      : C.green + " [LIVE]" + C.reset;

  buf += padLine(renderBottomBar(width - 30) + scrollStatus, width);

  process.stdout.write(buf);
}

function formatDiffWithLineNumbers(
  targetContent,
  replacementContent,
  startLine = 1,
  maxLines = Infinity,
) {
  const tWidth = getTerminalWidth();
  const maxAllowedColWidth = Math.max(16, Math.floor((tWidth - 22) / 2));
  const cleanTarget = unescapeCodeString(targetContent);
  const cleanReplacement = unescapeCodeString(replacementContent);
  const tLines = cleanTarget.split("\n");
  const rLines = cleanReplacement.split("\n");
  const sLine = Number(startLine) > 0 ? Number(startLine) : 1;
  const totalLogicalLines = Math.max(tLines.length, rLines.length);

  const maxLineLen = Math.max(
    14,
    ...tLines.map((l) => (l || "").length),
    ...rLines.map((l) => (l || "").length),
  );
  const colWidth = Math.min(maxAllowedColWidth, maxLineLen + 4);
  const textWidth = Math.max(10, colWidth - 2);

  let output = "";
  // Top border
  output +=
    C.gray +
    "    ┌──────┬" +
    "─".repeat(colWidth + 2) +
    "┬──────┬" +
    "─".repeat(colWidth + 2) +
    "┐" +
    C.reset +
    "\n";
  // Column Header
  output +=
    C.gray +
    "    │" +
    C.bold +
    " LINE " +
    C.gray +
    "│ " +
    C.red +
    C.bold +
    "ORIGINAL (-)".padEnd(colWidth, " ") +
    C.gray +
    " │" +
    C.bold +
    " LINE " +
    C.gray +
    "│ " +
    C.green +
    C.bold +
    "MODIFIED (+)".padEnd(colWidth, " ") +
    C.gray +
    " │" +
    C.reset +
    "\n";
  output +=
    C.gray +
    "    ├──────┼" +
    "─".repeat(colWidth + 2) +
    "┼──────┼" +
    "─".repeat(colWidth + 2) +
    "┤" +
    C.reset +
    "\n";

  let renderedVisualRows = 0;

  for (let k = 0; k < totalLogicalLines; k++) {
    const leftChunks = k < tLines.length ? wrapLine(tLines[k], textWidth) : [];
    const rightChunks = k < rLines.length ? wrapLine(rLines[k], textWidth) : [];
    const subRows = Math.max(leftChunks.length, rightChunks.length, 1);

    for (let s = 0; s < subRows; s++) {
      if (renderedVisualRows >= maxLines) break;
      renderedVisualRows++;

      // Left side (Original)
      let leftNum = "    ";
      let leftContent = "".padEnd(colWidth, " ");
      let leftColor = C.dim;

      if (k < tLines.length) {
        leftColor = C.red;
        if (s === 0) {
          leftNum = formatLineNum(sLine + k, 4);
          leftContent = ("- " + (leftChunks[0] || "")).padEnd(colWidth, " ");
        } else {
          leftContent = ("  " + (leftChunks[s] || "")).padEnd(colWidth, " ");
        }
      }

      // Right side (Modified)
      let rightNum = "    ";
      let rightContent = "".padEnd(colWidth, " ");
      let rightColor = C.dim;

      if (k < rLines.length) {
        rightColor = C.green;
        if (s === 0) {
          rightNum = formatLineNum(sLine + k, 4);
          rightContent = ("+ " + (rightChunks[0] || "")).padEnd(colWidth, " ");
        } else {
          rightContent = ("  " + (rightChunks[s] || "")).padEnd(colWidth, " ");
        }
      }

      output +=
        C.gray +
        "    │" +
        leftColor +
        " " +
        leftNum +
        " " +
        C.gray +
        "│ " +
        leftColor +
        leftContent +
        C.gray +
        " │" +
        rightColor +
        " " +
        rightNum +
        " " +
        C.gray +
        "│ " +
        rightColor +
        rightContent +
        C.gray +
        " │" +
        C.reset +
        "\n";
    }

    if (renderedVisualRows >= maxLines) {
      const remainingLines = totalLogicalLines - k - 1;
      if (remainingLines > 0) {
        const moreText = `... (${remainingLines} baris lainnya)`;
        output +=
          C.gray +
          "    ├──────┴" +
          "─".repeat(colWidth + 2) +
          "┴──────┴" +
          "─".repeat(colWidth + 2) +
          "┤" +
          C.reset +
          "\n";
        output +=
          C.gray +
          "    │ " +
          C.dim +
          moreText.padEnd(colWidth * 2 + 15, " ") +
          C.gray +
          " │" +
          C.reset +
          "\n";
      }
      break;
    }
  }

  output +=
    C.gray +
    "    └──────┴" +
    "─".repeat(colWidth + 2) +
    "┴──────┴" +
    "─".repeat(colWidth + 2) +
    "┘" +
    C.reset +
    "\n";
  return output;
}

function formatCodePreviewWithLineNumbers(code, startLine = 1, maxLines = Infinity) {
  const tWidth = getTerminalWidth();
  const maxAllowedWidth = Math.max(30, tWidth - 18);
  const cleanCode = unescapeCodeString(code);
  const lines = cleanCode.split("\n");
  const sLine = Number(startLine) > 0 ? Number(startLine) : 1;

  const maxLineLen = Math.max(14, ...lines.map((l) => (l || "").length));
  const contentWidth = Math.min(maxAllowedWidth, maxLineLen + 4);
  const textWidth = Math.max(10, contentWidth - 2);

  let output = "";
  output += C.gray + "    ┌──────┬" + "─".repeat(contentWidth + 2) + "┐" + C.reset + "\n";

  let renderedVisualRows = 0;
  for (let k = 0; k < lines.length; k++) {
    const chunks = wrapLine(lines[k], textWidth);
    for (let s = 0; s < chunks.length; s++) {
      if (renderedVisualRows >= maxLines) break;
      renderedVisualRows++;

      const lineNo = s === 0 ? formatLineNum(sLine + k, 4) : "    ";
      const prefix = s === 0 ? "+ " : "  ";
      const lineText = (prefix + chunks[s]).padEnd(contentWidth, " ");
      output +=
        C.gray +
        "    │" +
        C.green +
        " " +
        lineNo +
        " " +
        C.gray +
        "│ " +
        C.green +
        lineText +
        C.gray +
        "│" +
        C.reset +
        "\n";
    }
    if (renderedVisualRows >= maxLines) {
      const remaining = lines.length - k - 1;
      if (remaining > 0) {
        const moreText = `... (${remaining} baris lainnya)`;
        output += C.gray + "    ├──────┴" + "─".repeat(contentWidth + 2) + "┤" + C.reset + "\n";
        output +=
          C.gray +
          "    │ " +
          C.dim +
          moreText.padEnd(contentWidth + 8, " ") +
          C.gray +
          "│" +
          C.reset +
          "\n";
      }
      break;
    }
  }

  output += C.gray + "    └──────┴" + "─".repeat(contentWidth + 2) + "┘" + C.reset + "\n";
  return output;
}

function formatBashBox(cmd) {
  const tWidth = getTerminalWidth();
  const maxInner = Math.max(30, tWidth - 12);
  const clean = (cmd || "").trim().replace(/\t/g, "  ");

  let lines = [];
  if (clean.length > maxInner) {
    const tokens = clean.split(/\s+/);
    let current = "$ ";
    for (const tok of tokens) {
      if ((current + tok).length > maxInner - 4 && current !== "$ ") {
        lines.push(current + " \\");
        current = "    " + tok + " ";
      } else {
        current += tok + " ";
      }
    }
    if (current.trim()) lines.push(current);
  } else {
    lines = ["$ " + clean];
  }

  let output = "";
  const headerTitle = " 💻 [BASH EXECUTION] ";
  const headerDashes = Math.max(2, maxInner - headerTitle.length);
  output +=
    C.cyan + C.bold + "  ╭──" + headerTitle + "─".repeat(headerDashes) + "╮" + C.reset + "\n";
  for (const l of lines) {
    output +=
      C.cyan +
      "  │ " +
      C.yellow +
      fitText(l, maxInner).padEnd(maxInner, " ") +
      C.cyan +
      " │" +
      C.reset +
      "\n";
  }
  output += C.cyan + "  ╰" + "─".repeat(maxInner + 2) + "╯" + C.reset + "\n";
  return output;
}

function renderInlineMarkdown(text) {
  if (!text) return "";
  let out = String(text);

  // Links: [label](url) -> cyan bold label
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, label) => {
    return C.cyan + C.bold + label + C.reset;
  });

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, bold) => {
    return C.bold + C.white + bold + C.reset;
  });
  out = out.replace(/__([^_]+)__/g, (_, bold) => {
    return C.bold + C.white + bold + C.reset;
  });

  // Inline Code: `code`
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    return C.yellow + code + C.reset;
  });

  // Italic: *text*
  out = out.replace(/\*([^*]+)\*/g, (_, italic) => {
    return C.dim + italic + C.reset;
  });

  return out;
}

function stripMarkdown(text) {
  if (!text) return "";
  let out = String(text);
  // Markdown links: [label](url) -> label
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Incomplete links from log truncation e.g. [label](url...
  out = out.replace(/\[([^\]]+)\]\([^\s)]*$/g, "$1");
  // Bold: **text** or __text__ -> text
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  // Inline code: `code` -> code
  out = out.replace(/`([^`]+)`/g, "$1");
  // Italic: *text* -> text
  out = out.replace(/\*([^*]+)\*/g, "$1");
  // Stray backticks from truncation
  out = out.replace(/`/g, "");
  return out.trim();
}

function styleCell(rawCell, cleanFittedText, isHeader) {
  if (isHeader) {
    return C.bold + C.white + cleanFittedText + C.reset;
  }
  if (/\[[^\]]+\]\(/.test(rawCell)) {
    return C.cyan + C.bold + cleanFittedText + C.reset;
  }
  if (/`[^`]+`/.test(rawCell)) {
    return C.yellow + cleanFittedText + C.reset;
  }
  if (/\*\*[^*]+\*\*/.test(rawCell)) {
    return C.bold + C.white + cleanFittedText + C.reset;
  }
  return C.white + cleanFittedText + C.reset;
}

function renderMarkdown(mdText, maxInner) {
  const clean = unescapeCodeString(mdText);
  const lines = clean.split("\n");
  const output = [];

  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBuffer = [];
  let inTable = false;
  let tableRows = [];

  const flushCodeBlock = () => {
    if (codeBuffer.length === 0 && !inCodeBlock) return;
    const meaningfulLines = codeBuffer.filter((l) => l.trim().length > 0);
    if (meaningfulLines.length > 0) {
      const langBadge = codeBlockLang ? `(${codeBlockLang}) ` : "";
      output.push("  " + C.cyan + "┌── 💻 Code " + langBadge + "─".repeat(25) + C.reset);
      for (const cl of codeBuffer) {
        output.push("  " + C.cyan + "│ " + C.white + fitText(cl, maxInner - 4) + C.reset);
      }
      output.push("  " + C.cyan + "└──" + "─".repeat(35) + C.reset);
    }
    inCodeBlock = false;
    codeBlockLang = "";
    codeBuffer = [];
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    const contentRows = tableRows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c.trim())));
    if (contentRows.length === 0) {
      tableRows = [];
      inTable = false;
      return;
    }

    const colCount = Math.max(...contentRows.map((r) => r.length));
    const rawColWidths = Array(colCount).fill(4);
    for (const r of contentRows) {
      for (let c = 0; c < colCount; c++) {
        const clean = stripMarkdown(r[c] || "");
        rawColWidths[c] = Math.max(rawColWidths[c], clean.length);
      }
    }

    const available = Math.max(20, maxInner - (colCount * 3 + 2));
    const totalRaw = rawColWidths.reduce((a, b) => a + b, 0) || 1;
    const colWidths = rawColWidths.map((w) => {
      if (totalRaw > available) {
        return Math.max(6, Math.floor((w / totalRaw) * available));
      }
      return w;
    });

    // Top border
    let topBorder = "    ┌";
    for (let c = 0; c < colCount; c++) {
      topBorder += "─".repeat(colWidths[c] + 2) + (c === colCount - 1 ? "┐" : "┬");
    }
    output.push(C.gray + topBorder + C.reset);

    contentRows.forEach((row, rIdx) => {
      let rowStr = "    │";
      for (let c = 0; c < colCount; c++) {
        const rawCell = (row[c] || "").trim();
        const clean = stripMarkdown(rawCell);
        const fitted = fitText(clean, colWidths[c]);
        const styled = styleCell(rawCell, fitted, rIdx === 0);
        const padding = " ".repeat(Math.max(0, colWidths[c] - fitted.length));
        rowStr += " " + styled + padding + C.gray + " │" + C.reset;
      }
      output.push(rowStr);

      if (rIdx === 0 && contentRows.length > 1) {
        let midBorder = "    ├";
        for (let c = 0; c < colCount; c++) {
          midBorder += "─".repeat(colWidths[c] + 2) + (c === colCount - 1 ? "┤" : "┼");
        }
        output.push(C.gray + midBorder + C.reset);
      }
    });

    let botBorder = "    └";
    for (let c = 0; c < colCount; c++) {
      botBorder += "─".repeat(colWidths[c] + 2) + (c === colCount - 1 ? "┘" : "┴");
    }
    output.push(C.gray + botBorder + C.reset);

    tableRows = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Truncated log snippet marker from transcript
    if (trimmed.startsWith("<truncated") && trimmed.endsWith(">")) {
      if (inTable) flushTable();
      if (inCodeBlock) flushCodeBlock();
      output.push("  " + C.dim + "⋯ [" + trimmed.slice(1, -1) + "] ⋯" + C.reset);
      continue;
    }

    // Code block toggle
    if (trimmed.startsWith("```")) {
      if (inTable) flushTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeBuffer = [];
      } else {
        flushCodeBlock();
      }
      continue;
    }

    // Auto-close code block if a new markdown section or header is encountered
    if (
      inCodeBlock &&
      (trimmed.startsWith("# ") ||
        trimmed.startsWith("## ") ||
        trimmed.startsWith("### ") ||
        trimmed === "---" ||
        trimmed === "***")
    ) {
      flushCodeBlock();
    }

    if (inCodeBlock) {
      codeBuffer.push(rawLine);
      continue;
    }

    // Markdown Table lines
    const isTableRow =
      trimmed.startsWith("|") &&
      (trimmed.endsWith("|") || (trimmed.match(/\|/g) || []).length >= 2);
    if (isTableRow) {
      inTable = true;
      const cells = trimmed
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Headings
    if (trimmed.startsWith("#### ")) {
      output.push(
        "\n  " + C.white + C.bold + "▫ " + renderInlineMarkdown(trimmed.slice(5)) + C.reset,
      );
      continue;
    }
    if (trimmed.startsWith("### ")) {
      output.push(
        "\n  " + C.yellow + C.bold + "▸ " + renderInlineMarkdown(trimmed.slice(4)) + C.reset,
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      output.push(
        "\n  " + C.cyan + C.bold + "🔹 " + renderInlineMarkdown(trimmed.slice(3)) + C.reset,
      );
      continue;
    }
    if (trimmed.startsWith("# ")) {
      output.push(
        "\n  " + C.magenta + C.bold + "🔷 " + renderInlineMarkdown(trimmed.slice(2)) + C.reset,
      );
      continue;
    }

    // Horizontal Rule
    if (/^(\*\*\*|---|___)$/.test(trimmed)) {
      output.push("  " + C.gray + "─".repeat(Math.min(maxInner, 60)) + C.reset);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      output.push("  " + C.dim + "▎ " + C.white + renderInlineMarkdown(trimmed.slice(2)) + C.reset);
      continue;
    }

    // Bullet lists
    if (/^[-*]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[-*]\s+/, "");
      output.push("  " + C.cyan + "• " + C.reset + renderInlineMarkdown(item));
      continue;
    }

    // Numbered lists
    if (/^\d+\.\s+/.test(trimmed)) {
      const match = trimmed.match(/^(\d+\.)\s+(.*)/);
      if (match) {
        output.push("  " + C.yellow + match[1] + " " + C.reset + renderInlineMarkdown(match[2]));
        continue;
      }
    }

    // Regular paragraph line
    if (!trimmed) {
      output.push("");
    } else {
      output.push("  " + renderInlineMarkdown(rawLine));
    }
  }

  if (inTable) flushTable();
  if (inCodeBlock) flushCodeBlock();
  return output.join("\n");
}

function renderStep(step) {
  stopSpinner();
  isIdle = false;
  lastActivityTime = Date.now();
  startTime = Date.now();
  stepCount++;

  // Update Token Estimator Counters
  if (step.type === "USER_INPUT" && step.content) {
    totalPromptChars += String(step.content).length;
  }
  if (step.type === "SYSTEM_MESSAGE" && step.content) {
    totalPromptChars += String(step.content).length;
  }
  if (step.type === "GENERIC" && step.content) {
    totalPromptChars += String(step.content).length;
  }
  if (step.thinking && typeof step.thinking === "string") {
    totalThinkingChars += step.thinking.length;
  }
  if (step.tool_calls && Array.isArray(step.tool_calls)) {
    totalOutputChars += JSON.stringify(step.tool_calls).length;
  }
  if (step.type === "PLANNER_RESPONSE" && step.content) {
    totalOutputChars += String(step.content).length;
  }

  const tWidth = getTerminalWidth();
  const maxInner = Math.max(30, tWidth - 12);

  const origLog = console.log;
  console.log = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    for (const sub of line.split("\n")) {
      logLines.push(sub);
    }
  };

  try {
    // 1. User Prompt
    if (step.type === "USER_INPUT" && step.content) {
      isCompleted = false;
      const clean = String(step.content)
        .replace(/<USER_REQUEST>|<\/USER_REQUEST>/g, "")
        .trim();
      const headerTitle = " 👤 [USER TASK] ";
      const headerDashes = Math.max(2, maxInner - headerTitle.length);

      console.log(
        C.blue + C.bold + "  ╭──" + headerTitle + "─".repeat(headerDashes) + "╮" + C.reset,
      );
      const rawLines = clean.split("\n");
      for (const rawLine of rawLines) {
        if (!rawLine.trim()) {
          console.log(C.blue + "  │ " + " ".repeat(maxInner) + C.blue + " │" + C.reset);
          continue;
        }
        const wrapped = wrapLine(rawLine, maxInner);
        for (const w of wrapped) {
          console.log(
            C.blue + "  │ " + C.white + C.bold + w.padEnd(maxInner, " ") + C.blue + " │" + C.reset,
          );
        }
      }
      console.log(C.blue + "  ╰" + "─".repeat(maxInner + 2) + "╯" + C.reset + "\n");
    }

    // 2. Fatal Agy / Model Runtime Error Interception
    const fullText = [
      typeof step.content === "string" ? step.content : "",
      typeof step.error === "string" ? step.error : "",
      typeof step.error_details === "string" ? step.error_details : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (isAgyRuntimeError(fullText)) {
      console.log(
        "  " + C.bgRed + C.white + C.bold + "  🚨 [AGY RUNTIME ERROR / TERMINATED]  " + C.reset,
      );
      for (const l of fullText.split("\n")) {
        if (l.trim()) {
          const chunks = wrapLine(l, maxInner - 4);
          for (const chunk of chunks) {
            console.log("    " + C.red + chunk + C.reset);
          }
        }
      }
      console.log();
      console.log(C.dim + "─".repeat(tWidth) + C.reset);
      console.log(
        "  " +
          C.yellow +
          C.bold +
          "⚠️  [PERLU RETRY / FOLLOW UP] Terjadi kendala runtime/server pada proses agy." +
          C.reset,
      );
      console.log(
        "  " +
          C.dim +
          "   Koneksi/sesi ini akan dilanjutkan otomatis oleh agent dengan follow_up." +
          C.reset +
          "\n",
      );
      isCompleted = false;
      stopSpinner();
      return;
    }

    // 3. System Message / Background Task Completed or Failed
    if (step.type === "SYSTEM_MESSAGE" && step.content) {
      const raw = unescapeCodeString(step.content).trim();
      scheduledUntilMs = 0;
      activeBackgroundTask = null;

      if (raw.includes("exited with code 0")) {
        console.log(
          "  " +
            C.green +
            C.bold +
            "⚡ [TASK SUCCESS]" +
            C.reset +
            " " +
            C.dim +
            "Background task exited with code 0." +
            C.reset +
            "\n",
        );
      } else if (raw.includes("exited with code") || isCommandOrBuildError(raw)) {
        console.log("  " + C.yellow + C.bold + "⚠️  [COMMAND FINISHED WITH ERROR]" + C.reset);
        const lines = raw.split("\n");
        for (const l of lines) {
          if (!l.trim()) continue;
          const chunks = wrapLine(l, maxInner - 4);
          for (const chunk of chunks) {
            console.log("    " + C.yellow + chunk + C.reset);
          }
        }
        console.log();
      } else if (raw.includes("finished with result") || raw.includes("completed")) {
        console.log(
          "  " +
            C.green +
            C.bold +
            "⚡ [TASK FINISHED]" +
            C.reset +
            " " +
            C.dim +
            "Background task completed." +
            C.reset +
            "\n",
        );
      }
    }

    // 4. Model Thinking
    if (step.thinking && typeof step.thinking === "string") {
      const cleanThinking = step.thinking.trim().replace(/\*\*/g, "");
      const lines = cleanThinking.split("\n");
      console.log("  " + C.magenta + C.bold + "🧠 [Thinking]" + C.reset);
      for (const l of lines) {
        if (!l.trim()) continue;
        const chunks = wrapLine(l, maxInner - 4);
        for (const chunk of chunks) {
          console.log("    " + C.dim + chunk + C.reset);
        }
      }
      console.log();
    }

    // 5. Assistant Commentary before Tool Calls
    const hasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
    if (step.type === "PLANNER_RESPONSE" && step.content && hasToolCalls) {
      const cleanMsg = String(step.content).trim();
      if (cleanMsg) {
        console.log("  " + C.cyan + C.bold + "💬 [Assistant]" + C.reset);
        console.log(renderMarkdown(cleanMsg, maxInner));
        console.log();
      }
    }

    // 6. Tool Calls
    if (hasToolCalls) {
      isCompleted = false;
      for (const tc of step.tool_calls) {
        const name = tc.name;
        const args = tc.args || {};

        switch (name) {
          case "schedule": {
            const sec = parseInt(args.DurationSeconds || args.duration_seconds || "60", 10);
            const p = String(args.Prompt || args.prompt || "Waiting for task");
            scheduledUntilMs = Date.now() + sec * 1000;
            scheduledPrompt = p;
            console.log(
              "  " +
                C.yellow +
                C.bold +
                "⏳ [SCHEDULE TIMER]" +
                C.reset +
                " " +
                C.white +
                p +
                " " +
                C.cyan +
                "(" +
                sec +
                "s)" +
                C.reset,
            );
            break;
          }

          case "write_to_file": {
            const file = args.TargetFile || args.target_file || "unknown";
            const relPath = path.relative(process.cwd(), file);
            console.log(
              "  " +
                C.green +
                C.bold +
                "📝 [WRITE FILE]" +
                C.reset +
                " " +
                C.white +
                C.bold +
                relPath +
                C.reset,
            );
            if (args.CodeContent) {
              process.stdout.write(formatCodePreviewWithLineNumbers(args.CodeContent, 1));
            }
            break;
          }

          case "replace_file_content": {
            const file = args.TargetFile || args.target_file || "unknown";
            const relPath = path.relative(process.cwd(), file);
            const sLine = args.StartLine || 1;
            console.log(
              "  " +
                C.yellow +
                C.bold +
                "✏️  [DIFF EDIT]" +
                C.reset +
                " " +
                C.white +
                C.bold +
                relPath +
                C.reset +
                C.dim +
                " (Line " +
                sLine +
                ")" +
                C.reset,
            );
            process.stdout.write(
              formatDiffWithLineNumbers(args.TargetContent, args.ReplacementContent, sLine),
            );
            break;
          }

          case "run_command": {
            const cmd = args.CommandLine || args.command || "";
            activeBackgroundTask = cmd;
            process.stdout.write(formatBashBox(cmd));
            break;
          }

          case "view_file": {
            const file = args.AbsolutePath || args.file || "";
            const relPath = path.relative(process.cwd(), file);
            const sLine = args.StartLine
              ? " (L" + args.StartLine + "-" + (args.EndLine || "") + ")"
              : "";
            console.log(
              "  " +
                C.blue +
                C.bold +
                "🔍 [VIEW FILE]" +
                C.reset +
                " " +
                C.dim +
                relPath +
                sLine +
                C.reset,
            );
            break;
          }

          case "grep_search":
          case "find_by_name": {
            const query = args.Query || args.Pattern || "";
            console.log(
              "  " +
                C.blue +
                C.bold +
                "🔎 [SEARCH]" +
                C.reset +
                " " +
                name +
                " -> " +
                C.cyan +
                '"' +
                query +
                '"' +
                C.reset,
            );
            break;
          }

          default: {
            console.log(
              "  " +
                C.blue +
                C.bold +
                "🔧 [" +
                name +
                "]" +
                C.reset +
                " " +
                C.dim +
                JSON.stringify(args) +
                C.reset,
            );
            break;
          }
        }
        console.log();
        startSpinner(
          name === "schedule"
            ? "Menunggu timer/background task..."
            : "Menjalankan tool: " + name + "...",
        );
        return;
      }
    }

    // 7. Generic / Tool Output
    if (step.type === "GENERIC" && step.content) {
      const raw = unescapeCodeString(step.content).trim();
      if (raw) {
        const lines = raw.split("\n");
        if (isAgyRuntimeError(raw)) {
          console.log("  " + C.red + C.bold + "🚨 [SERVER WARNING / ERROR]" + C.reset);
          for (const l of lines) {
            const chunks = wrapLine(l, maxInner - 4);
            for (const chunk of chunks) {
              console.log("    " + C.yellow + chunk + C.reset);
            }
          }
        } else if (isCommandOrBuildError(raw)) {
          console.log("  " + C.yellow + C.bold + "❌ [BUILD / COMMAND ERROR OUTPUT]" + C.reset);
          for (const l of lines) {
            if (!l.trim()) {
              console.log();
              continue;
            }
            const chunks = wrapLine(l, maxInner - 4);
            for (const chunk of chunks) {
              console.log("    " + C.yellow + chunk + C.reset);
            }
          }
        } else {
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (!l.trim()) {
              console.log();
              continue;
            }
            const chunks = wrapLine(l, maxInner - 14);
            for (let j = 0; j < chunks.length; j++) {
              const prefix = i === 0 && j === 0 ? "  " + C.dim + "↳ [Output] " : "             ";
              console.log(prefix + C.white + chunks[j] + C.reset);
            }
          }
        }
        console.log();
      }
    }

    // 8. Final Planner Response / Assistant Output
    if (step.type === "PLANNER_RESPONSE" && step.content && !hasToolCalls) {
      console.log("  " + C.green + C.bold + "💬 [Assistant Response]" + C.reset);
      console.log(renderMarkdown(step.content, maxInner));
      console.log();

      const hasActiveWait = scheduledUntilMs > Date.now() || Boolean(activeBackgroundTask);
      if (hasActiveWait) {
        isCompleted = false;
        startSpinner(
          scheduledUntilMs > Date.now()
            ? "Menunggu jadwal timer..."
            : "Menunggu background task selesai...",
        );
        return;
      }

      console.log(C.dim + "─".repeat(tWidth) + C.reset);
      console.log(
        "  " +
          C.bgGreen +
          C.white +
          C.bold +
          "  ✨ [SELESAI] Tugas agy telah selesai dengan sukses!  " +
          C.reset,
      );
      console.log(
        "  " +
          C.dim +
          "Sesi siap untuk tugas berikutnya (gunakan follow_up atau delegasi baru)." +
          C.reset +
          "\n",
      );
      isCompleted = true;
      stopSpinner();
      return;
    }

    startSpinner("agy sedang memproses langkah berikutnya...");
  } finally {
    console.log = origLog;
  }

  if (scrollOffset === 0) {
    scheduleRedraw();
  }
}

function detectProjectDirFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString("utf8");

    // Look for path patterns in tool call arguments
    const match = chunk.match(
      /"(?:Cwd|SearchDirectory|SearchPath|AbsolutePath|DirectoryPath)":\s*"\\?"(\/[^"\\]+)/,
    );
    if (match && match[1]) {
      let p = match[1];
      while (p && p !== "/" && p !== os.homedir()) {
        if (
          fs.existsSync(path.join(p, ".git")) ||
          fs.existsSync(path.join(p, "settings.gradle.kts")) ||
          fs.existsSync(path.join(p, "settings.gradle")) ||
          fs.existsSync(path.join(p, "package.json"))
        ) {
          return p;
        }
        const parent = path.dirname(p);
        if (parent === p) break;
        p = parent;
      }
      return match[1];
    }
  } catch {}
  return null;
}

function getAllSessions() {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  const sessionsFile = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "cache",
    "last_conversations.json",
  );

  let cwdMap = {};
  if (fs.existsSync(sessionsFile)) {
    try {
      cwdMap = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    } catch (e) {}
  }

  const convToCwd = {};
  for (const [dir, id] of Object.entries(cwdMap)) {
    convToCwd[id] = dir;
  }

  if (!fs.existsSync(brainDir)) return [];

  const entries = fs.readdirSync(brainDir, { withFileTypes: true });
  const list = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const convId = ent.name;
    const transcript = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(transcript)) {
      try {
        const stat = fs.statSync(transcript);
        const project =
          convToCwd[convId] || detectProjectDirFromTranscript(transcript) || "(Unbound session)";
        list.push({
          id: convId,
          projectDir: project,
          path: transcript,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      } catch (e) {}
    }
  }

  list.sort((a, b) => b.mtime - a.mtime);
  return list;
}

function findProjectSession(sessions) {
  const cwd = path.resolve(process.cwd());
  const home = os.homedir();

  let current = cwd;
  while (current && current !== "/" && current !== home) {
    const found = sessions.find((s) => s.projectDir && path.resolve(s.projectDir) === current);
    if (found) return found;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function getMaxDisplaySessions() {
  const rows = Math.max(12, process.stdout.rows || 24);
  return Math.min(cachedSessionsList.length, Math.max(3, Math.floor((rows - 5) / 2)));
}

function drawSessionSelector() {
  const width = Math.max(40, (process.stdout.columns || 80) - 1);
  const rows = Math.max(12, process.stdout.rows || 24);
  const line = "━".repeat(width);

  let buf = "\x1b[?25l\x1b[2J\x1b[H"; // Clear screen & move to (1,1)
  buf +=
    C.bgBlue +
    C.white +
    C.bold +
    padLine("  📋 PILIH SESI AGY UNTUK DIMONITOR", width) +
    C.reset +
    "\n";
  buf +=
    padLine(
      "  " +
        C.dim +
        "Gunakan panah [↑/↓] atau angka [1-9], tekan [Enter] untuk pilih, [Esc] batal." +
        C.reset,
      width,
    ) + "\n";
  buf += C.gray + line + C.reset + "\n";

  const maxItems = getMaxDisplaySessions();
  const displayList = cachedSessionsList.slice(0, maxItems);

  displayList.forEach((s, idx) => {
    const isSelected = idx === selectCursorIdx;
    const isCurrent = currentSession && currentSession.id === s.id;
    const badge = isCurrent
      ? C.green + " [AKTIF]" + C.reset
      : idx === 0
        ? C.cyan + " [TERBARU]" + C.reset
        : "";
    const timeStr = new Date(s.mtime).toLocaleTimeString();
    const folderName =
      s.projectDir && s.projectDir !== "(Unbound session)"
        ? path.basename(s.projectDir)
        : "Unbound";

    const prefix = isSelected
      ? C.yellow + C.bold + " 👉 [" + (idx + 1) + "] "
      : C.gray + "    [" + (idx + 1) + "] ";
    const idText = isSelected
      ? C.yellow + C.bold + s.id.slice(0, 8) + "..." + C.reset
      : C.cyan + s.id.slice(0, 8) + "..." + C.reset;
    const nameText = isSelected
      ? C.white + C.bold + "(" + folderName + ")" + C.reset
      : C.white + "(" + folderName + ")" + C.reset;

    const row1 = prefix + idText + " " + nameText + badge;
    buf += padLine(row1, width) + "\n";

    const folderDisplay =
      s.projectDir !== "(Unbound session)"
        ? fitText(s.projectDir, Math.max(20, width - 35))
        : "(Unbound session)";
    const sizeKb = Math.round(s.size / 1024);
    const row2 =
      "       " +
      C.dim +
      "📁 " +
      folderDisplay +
      "  │  🕒 " +
      timeStr +
      " (" +
      sizeKb +
      " KB)" +
      C.reset;
    buf += padLine(row2, width) + "\n";
  });

  process.stdout.write(buf);
}

function switchSession(newSession) {
  isSelectingSession = false;
  stopSpinner();

  if (activeFileFd) {
    try {
      fs.closeSync(activeFileFd);
    } catch (e) {}
    activeFileFd = null;
  }

  currentSession = newSession;
  currentPos = 0;
  remainder = "";
  stepCount = 0;
  isCompleted = false;
  isIdle = false;
  scheduledUntilMs = 0;
  activeBackgroundTask = null;

  logLines.length = 0;
  scrollOffset = 0;
  totalPromptChars = 0;
  totalThinkingChars = 0;
  totalOutputChars = 0;

  process.stdout.write("\x1b[2J\x1b[H");
  printHeader(currentSession);
  startSpinner("Memuat riwayat sesi agy...");
}

function cleanupAndExit(code = 0) {
  stopSpinner();
  if (activeFileFd) {
    try {
      fs.closeSync(activeFileFd);
    } catch (e) {}
    activeFileFd = null;
  }
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h\n");
  console.log(C.green + "✔ agy-live monitor dihentikan." + C.reset);
  process.exit(code);
}

async function main() {
  const sessions = getAllSessions();
  if (sessions.length === 0) {
    console.error(
      C.red + "Tidak ditemukan sesi agy apapun di ~/.gemini/antigravity-cli/brain/" + C.reset,
    );
    process.exit(1);
  }

  cachedSessionsList = sessions;
  const arg = process.argv[2];
  let targetSession = null;

  if (arg && !arg.startsWith("-")) {
    targetSession = sessions.find((s) => s.id.startsWith(arg) || s.id === arg);
    if (!targetSession) {
      console.log(C.red + "⚠️  Tidak ditemukan sesi dengan ID/prefix: " + arg + C.reset + "\n");
    }
  }

  if (!targetSession) {
    const projectSession = findProjectSession(sessions);
    targetSession = projectSession || sessions[0];
  }

  currentSession = targetSession;

  // Enter alternate screen buffer & enable mouse reporting for wheel scroll
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  }

  printHeader(currentSession);
  startSpinner("Memuat riwayat sesi agy...");

  function poll() {
    if (isSelectingSession) return;
    try {
      if (!activeFileFd) {
        activeFileFd = fs.openSync(currentSession.path, "r");
      }
      const stat = fs.fstatSync(activeFileFd);
      if (stat.size < currentPos) {
        currentPos = 0;
        remainder = "";
        logLines.length = 0;
        scrollOffset = 0;
        totalPromptChars = 0;
        totalThinkingChars = 0;
        totalOutputChars = 0;
      }
      if (stat.size === currentPos) return;

      const bytesToRead = stat.size - currentPos;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(activeFileFd, buf, 0, bytesToRead, currentPos);
      currentPos = stat.size;

      const chunk = remainder + buf.toString("utf8");
      const lines = chunk.split("\n");
      remainder = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const step = JSON.parse(trimmed);
          renderStep(step);
        } catch (e) {}
      }
    } catch (err) {}
  }

  poll();
  setInterval(poll, 100);

  // Setup Keyboard & Mouse Wheel Navigation
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    process.stdin.on("data", (data) => {
      const str = data.toString("utf8");
      if (isSelectingSession) return;
      // Mouse wheel up: \x1b[<64;
      if (str.includes("<64;") || str.includes("[<64;")) {
        const vHeight = Math.max(1, (process.stdout.rows || 24) - 4);
        const maxScroll = Math.max(0, logLines.length - vHeight);
        scrollOffset = Math.min(maxScroll, scrollOffset + 3);
        scheduleRedraw();
        return;
      }
      // Mouse wheel down: \x1b[<65;
      if (str.includes("<65;") || str.includes("[<65;")) {
        scrollOffset = Math.max(0, scrollOffset - 3);
        scheduleRedraw();
        return;
      }
    });

    process.stdin.on("keypress", (str, key) => {
      if (key && key.ctrl && key.name === "c") {
        cleanupAndExit(0);
      }

      if (isSelectingSession) {
        if (key && (key.name === "escape" || (key.name === "s" && !key.ctrl))) {
          isSelectingSession = false;
          scheduleRedraw();
          startSpinner("Melanjutkan monitor sesi...");
          return;
        }

        const maxItems = getMaxDisplaySessions();

        if (key && key.name === "up") {
          selectCursorIdx = Math.max(0, selectCursorIdx - 1);
          drawSessionSelector();
          return;
        }

        if (key && key.name === "down") {
          selectCursorIdx = Math.min(maxItems - 1, selectCursorIdx + 1);
          drawSessionSelector();
          return;
        }

        if (key && (key.name === "return" || key.name === "enter")) {
          const chosen = cachedSessionsList[selectCursorIdx];
          if (chosen) switchSession(chosen);
          return;
        }

        // Numeric key 1-9
        const num = parseInt(str, 10);
        if (!isNaN(num) && num >= 1 && num <= maxItems) {
          const chosen = cachedSessionsList[num - 1];
          if (chosen) switchSession(chosen);
          return;
        }
      } else {
        const vHeight = Math.max(1, (process.stdout.rows || 24) - 4);
        const maxScroll = Math.max(0, logLines.length - vHeight);

        if (key && (key.name === "up" || str === "k")) {
          scrollOffset = Math.min(maxScroll, scrollOffset + 1);
          scheduleRedraw();
          return;
        }

        if (key && (key.name === "down" || str === "j")) {
          scrollOffset = Math.max(0, scrollOffset - 1);
          scheduleRedraw();
          return;
        }

        if (key && key.name === "pageup") {
          scrollOffset = Math.min(maxScroll, scrollOffset + vHeight);
          scheduleRedraw();
          return;
        }

        if (key && key.name === "pagedown") {
          scrollOffset = Math.max(0, scrollOffset - vHeight);
          scheduleRedraw();
          return;
        }

        if (key && (key.name === "home" || str === "g")) {
          scrollOffset = maxScroll;
          scheduleRedraw();
          return;
        }

        if (key && (key.name === "end" || str === "G")) {
          scrollOffset = 0;
          scheduleRedraw();
          return;
        }

        if (key && key.name === "s") {
          isSelectingSession = true;
          stopSpinner();
          cachedSessionsList = getAllSessions();
          selectCursorIdx = cachedSessionsList.findIndex((s) => s.id === currentSession.id);
          if (selectCursorIdx === -1) selectCursorIdx = 0;
          drawSessionSelector();
          return;
        }

        if (key && key.name === "c") {
          logLines.length = 0;
          scrollOffset = 0;
          totalPromptChars = 0;
          totalThinkingChars = 0;
          totalOutputChars = 0;
          scheduleRedraw();
          return;
        }

        if (key && key.name === "q") {
          cleanupAndExit(0);
        }
      }
    });
  }

  process.stdout.on("resize", () => {
    if (isSelectingSession) {
      drawSessionSelector();
    } else {
      scheduleRedraw();
    }
  });

  process.on("SIGINT", () => {
    cleanupAndExit(0);
  });
}

main();
