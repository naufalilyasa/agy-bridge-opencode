import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

export interface LockOptions {
  staleMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RunDirs {
  runDir: string;
  inboxesDir: string;
  tasksDir: string;
  transcriptDir: string;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    const json = `${JSON.stringify(data, null, 2)}\n`;
    const handle = await fsp.open(tmpPath, "wx");
    try {
      await handle.writeFile(json, "utf-8");
      try {
        await handle.sync();
      } catch {
        // Tolerant fsync: ignore if not supported by OS/filesystem
      }
    } finally {
      await handle.close();
    }
    await fsp.rename(tmpPath, file);
  } catch (err) {
    try {
      await fsp.rm(tmpPath, { force: true });
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export async function readJson<T = unknown>(file: string): Promise<T | null> {
  try {
    const content = await fsp.readFile(file, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function parseLockContent(content: string): { pid: number; ts: number } | null {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return null;

  let pidStr: string;
  let tsStr: string;

  if (lines.length === 2) {
    pidStr = lines[0];
    tsStr = lines[1];
  } else {
    // 3 or more lines (e.g. OMO ownerTag\npid\nts format)
    const firstNum = Number(lines[0]);
    if (Number.isInteger(firstNum) && firstNum > 0) {
      pidStr = lines[0];
      tsStr = lines[1];
    } else {
      pidStr = lines[1];
      tsStr = lines[2];
    }
  }

  const pid = Number.parseInt(pidStr, 10);
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(ts) || ts <= 0) return null;

  return { pid, ts };
}

export function isPidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return true;
    }
    if (code === "EPERM") {
      return false; // Process exists but lack permission
    }
    return true;
  }
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: number | LockOptions,
): Promise<T> {
  const opts = typeof options === "number" ? { staleMs: options } : (options ?? {});
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const startedAt = Date.now();
  let lockAcquired = false;

  while (!lockAcquired) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf-8");
        try {
          await handle.sync();
        } catch {
          // Tolerant fsync
        }
      } finally {
        await handle.close();
      }
      lockAcquired = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await fsp.mkdir(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") {
        throw err;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new TeamError(`Lock acquisition timed out after ${timeoutMs}ms: ${lockPath}`);
      }

      let stale = false;
      try {
        const stat = await fsp.stat(lockPath);
        const content = await fsp.readFile(lockPath, "utf-8");
        const parsed = parseLockContent(content);
        if (parsed) {
          const dead = isPidDead(parsed.pid);
          const age = Math.max(Date.now() - stat.mtimeMs, Date.now() - parsed.ts);
          if (dead && (age >= staleMs || staleMs === 0)) {
            stale = true;
          }
        }
      } catch {
        // File may have been removed or modified concurrently
      }

      if (stale) {
        try {
          await fsp.unlink(lockPath);
        } catch (unlinkErr: unknown) {
          const uCode = (unlinkErr as NodeJS.ErrnoException).code;
          if (uCode !== "ENOENT") {
            // Ignore other unlink errors
          }
        }
        continue;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new TeamError(`Lock acquisition timed out after ${timeoutMs}ms: ${lockPath}`);
      }

      const sleepTime = Math.min(pollIntervalMs, Math.max(1, timeoutMs - elapsed));
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await fsp.unlink(lockPath);
    } catch (err: unknown) {
      const uCode = (err as NodeJS.ErrnoException).code;
      if (uCode !== "ENOENT") {
        // Retry loop for retryable errors (EBUSY/EPERM)
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            await fsp.unlink(lockPath);
            break;
          } catch (retryErr: unknown) {
            if ((retryErr as NodeJS.ErrnoException).code === "ENOENT") break;
          }
        }
      }
    }
  }
}

export function runtimeRoot(projectRoot: string): string {
  return path.join(projectRoot, ".omo");
}

export function runDir(projectRoot: string, teamRunId: string): string {
  return path.join(projectRoot, ".omo", "runtime", teamRunId);
}

export async function ensureRunDirs(
  projectRoot: string,
  teamRunId: string,
  memberNames: string[] = [],
): Promise<RunDirs> {
  const run = runDir(projectRoot, teamRunId);
  const inboxesDir = path.join(run, "inboxes");
  const tasksDir = path.join(run, "tasks");
  const transcriptDir = path.join(run, "transcript");

  await fsp.mkdir(run, { recursive: true });
  await fsp.mkdir(inboxesDir, { recursive: true });
  await fsp.mkdir(tasksDir, { recursive: true });
  await fsp.mkdir(transcriptDir, { recursive: true });

  for (const member of memberNames) {
    await fsp.mkdir(path.join(inboxesDir, member), { recursive: true });
  }

  return {
    runDir: run,
    inboxesDir,
    tasksDir,
    transcriptDir,
  };
}

export function resolveReal(p: string): string {
  return fs.realpathSync(p);
}
