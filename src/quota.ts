/**
 * Quota detection and cooldown tracking for agy model failover.
 *
 * agy never surfaces RESOURCE_EXHAUSTED to stdout/stderr in print mode — it
 * silently retries until --print-timeout, then exits 0 with empty output.
 * The only reliable signal is the 429 line in its log file, which includes
 * the exact reset time ("Resets in 96h53m25s").
 *
 * Only *capacity* signals are matched. Generic runtime errors ("Error ID:",
 * "Agent execution terminated due to error") are deliberately NOT treated as
 * quota: agy's glog runtime log is full of benign error-looking lines, and a
 * false positive kills a healthy run. Those lines are instead surfaced by the
 * post-run error path (server.ts isTerminatedOrError) as a follow_up recovery
 * instruction, not as a model failover trigger.
 */

export const DEFAULT_COOLDOWN_SEC = 15 * 60;

const QUOTA_RE =
  /(?:RESOURCE_EXHAUSTED \(code 429\)|experiencing high traffic|UNAVAILABLE \(code 503\)|model is overloaded|rate limit exceeded)/i;
const RESET_RE = /Resets in ((?:\d+h)?(?:\d+m)?(?:\d+s)?)\b/;

export interface QuotaInfo {
  resetText?: string;
  resetSeconds?: number;
}

export function parseResetDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  let out = "";
  if (h) out += `${h}h`;
  if (m) out += `${m}m`;
  if (sec || !out) out += `${sec}s`;
  return out;
}

export function detectQuota(log: string): QuotaInfo | null {
  if (!QUOTA_RE.test(log)) return null;
  const reset = RESET_RE.exec(log)?.[1];
  const resetSeconds = reset
    ? parseResetDuration(reset)
    : log.toLowerCase().includes("high traffic") ||
        log.toLowerCase().includes("overloaded") ||
        log.toLowerCase().includes("unavailable") ||
        log.toLowerCase().includes("terminated due to error") ||
        log.toLowerCase().includes("error id:")
      ? 60
      : undefined;
  const resetText = resetSeconds !== undefined ? reset || formatDuration(resetSeconds) : undefined;
  return { resetText, resetSeconds };
}

// A capacity error agy echoes as its ENTIRE output starts with the glog severity
// stamp ("E0613 ...") or the error token itself ("RESOURCE_EXHAUSTED ...",
// "UNAVAILABLE (code 503) ..."). A real answer that merely quotes one of those
// tokens in prose does NOT. Anchoring + a terse/single-line shape guard keep a
// legitimate (often quota-debugging) answer from being mistaken for exhaustion.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CAPACITY_ECHO_RE =
  /^(?:[EWIF]\d{4}\s|RESOURCE_EXHAUSTED\b|UNAVAILABLE\b|model is overloaded|experiencing high traffic|rate limit exceeded)/i;

export function detectQuotaEcho(text: string): QuotaInfo | null {
  const t = (text ?? "").replace(ANSI_RE, "").trim();
  if (!t || !CAPACITY_ECHO_RE.test(t)) return null;
  // Only a glog-stamped line or a short single-paragraph error is an echo; a
  // multi-paragraph answer that merely opens with one of these tokens is not.
  if (!/^([EWIF]\d{4}\s|Error ID:)/.test(t) && (t.includes("\n\n") || t.length > 240)) return null;
  return detectQuota(t);
}

// agy surfaces a genuine execution error ("Error ID:", "Agent execution
// terminated due to error") as its whole stdout. Anchored so a real answer that
// quotes one of these mid-prose is not flipped into a failure.
export function detectExecutionEcho(text: string): boolean {
  const t = (text ?? "").replace(ANSI_RE, "").trim();
  if (!/^(?:[EWIF]\d{4}\s)?(?:Error ID:|Agent execution terminated due to error)/i.test(t))
    return false;
  // Same terse guard as the capacity echo: a real answer that merely starts by
  // quoting "Error ID:" and then explains it in paragraphs is not a failure.
  if (!/^[EWIF]\d{4}\s/.test(t) && (t.includes("\n\n") || t.length > 240)) return false;
  return true;
}

export class QuotaError extends Error {
  readonly resetSeconds?: number;
  readonly resetText?: string;

  constructor(
    readonly model: string | undefined,
    info: QuotaInfo,
  ) {
    const who = model ?? "agy's default model";
    const when = info.resetText ? ` Resets in ${info.resetText}.` : "";
    super(`Quota or capacity limit for ${who} (RESOURCE_EXHAUSTED/TRAFFIC).${when}`);
    this.name = "QuotaError";
    this.resetSeconds = info.resetSeconds;
    this.resetText = info.resetText;
  }
}

export class CooldownRegistry {
  private until = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  clear(): void {
    this.until.clear();
  }

  set(model: string, resetSeconds: number | undefined): void {
    this.until.set(model, this.now() + (resetSeconds ?? DEFAULT_COOLDOWN_SEC) * 1000);
  }

  cooling(model: string): boolean {
    const t = this.until.get(model);
    return t !== undefined && t > this.now();
  }

  describe(model: string): string {
    const t = this.until.get(model);
    return formatDuration(t === undefined ? 0 : (t - this.now()) / 1000);
  }
}
