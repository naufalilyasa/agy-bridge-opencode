import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  deriveTranscriptState,
  resolveTranscriptPath,
  matchesWaitingText,
  DEFAULT_STALE_MS,
} from "../src/session-state.js";

describe("session-state derivation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-session-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("resolveTranscriptPath", () => {
    it("prefers transcript_full.jsonl when both exist in log directory", () => {
      const full = path.join(tmpDir, "transcript_full.jsonl");
      const plain = path.join(tmpDir, "transcript.jsonl");
      fs.writeFileSync(full, "");
      fs.writeFileSync(plain, "");

      expect(resolveTranscriptPath(tmpDir)).toBe(full);
      expect(resolveTranscriptPath(plain)).toBe(full);
    });

    it("falls back to transcript.jsonl when transcript_full.jsonl is absent", () => {
      const plain = path.join(tmpDir, "transcript.jsonl");
      fs.writeFileSync(plain, "");

      expect(resolveTranscriptPath(tmpDir)).toBe(plain);
      expect(resolveTranscriptPath(plain)).toBe(plain);
    });

    it("handles missing paths safely", () => {
      const nonExistent = path.join(tmpDir, "nonexistent");
      expect(resolveTranscriptPath(nonExistent)).toBe(
        path.join(nonExistent, "transcript_full.jsonl"),
      );
    });
  });

  describe("matchesWaitingText", () => {
    it("matches waiting-text patterns case-insensitively", () => {
      expect(matchesWaitingText("Waiting for completion notification.")).toBe(true);
      expect(matchesWaitingText("Visual QA running. Awaiting results and screenshot.")).toBe(true);
      expect(matchesWaitingText("Task is running with active timer.")).toBe(true);
      expect(matchesWaitingText("running with an active timer")).toBe(true);
      expect(matchesWaitingText("running with timer")).toBe(true);
      expect(matchesWaitingText("Tool running as background task")).toBe(true);
      expect(matchesWaitingText("I will notify when complete")).toBe(true);
      expect(matchesWaitingText("You will be notified once done")).toBe(true);
    });

    it("does not match non-waiting text", () => {
      expect(matchesWaitingText("All tests passed successfully.")).toBe(false);
      expect(matchesWaitingText("Created file src/index.ts")).toBe(false);
      expect(matchesWaitingText("")).toBe(false);
    });
  });

  describe("deriveTranscriptState: all states", () => {
    it("state 1: returns running when mtime is fresh (< 90s)", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step = {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Working on task...",
      };
      fs.writeFileSync(logFile, JSON.stringify(step) + "\n");

      const now = Date.now();
      // Set mtime to 10 seconds ago
      const tenSecAgo = (now - 10_000) / 1000;
      fs.utimesSync(logFile, tenSecAgo, tenSecAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("running");
      expect(res.ageSec).toBe(10);
      expect(res.lastType).toBe("PLANNER_RESPONSE");
      expect(res.lastStatus).toBe("DONE");
      expect(res.excerpt).toBe("Working on task...");
      expect(res.unfinished).toBe(0);
      expect(res.stepCount).toBe(1);
    });

    it("state 2: returns idle-awaiting via waiting-text when stale", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step = {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Task is running with active timer. Waiting for completion notification.",
      };
      fs.writeFileSync(logFile, JSON.stringify(step) + "\n");

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("idle-awaiting");
      expect(res.ageSec).toBe(120);
      expect(res.lastType).toBe("PLANNER_RESPONSE");
      expect(res.lastStatus).toBe("DONE");
      expect(res.excerpt).toContain("Waiting for completion");
    });

    it("state 3: returns idle-awaiting via unfinished RUNNING step when stale", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step1 = {
        step_index: 10,
        type: "GENERIC",
        status: "RUNNING",
        content: "Tool is running as a background task with task id: test-task-42",
      };
      const step2 = {
        step_index: 11,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "I have dispatched the task to the background. Here is the summary.",
      };
      fs.writeFileSync(logFile, JSON.stringify(step1) + "\n" + JSON.stringify(step2) + "\n");

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("idle-awaiting");
      expect(res.ageSec).toBe(120);
      expect(res.lastType).toBe("PLANNER_RESPONSE");
      expect(res.lastStatus).toBe("DONE");
      expect(res.unfinished).toBe(1);
    });

    it("correctly identifies completed background tasks and does not mark them unfinished", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step1 = {
        step_index: 1,
        type: "GENERIC",
        status: "RUNNING",
        content: "Tool is running as a background task with task id: test-task-100",
      };
      const step2 = {
        step_index: 2,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content: 'Task id "test-task-100" finished with result:\nexited with code 0',
      };
      const step3 = {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "All background work is completed successfully.",
      };
      fs.writeFileSync(
        logFile,
        [step1, step2, step3].map((s) => JSON.stringify(s)).join("\n") + "\n",
      );

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("idle-done");
      expect(res.unfinished).toBe(0);
    });

    it("state 4: returns error when last step is ERROR and stale", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step1 = {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Starting execution...",
      };
      const step2 = {
        step_index: 1,
        type: "GENERIC",
        status: "ERROR",
        content: "Encountered fatal error: process killed by SIGSEGV",
      };
      fs.writeFileSync(logFile, JSON.stringify(step1) + "\n" + JSON.stringify(step2) + "\n");

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("error");
      expect(res.lastType).toBe("GENERIC");
      expect(res.lastStatus).toBe("ERROR");
      expect(res.excerpt).toContain("fatal error");
    });

    it("state 5: returns idle-done when stale and last step is terminal with no unfinished work", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const step1 = {
        step_index: 0,
        type: "USER_INPUT",
        status: "DONE",
        content: "Explain the code",
      };
      const step2 = {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "The code is a web server implemented using Express.",
      };
      fs.writeFileSync(logFile, JSON.stringify(step1) + "\n" + JSON.stringify(step2) + "\n");

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("idle-done");
      expect(res.unfinished).toBe(0);
      expect(res.excerpt).toBe("The code is a web server implemented using Express.");
    });

    it("state 6: returns unknown for missing file", () => {
      const missing = path.join(tmpDir, "nonexistent-transcript.jsonl");
      const res = deriveTranscriptState(missing);
      expect(res.state).toBe("unknown");
      expect(res.ageSec).toBe(0);
      expect(res.excerpt).toBe("");
      expect(res.unfinished).toBe(0);
    });

    it("returns unknown for empty file", () => {
      const emptyFile = path.join(tmpDir, "empty.jsonl");
      fs.writeFileSync(emptyFile, "");
      const res = deriveTranscriptState(emptyFile);
      expect(res.state).toBe("unknown");
      expect(res.stepCount).toBe(0);
    });

    it("returns unknown for unparseable / corrupt file", () => {
      const corruptFile = path.join(tmpDir, "corrupt.jsonl");
      fs.writeFileSync(corruptFile, "not json at all\nalso not json\n");
      const res = deriveTranscriptState(corruptFile);
      expect(res.state).toBe("unknown");
    });
  });

  describe("bounded tail read and excerpt truncation", () => {
    it("reads only the tail of a file larger than 64 KiB", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const fd = fs.openSync(logFile, "w");

      // Write ~100 KiB of padding steps
      const fillerStep =
        JSON.stringify({
          step_index: 0,
          type: "GENERIC",
          status: "DONE",
          content: "x".repeat(500),
        }) + "\n";
      for (let i = 0; i < 200; i++) {
        fs.writeSync(fd, fillerStep);
      }

      // Final step at the tail
      const finalStep =
        JSON.stringify({
          step_index: 201,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Final completed answer in tail",
        }) + "\n";
      fs.writeSync(fd, finalStep);
      fs.closeSync(fd);

      const stat = fs.statSync(logFile);
      expect(stat.size).toBeGreaterThan(64 * 1024);

      const now = Date.now();
      const twoMinAgo = (now - 120_000) / 1000;
      fs.utimesSync(logFile, twoMinAgo, twoMinAgo);

      const res = deriveTranscriptState(logFile, now);
      expect(res.state).toBe("idle-done");
      expect(res.lastType).toBe("PLANNER_RESPONSE");
      expect(res.lastStatus).toBe("DONE");
      expect(res.excerpt).toBe("Final completed answer in tail");
      expect(res.stepCount).toBe(202);
    });

    it("caps excerpt at 160 characters and collapses newlines/whitespace", () => {
      const logFile = path.join(tmpDir, "transcript.jsonl");
      const longText = "Word ".repeat(50); // 250 chars
      const step = {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Line 1\n\n   Line 2\n" + longText,
      };
      fs.writeFileSync(logFile, JSON.stringify(step) + "\n");

      const res = deriveTranscriptState(logFile);
      expect(res.excerpt.length).toBeLessThanOrEqual(160);
      expect(res.excerpt).not.toContain("\n");
    });
  });
});
