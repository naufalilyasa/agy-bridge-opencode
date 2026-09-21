import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_STALE_MS = 90_000;
const TAIL_BYTES = 64 * 1024; // 64 KiB bounded tail

export type DerivedSessionState = "running" | "idle-awaiting" | "idle-done" | "error" | "unknown";

export interface TranscriptStateResult {
  state: DerivedSessionState;
  ageSec: number;
  lastType?: string;
  lastStatus?: string;
  excerpt: string;
  unfinished: number;
  stepCount?: number;
}

export interface TranscriptStep {
  step_index?: number;
  type?: string;
  status?: string;
  content?: string;
  thinking?: string;
  created_at?: string;
  [key: string]: unknown;
}

const WAITING_TEXT_PATTERNS = [
  /waiting for/i,
  /waiting on/i,
  /running with (?:an? )?(?:active )?timer/i,
  /awaiting/i,
  /background task/i,
  /will notify|notify when/i,
  /will be notified/i,
];

export function matchesWaitingText(text: string): boolean {
  if (!text) return false;
  return WAITING_TEXT_PATTERNS.some((pat) => pat.test(text));
}

/**
 * Resolves transcript file path with the same preference as TUI:
 * prefer transcript_full.jsonl if present, else transcript.jsonl.
 */
export function resolveTranscriptPath(pathOrDir: string): string {
  if (!pathOrDir) return "";

  try {
    if (fs.existsSync(pathOrDir) && fs.statSync(pathOrDir).isDirectory()) {
      const full = path.join(pathOrDir, "transcript_full.jsonl");
      if (fs.existsSync(full)) return full;
      return path.join(pathOrDir, "transcript.jsonl");
    }
  } catch {}

  const dir = path.dirname(pathOrDir);
  const base = path.basename(pathOrDir);
  if (base.endsWith(".jsonl")) {
    const full = path.join(dir, "transcript_full.jsonl");
    if (fs.existsSync(full)) return full;
    if (fs.existsSync(pathOrDir)) return pathOrDir;
    const plain = path.join(dir, "transcript.jsonl");
    if (fs.existsSync(plain)) return plain;
    return pathOrDir;
  }

  // Treat as directory path that might not yet exist or doesn't end in .jsonl
  const full = path.join(pathOrDir, "transcript_full.jsonl");
  if (fs.existsSync(full)) return full;
  const plain = path.join(pathOrDir, "transcript.jsonl");
  if (fs.existsSync(plain)) return plain;
  return full;
}

function extractTaskId(text?: string): string | null {
  if (!text) return null;
  const m = text.match(
    /(?:task\s*id[:\s=]+\"?|Task:\s*\"?|Task\s+\"|sender=)([a-zA-Z0-9_\-\.\/]+)/i,
  );
  return m ? m[1] : null;
}

function isTerminalText(text?: string): boolean {
  if (!text) return false;
  return /was canceled|cancelled|canceled|completed with result|finished with result|exited with code|status:\s*(?:completed|terminated|killed|failed)/i.test(
    text,
  );
}

/**
 * Bounded read of transcript tail to derive real session state.
 * Never reads the whole file (maximum 64 KiB tail).
 */
export function deriveTranscriptState(
  transcriptPathOrDir: string,
  now: number = Date.now(),
): TranscriptStateResult {
  // If a bare session ID was passed, attempt to resolve via ~/.gemini/antigravity-cli/brain/<id>
  let target = transcriptPathOrDir;
  if (target && !target.includes(path.sep) && !fs.existsSync(target)) {
    const brainLog = path.join(
      os.homedir(),
      ".gemini",
      "antigravity-cli",
      "brain",
      target,
      ".system_generated",
      "logs",
    );
    if (fs.existsSync(brainLog)) {
      target = brainLog;
    }
  }

  const resolved = resolveTranscriptPath(target);
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      state: "unknown",
      ageSec: 0,
      excerpt: "",
      unfinished: 0,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return {
      state: "unknown",
      ageSec: 0,
      excerpt: "",
      unfinished: 0,
    };
  }

  const ageMs = now - stat.mtimeMs;
  const ageSec = Math.max(0, Math.floor(Math.max(0, ageMs) / 1000));
  const isFresh = ageMs >= -5000 && ageMs < DEFAULT_STALE_MS;

  if (stat.size === 0) {
    return {
      state: "unknown",
      ageSec,
      excerpt: "",
      unfinished: 0,
      stepCount: 0,
    };
  }

  let contentTail = "";
  const readLen = Math.min(stat.size, TAIL_BYTES);
  const position = Math.max(0, stat.size - readLen);

  try {
    const fd = fs.openSync(resolved, "r");
    try {
      const buffer = Buffer.alloc(readLen);
      fs.readSync(fd, buffer, 0, readLen, position);
      contentTail = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {
      state: "unknown",
      ageSec,
      excerpt: "",
      unfinished: 0,
    };
  }

  const rawLines = contentTail.split("\n");
  if (position > 0) {
    // Drop first partial line because tail started mid-file
    rawLines.shift();
  }

  const steps: TranscriptStep[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      steps.push(JSON.parse(trimmed));
    } catch {
      // ignore partial or malformed lines
    }
  }

  if (steps.length === 0) {
    return {
      state: "unknown",
      ageSec,
      excerpt: "",
      unfinished: 0,
    };
  }

  const lastStep = steps[steps.length - 1];
  const lastType = lastStep.type;
  const lastStatus = lastStep.status;
  const rawExcerpt = (lastStep.content || lastStep.thinking || "").trim();
  const excerpt = rawExcerpt.replace(/\s+/g, " ").slice(0, 160);

  let stepCount: number | undefined;
  if (typeof lastStep.step_index === "number") {
    stepCount = lastStep.step_index + 1;
  } else if (position === 0) {
    stepCount = steps.length;
  }

  // Scan steps present in the tail for any step whose status is RUNNING, PENDING, or ERROR
  // that has NO later step of a DONE/terminal kind completing it.
  let unfinished = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const st = s.status;
    if (st === "RUNNING" || st === "PENDING" || st === "ERROR") {
      const tid = extractTaskId(s.content);
      if (tid) {
        let completedLater = false;
        for (let j = i + 1; j < steps.length; j++) {
          const later = steps[j];
          const laterContent = later.content || "";
          const laterTid = extractTaskId(laterContent);
          if (laterTid === tid && (later.status === "DONE" || isTerminalText(laterContent))) {
            if (!/status:\s*running/i.test(laterContent)) {
              completedLater = true;
              break;
            }
          }
        }
        if (!completedLater) {
          unfinished++;
        }
      } else {
        // Without a task ID, check if this is the last step or if an error/running step was uncompleted
        unfinished++;
      }
    }
  }

  let state: DerivedSessionState;
  if (isFresh) {
    state = "running";
  } else if (lastStatus === "ERROR") {
    state = "error";
  } else if (
    (lastType === "PLANNER_RESPONSE" &&
      lastStatus === "DONE" &&
      matchesWaitingText(lastStep.content || "")) ||
    unfinished > 0
  ) {
    state = "idle-awaiting";
  } else if (lastStatus === "DONE" && unfinished === 0) {
    state = "idle-done";
  } else {
    state = "idle-done";
  }

  return {
    state,
    ageSec,
    lastType,
    lastStatus,
    excerpt,
    unfinished,
    stepCount,
  };
}
