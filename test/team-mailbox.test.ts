import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  sendMessage,
  drainInbox,
  clearInbox,
  getInboxUnreadBytes,
  PayloadTooLargeError,
  RecipientBackpressureError,
  MAX_PAYLOAD_BYTES,
  MAX_RECIPIENT_UNREAD_BYTES,
  TeamError,
} from "../src/team/mailbox.js";
import { atomicWriteJson } from "../src/team/store.js";

describe("src/team/mailbox", () => {
  let testDir: string;
  let runDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `team-mailbox-test-${randomUUID()}`);
    runDir = path.join(testDir, ".omo", "runtime", "run-1");
    await fs.mkdir(runDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("sendMessage - single recipient", () => {
    it("delivers a message to a single recipient inbox", async () => {
      const result = await sendMessage(runDir, {
        from: "lead",
        to: "worker-1",
        body: { task: "inspect", file: "main.ts" },
      });

      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.from).toBe("lead");
      expect(result.to).toBe("worker-1");
      expect(result.body).toEqual({ task: "inspect", file: "main.ts" });
      expect(result.deliveredTo).toEqual(["worker-1"]);
      expect(typeof result.ts).toBe("number");

      // Verify file written to inboxes/worker-1/<ts>-<uuid>.json
      const inboxDir = path.join(runDir, "inboxes", "worker-1");
      const files = await fs.readdir(inboxDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(new RegExp(`^${result.ts}-${result.id}\\.json$`));

      const content = JSON.parse(await fs.readFile(path.join(inboxDir, files[0]), "utf-8"));
      expect(content).toEqual({
        id: result.id,
        from: "lead",
        to: "worker-1",
        body: { task: "inspect", file: "main.ts" },
        ts: result.ts,
      });
    });
  });

  describe("sendMessage - multiple recipients", () => {
    it("delivers to multiple recipients when to is an array", async () => {
      const result = await sendMessage(runDir, {
        from: "lead",
        to: ["worker-1", "worker-2"],
        body: "sync update",
      });

      expect(result.deliveredTo).toEqual(["worker-1", "worker-2"]);

      for (const member of ["worker-1", "worker-2"]) {
        const inboxDir = path.join(runDir, "inboxes", member);
        const files = await fs.readdir(inboxDir);
        expect(files).toHaveLength(1);
        const msg = JSON.parse(await fs.readFile(path.join(inboxDir, files[0]), "utf-8"));
        expect(msg.from).toBe("lead");
        expect(msg.body).toBe("sync update");
      }
    });
  });

  describe("sendMessage - broadcast (to='*')", () => {
    it("writes one message file per member in memberNames param", async () => {
      const members = ["lead", "worker-1", "worker-2"];
      const result = await sendMessage(
        runDir,
        {
          from: "lead",
          to: "*",
          body: "all hands announcement",
        },
        members,
      );

      expect(result.deliveredTo).toEqual(members);

      for (const member of members) {
        const inboxDir = path.join(runDir, "inboxes", member);
        const files = await fs.readdir(inboxDir);
        expect(files).toHaveLength(1);
        const msg = JSON.parse(await fs.readFile(path.join(inboxDir, files[0]), "utf-8"));
        expect(msg.id).toBe(result.id);
        expect(msg.from).toBe("lead");
        expect(msg.to).toBe("*");
        expect(msg.body).toBe("all hands announcement");
      }
    });

    it("throws TeamError if memberNames is missing or empty for broadcast", async () => {
      await expect(
        sendMessage(runDir, { from: "lead", to: "*", body: "hello" }, []),
      ).rejects.toThrow(TeamError);

      await expect(
        sendMessage(runDir, { from: "lead", to: "*", body: "hello" }),
      ).rejects.toThrow(TeamError);
    });
  });

  describe("payload cap boundary (32768 bytes)", () => {
    it("succeeds when body is exactly 32768 bytes", async () => {
      const body32k = "a".repeat(MAX_PAYLOAD_BYTES);
      const result = await sendMessage(runDir, {
        from: "worker-1",
        to: "lead",
        body: body32k,
      });

      expect(result.deliveredTo).toEqual(["lead"]);
    });

    it("throws PayloadTooLargeError when body exceeds 32768 bytes by 1", async () => {
      const bodyTooLarge = "a".repeat(MAX_PAYLOAD_BYTES + 1);

      await expect(
        sendMessage(runDir, {
          from: "worker-1",
          to: "lead",
          body: bodyTooLarge,
        }),
      ).rejects.toThrow(PayloadTooLargeError);

      try {
        await sendMessage(runDir, {
          from: "worker-1",
          to: "lead",
          body: bodyTooLarge,
        });
        expect.unreachable("should have thrown PayloadTooLargeError");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(TeamError);
        expect(err).toBeInstanceOf(PayloadTooLargeError);
        expect((err as PayloadTooLargeError).code).toBe("PAYLOAD_TOO_LARGE");
        expect((err as Error).name).toBe("PayloadTooLargeError");
      }
    });
  });

  describe("recipient backpressure cap boundary (262144 bytes)", () => {
    it("throws RecipientBackpressureError when 2 messages total > 262144 bytes", async () => {
      const recipient = "worker-1";
      const inboxDir = path.join(runDir, "inboxes", recipient);
      await fs.mkdir(inboxDir, { recursive: true });

      // Pre-seed an existing message in the inbox totaling 250,000 bytes
      const preseededPath = path.join(inboxDir, "existing-msg.json");
      const largeContent = "x".repeat(249_000);
      await atomicWriteJson(preseededPath, {
        id: "pre-seed",
        from: "lead",
        to: recipient,
        body: largeContent,
        ts: Date.now() - 10_000,
      });

      const currentUnread = await getInboxUnreadBytes(inboxDir);
      expect(currentUnread).toBeGreaterThan(249_000);

      // Sending a second message of 20,000 bytes (within 32KB payload cap)
      // but totaling > 262144 bytes with existing unread
      const secondMsgBody = "y".repeat(20_000);
      expect(currentUnread + secondMsgBody.length).toBeGreaterThan(MAX_RECIPIENT_UNREAD_BYTES);

      await expect(
        sendMessage(runDir, {
          from: "lead",
          to: recipient,
          body: secondMsgBody,
        }),
      ).rejects.toThrow(RecipientBackpressureError);

      try {
        await sendMessage(runDir, {
          from: "lead",
          to: recipient,
          body: secondMsgBody,
        });
        expect.unreachable("should have thrown RecipientBackpressureError");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(TeamError);
        expect(err).toBeInstanceOf(RecipientBackpressureError);
        expect((err as RecipientBackpressureError).code).toBe("RECIPIENT_BACKPRESSURE");
        expect((err as Error).name).toBe("RecipientBackpressureError");
      }

      // Verify second message was not written
      const files = await fs.readdir(inboxDir);
      expect(files).toEqual(["existing-msg.json"]);
    });
  });

  describe("drainInbox", () => {
    it("returns queued messages oldest-first and empties the inbox", async () => {
      const recipient = "worker-1";
      const baseTs = 1_700_000_000_000;

      await sendMessage(runDir, {
        from: "lead",
        to: recipient,
        body: "msg-second",
        ts: baseTs + 2000,
      });

      await sendMessage(runDir, {
        from: "lead",
        to: recipient,
        body: "msg-first",
        ts: baseTs + 1000,
      });

      await sendMessage(runDir, {
        from: "lead",
        to: recipient,
        body: "msg-third",
        ts: baseTs + 3000,
      });

      const messages = await drainInbox(runDir, recipient);
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.body)).toEqual(["msg-first", "msg-second", "msg-third"]);
      expect(messages[0].ts).toBe(baseTs + 1000);
      expect(messages[1].ts).toBe(baseTs + 2000);
      expect(messages[2].ts).toBe(baseTs + 3000);

      // Verify inbox is now empty
      const inboxDir = path.join(runDir, "inboxes", recipient);
      const remainingFiles = await fs.readdir(inboxDir);
      expect(remainingFiles.filter((f) => f.endsWith(".json"))).toHaveLength(0);

      // Second drain returns empty array
      const secondDrain = await drainInbox(runDir, recipient);
      expect(secondDrain).toEqual([]);
    });

    it("returns empty array for non-existent inbox", async () => {
      const result = await drainInbox(runDir, "non-existent-member");
      expect(result).toEqual([]);
    });
  });

  describe("clearInbox", () => {
    it("empties the inbox completely", async () => {
      const recipient = "worker-1";
      await sendMessage(runDir, { from: "lead", to: recipient, body: "msg-1" });
      await sendMessage(runDir, { from: "lead", to: recipient, body: "msg-2" });

      const count = await clearInbox(runDir, recipient);
      expect(count).toBe(2);

      const drained = await drainInbox(runDir, recipient);
      expect(drained).toEqual([]);
    });

    it("returns 0 for non-existent inbox without error", async () => {
      const count = await clearInbox(runDir, "unknown-member");
      expect(count).toBe(0);
    });
  });

  describe("filename uniqueness under rapid sends", () => {
    it("ensures distinct filenames and delivery when sends have identical timestamps", async () => {
      const recipient = "worker-1";
      const fixedTs = 1_700_000_050_000;

      // 10 concurrent sends sharing the exact same ts
      const sends = Array.from({ length: 10 }, (_, i) =>
        sendMessage(runDir, {
          from: "lead",
          to: recipient,
          body: `rapid-${i}`,
          ts: fixedTs,
        }),
      );

      const results = await Promise.all(sends);
      const ids = results.map((r) => r.id);
      expect(new Set(ids).size).toBe(10);

      const inboxDir = path.join(runDir, "inboxes", recipient);
      const files = await fs.readdir(inboxDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      expect(jsonFiles).toHaveLength(10);

      // All filenames should share fixedTs prefix but distinct UUID suffix
      for (const f of jsonFiles) {
        expect(f.startsWith(`${fixedTs}-`)).toBe(true);
      }

      const drained = await drainInbox(runDir, recipient);
      expect(drained).toHaveLength(10);
      const drainedBodies = drained.map((m) => m.body);
      expect(drainedBodies).toHaveLength(10);
    });
  });

  describe("dual signature support (projectRoot, teamRunId)", () => {
    it("supports (projectRoot, teamRunId) signature matching plan todo 5", async () => {
      const teamRunId = "run-parity";
      const projectRoot = testDir;

      const sendRes = await sendMessage(projectRoot, teamRunId, "lead", "worker-1", "dual sig body");
      expect(sendRes.deliveredTo).toEqual(["worker-1"]);

      const drained = await drainInbox(projectRoot, teamRunId, "worker-1");
      expect(drained).toHaveLength(1);
      expect(drained[0].body).toBe("dual sig body");

      await sendMessage(projectRoot, teamRunId, "lead", "worker-1", "msg to clear");
      const cleared = await clearInbox(projectRoot, teamRunId, "worker-1");
      expect(cleared).toBe(1);
    });
  });
});
