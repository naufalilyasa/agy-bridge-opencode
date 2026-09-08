import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  atomicWriteJson,
  readJson,
  withLock,
  runtimeRoot,
  runDir,
  ensureRunDirs,
  resolveReal,
  TeamError,
} from "../src/team/store.js";

describe("src/team/store fs primitives", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-store-test-${randomUUID()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("atomicWriteJson", () => {
    it("writes data atomically and leaves no tmp residue", async () => {
      const targetFile = path.join(testDir, "state.json");
      const payload = { teamId: "t-1", count: 42, active: true };

      await atomicWriteJson(targetFile, payload);

      const content = await fs.readFile(targetFile, "utf-8");
      expect(JSON.parse(content)).toEqual(payload);

      const files = await fs.readdir(testDir);
      expect(files).toEqual(["state.json"]);
    });

    it("creates nested parent directories if they do not exist", async () => {
      const nestedFile = path.join(testDir, "a", "b", "c", "task.json");
      const payload = { id: "task-1" };

      await atomicWriteJson(nestedFile, payload);

      const read = await readJson(nestedFile);
      expect(read).toEqual(payload);
    });

    it("overwrites existing file cleanly with no residue", async () => {
      const targetFile = path.join(testDir, "override.json");
      await atomicWriteJson(targetFile, { version: 1 });
      await atomicWriteJson(targetFile, { version: 2 });

      const read = await readJson(targetFile);
      expect(read).toEqual({ version: 2 });

      const files = await fs.readdir(testDir);
      expect(files).toEqual(["override.json"]);
    });
  });

  describe("readJson", () => {
    it("returns null on ENOENT for missing file", async () => {
      const missing = path.join(testDir, "does-not-exist.json");
      const result = await readJson(missing);
      expect(result).toBeNull();
    });

    it("returns parsed JSON object for valid JSON file", async () => {
      const targetFile = path.join(testDir, "valid.json");
      await fs.writeFile(targetFile, JSON.stringify({ key: "val" }), "utf-8");

      const result = await readJson<{ key: string }>(targetFile);
      expect(result).toEqual({ key: "val" });
    });

    it("throws SyntaxError on malformed JSON", async () => {
      const targetFile = path.join(testDir, "bad.json");
      await fs.writeFile(targetFile, "{ bad json", "utf-8");

      await expect(readJson(targetFile)).rejects.toThrow(SyntaxError);
    });
  });

  describe("withLock", () => {
    it("serializes concurrent critical sections (counter increment)", async () => {
      const lockPath = path.join(testDir, "counter.lock");
      const dataFile = path.join(testDir, "counter.json");
      await atomicWriteJson(dataFile, { count: 0 });

      const increment = async () => {
        await withLock(lockPath, async () => {
          const current = (await readJson<{ count: number }>(dataFile))?.count ?? 0;
          await new Promise((resolve) => setTimeout(resolve, 60));
          await atomicWriteJson(dataFile, { count: current + 1 });
        });
      };

      await Promise.all([increment(), increment()]);

      const finalData = await readJson<{ count: number }>(dataFile);
      expect(finalData?.count).toBe(2);

      // Lock should be released
      expect(existsSync(lockPath)).toBe(false);
    });

    it("reaps dead-PID lock file (content '999999\\n<now>') immediately when staleMs is 0", async () => {
      const deadPid = 999999;
      try {
        process.kill(deadPid, 0);
      } catch (err: any) {
        expect(err?.code).toBe("ESRCH");
      }

      const lockPath = path.join(testDir, "dead.lock");
      await fs.writeFile(lockPath, `${deadPid}\n${Date.now()}\n`, "utf-8");

      let executed = false;
      await withLock(
        lockPath,
        async () => {
          executed = true;
        },
        0,
      );

      expect(executed).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("reaps dead-PID lock file with default staleMs when lock is older than 30s", async () => {
      const deadPid = 999999;
      try {
        process.kill(deadPid, 0);
      } catch (err: any) {
        expect(err?.code).toBe("ESRCH");
      }

      const lockPath = path.join(testDir, "dead-stale.lock");
      const past = Date.now() - 35000;
      await fs.writeFile(lockPath, `${deadPid}\n${past}\n`, "utf-8");
      const pastDate = new Date(past);
      await fs.utimes(lockPath, pastDate, pastDate);

      let executed = false;
      await withLock(lockPath, async () => {
        executed = true;
      });

      expect(executed).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("times out with TeamError if live PID holds lock, and succeeds after release", async () => {
      const lockPath = path.join(testDir, "live.lock");
      let secondError: unknown = null;
      let thirdRan = false;

      await withLock(lockPath, async () => {
        // While first withLock holds the lock, second attempts with short timeout
        try {
          await withLock(
            lockPath,
            async () => {
              // Should not enter
            },
            { timeoutMs: 150, pollIntervalMs: 25 },
          );
        } catch (err) {
          secondError = err;
        }

        expect(secondError).toBeInstanceOf(TeamError);
        expect((secondError as TeamError).message).toContain(lockPath);
      });

      // Third succeeds after first releases
      await withLock(lockPath, async () => {
        thirdRan = true;
      });

      expect(thirdRan).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("does not reap live-PID lock older than staleMs", async () => {
      const lockPath = path.join(testDir, "live-old.lock");
      const past = Date.now() - 35000;
      await fs.writeFile(lockPath, `${process.pid}\n${past}\n`, "utf-8");
      const pastDate = new Date(past);
      await fs.utimes(lockPath, pastDate, pastDate);

      // Calling withLock with staleMs=0 but owner PID is alive -> must NOT reap!
      await expect(
        withLock(
          lockPath,
          async () => {},
          { staleMs: 0, timeoutMs: 120, pollIntervalMs: 25 },
        ),
      ).rejects.toThrow(TeamError);

      expect(existsSync(lockPath)).toBe(true);
    });

    it("releases lock in finally even if fn throws", async () => {
      const lockPath = path.join(testDir, "throw.lock");

      await expect(
        withLock(lockPath, async () => {
          throw new Error("unhandled error inside lock");
        }),
      ).rejects.toThrow("unhandled error inside lock");

      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("path helpers", () => {
    it("runtimeRoot returns <root>/.omo", () => {
      expect(runtimeRoot("/path/to/project")).toBe(path.join("/path/to/project", ".omo"));
    });

    it("runDir returns <root>/.omo/runtime/<teamRunId>", () => {
      expect(runDir("/path/to/project", "run-456")).toBe(
        path.join("/path/to/project", ".omo", "runtime", "run-456"),
      );
    });

    it("ensureRunDirs creates runtime directory layout with member inboxes", async () => {
      const dirs = await ensureRunDirs(testDir, "run-xyz", ["lead", "worker1", "worker2"]);

      expect(dirs.runDir).toBe(path.join(testDir, ".omo", "runtime", "run-xyz"));
      expect(dirs.inboxesDir).toBe(path.join(dirs.runDir, "inboxes"));
      expect(dirs.tasksDir).toBe(path.join(dirs.runDir, "tasks"));
      expect(dirs.transcriptDir).toBe(path.join(dirs.runDir, "transcript"));

      expect(existsSync(dirs.runDir)).toBe(true);
      expect(existsSync(dirs.inboxesDir)).toBe(true);
      expect(existsSync(dirs.tasksDir)).toBe(true);
      expect(existsSync(dirs.transcriptDir)).toBe(true);

      expect(existsSync(path.join(dirs.inboxesDir, "lead"))).toBe(true);
      expect(existsSync(path.join(dirs.inboxesDir, "worker1"))).toBe(true);
      expect(existsSync(path.join(dirs.inboxesDir, "worker2"))).toBe(true);
    });

    it("resolveReal returns fs.realpathSync of the path as a pure function", () => {
      const real = resolveReal(testDir);
      expect(real).toBe(realpathSync(testDir));
    });
  });
});
