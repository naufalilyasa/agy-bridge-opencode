import { randomUUID } from "node:crypto";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { TeamError, atomicWriteJson, readJson, withLock } from "./store.js";

export { TeamError };

export const MAX_PAYLOAD_BYTES = 32_768; // 32 KB
export const MAX_RECIPIENT_UNREAD_BYTES = 262_144; // 256 KB

export class PayloadTooLargeError extends TeamError {
  readonly code = "PAYLOAD_TOO_LARGE";

  constructor(message = "Payload exceeds maximum allowed size of 32 KB (32768 bytes)") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

export class RecipientBackpressureError extends TeamError {
  readonly code = "RECIPIENT_BACKPRESSURE";

  constructor(message = "Recipient inbox unread backpressure exceeds 256 KB (262144 bytes)") {
    super(message);
    this.name = "RecipientBackpressureError";
  }
}

export interface Message<T = unknown> {
  id: string;
  from: string;
  to: string;
  body: T;
  ts: number;
  [key: string]: unknown;
}

export interface SendMessageInput<T = unknown> {
  from: string;
  to: string | string[];
  body: T;
  id?: string;
  ts?: number;
  memberNames?: string[];
  [key: string]: unknown;
}

export interface SendMessageResult<T = unknown> {
  id: string;
  from: string;
  to: string | string[];
  body: T;
  ts: number;
  deliveredTo: string[];
}

export interface SendMessageOptions {
  maxPayloadBytes?: number;
  maxRecipientUnreadBytes?: number;
}

export function getPayloadSize(body: unknown): number {
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf-8");
  }
  return Buffer.byteLength(JSON.stringify(body ?? null), "utf-8");
}

export async function getInboxUnreadBytes(inboxDir: string): Promise<number> {
  try {
    const entries = await fsp.readdir(inboxDir, { withFileTypes: true });
    let totalBytes = 0;
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith(".") &&
        !entry.name.includes(".tmp.")
      ) {
        try {
          const stats = await fsp.stat(path.join(inboxDir, entry.name));
          totalBytes += stats.size;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
      }
    }
    return totalBytes;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

function resolveMailboxArgs(
  runDirOrProjectRoot: string,
  memberOrTeamRunId: string,
  maybeMember?: string,
): { runDir: string; memberName: string } {
  if (typeof maybeMember === "string") {
    // Calling convention: (projectRoot, teamRunId, memberName)
    const runDir = path.join(runDirOrProjectRoot, ".omo", "runtime", memberOrTeamRunId);
    return { runDir, memberName: maybeMember };
  }
  // Calling convention: (runDir, memberName)
  return { runDir: runDirOrProjectRoot, memberName: memberOrTeamRunId };
}

export async function sendMessage<T = unknown>(
  runDirOrProjectRoot: string,
  messageOrTeamRunId: SendMessageInput<T> | string,
  fromOrMemberNames?: string | string[] | SendMessageOptions,
  to?: string | string[],
  body?: T,
  memberNames?: string[],
  options?: SendMessageOptions,
): Promise<SendMessageResult<T>> {
  let runDir: string;
  let input: SendMessageInput<T>;
  let resolvedMemberNames: string[] | undefined;
  let opts: SendMessageOptions | undefined;

  if (typeof messageOrTeamRunId === "string") {
    // Calling convention: sendMessage(projectRoot, teamRunId, from, to, body, memberNames?, options?)
    runDir = path.join(runDirOrProjectRoot, ".omo", "runtime", messageOrTeamRunId);
    input = {
      from: typeof fromOrMemberNames === "string" ? fromOrMemberNames : "",
      to: to as string | string[],
      body: body as T,
    };
    resolvedMemberNames = memberNames;
    opts = options;
  } else {
    // Calling convention: sendMessage(runDir, { from, to, body }, memberNames?, options?)
    runDir = runDirOrProjectRoot;
    input = messageOrTeamRunId;
    if (Array.isArray(fromOrMemberNames)) {
      resolvedMemberNames = fromOrMemberNames;
      opts = typeof to === "object" ? (to as unknown as SendMessageOptions) : undefined;
    } else if (typeof fromOrMemberNames === "object" && fromOrMemberNames !== null) {
      opts = fromOrMemberNames as SendMessageOptions;
    }
    if (input.memberNames && !resolvedMemberNames) {
      resolvedMemberNames = input.memberNames;
    }
  }

  const maxPayload = opts?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  const maxUnread = opts?.maxRecipientUnreadBytes ?? MAX_RECIPIENT_UNREAD_BYTES;

  const payloadSize = getPayloadSize(input.body);
  if (payloadSize > maxPayload) {
    throw new PayloadTooLargeError(
      `Payload size ${payloadSize} bytes exceeds maximum allowed limit of ${maxPayload} bytes`,
    );
  }

  let recipients: string[];
  if (input.to === "*") {
    if (!resolvedMemberNames || resolvedMemberNames.length === 0) {
      throw new TeamError(
        "Broadcast message (to='*') requires non-empty memberNames list",
      );
    }
    recipients = [...new Set(resolvedMemberNames)];
  } else if (Array.isArray(input.to)) {
    if (input.to.length === 0) {
      throw new TeamError("Recipient list cannot be empty");
    }
    recipients = [...new Set(input.to)];
  } else {
    if (!input.to || typeof input.to !== "string" || input.to.trim().length === 0) {
      throw new TeamError("Recipient 'to' must be a non-empty string");
    }
    recipients = [input.to];
  }

  const id = input.id ?? randomUUID();
  const ts = input.ts ?? Date.now();

  // Validate backpressure for all recipients before writing any messages
  for (const recipient of recipients) {
    const inboxDir = path.join(runDir, "inboxes", recipient);
    const currentUnread = await getInboxUnreadBytes(inboxDir);
    const recipientTo = typeof input.to === "string" ? input.to : recipient;
    const testRecord: Message<T> = {
      ...input,
      id,
      from: input.from,
      to: recipientTo,
      body: input.body,
      ts,
    };
    delete (testRecord as { memberNames?: unknown }).memberNames;

    const serializedBytes = Buffer.byteLength(`${JSON.stringify(testRecord, null, 2)}\n`, "utf-8");
    if (
      currentUnread + serializedBytes > maxUnread ||
      currentUnread + payloadSize > maxUnread
    ) {
      throw new RecipientBackpressureError(
        `Recipient "${recipient}" inbox unread backpressure exceeds limit of ${maxUnread} bytes (current: ${currentUnread}, additional: ${serializedBytes})`,
      );
    }
  }

  const deliveredTo: string[] = [];
  for (const recipient of recipients) {
    const inboxDir = path.join(runDir, "inboxes", recipient);
    await fsp.mkdir(inboxDir, { recursive: true });
    const lockPath = path.join(runDir, "inboxes", `${recipient}.lock`);

    await withLock(lockPath, async () => {
      const currentUnread = await getInboxUnreadBytes(inboxDir);
      const recipientTo = typeof input.to === "string" ? input.to : recipient;
      const messageRecord: Message<T> = {
        ...input,
        id,
        from: input.from,
        to: recipientTo,
        body: input.body,
        ts,
      };
      delete (messageRecord as { memberNames?: unknown }).memberNames;

      const serializedBytes = Buffer.byteLength(
        `${JSON.stringify(messageRecord, null, 2)}\n`,
        "utf-8",
      );
      if (
        currentUnread + serializedBytes > maxUnread ||
        currentUnread + payloadSize > maxUnread
      ) {
        throw new RecipientBackpressureError(
          `Recipient "${recipient}" inbox unread backpressure exceeds limit of ${maxUnread} bytes`,
        );
      }

      const fileName = `${ts}-${id}.json`;
      const filePath = path.join(inboxDir, fileName);
      await atomicWriteJson(filePath, messageRecord);
      deliveredTo.push(recipient);
    });
  }

  return {
    id,
    from: input.from,
    to: input.to,
    body: input.body,
    ts,
    deliveredTo,
  };
}

export async function drainInbox<T = unknown>(
  runDirOrProjectRoot: string,
  memberOrTeamRunId: string,
  maybeMember?: string,
): Promise<Message<T>[]> {
  const { runDir, memberName } = resolveMailboxArgs(
    runDirOrProjectRoot,
    memberOrTeamRunId,
    maybeMember,
  );
  const inboxDir = path.join(runDir, "inboxes", memberName);

  try {
    await fsp.access(inboxDir);
  } catch {
    return [];
  }

  const lockPath = path.join(runDir, "inboxes", `${memberName}.lock`);

  return await withLock(lockPath, async () => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(inboxDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const messageFiles = entries.filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith(".") &&
        !entry.name.includes(".tmp."),
    );

    if (messageFiles.length === 0) {
      return [];
    }

    const parsedItems: { path: string; message: Message<T> }[] = [];
    for (const entry of messageFiles) {
      const filePath = path.join(inboxDir, entry.name);
      try {
        const msg = await readJson<Message<T>>(filePath);
        if (msg && typeof msg === "object" && "id" in msg) {
          parsedItems.push({ path: filePath, message: msg });
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }

    // Sort oldest-first by ts, then by id
    parsedItems.sort((a, b) => {
      if (a.message.ts !== b.message.ts) {
        return a.message.ts - b.message.ts;
      }
      return a.message.id.localeCompare(b.message.id);
    });

    // Unlink each file (best-effort ENOENT-safe)
    for (const item of parsedItems) {
      try {
        await fsp.unlink(item.path);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // ignore best-effort unlink errors
        }
      }
    }

    return parsedItems.map((item) => item.message);
  });
}

export async function clearInbox(
  runDirOrProjectRoot: string,
  memberOrTeamRunId: string,
  maybeMember?: string,
): Promise<number> {
  const { runDir, memberName } = resolveMailboxArgs(
    runDirOrProjectRoot,
    memberOrTeamRunId,
    maybeMember,
  );
  const inboxDir = path.join(runDir, "inboxes", memberName);

  try {
    await fsp.access(inboxDir);
  } catch {
    return 0;
  }

  const lockPath = path.join(runDir, "inboxes", `${memberName}.lock`);

  return await withLock(lockPath, async () => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(inboxDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw err;
    }

    let clearedCount = 0;
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        !entry.name.startsWith(".") &&
        !entry.name.includes(".tmp.")
      ) {
        const filePath = path.join(inboxDir, entry.name);
        try {
          await fsp.unlink(filePath);
          clearedCount++;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
      }
    }
    return clearedCount;
  });
}
