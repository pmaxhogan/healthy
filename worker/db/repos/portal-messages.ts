/**
 * `portal_messages` and `portal_message_sync`: the portal pass's copy of every
 * secure message it read, and how the last read went.
 *
 * The MCP (`worker/mcp/message-items.ts`) reads both back: the messages to
 * answer from, the sync row to say whether they are current.
 *
 * ### Keys come from content
 *
 * The portal's own ids are per-session tokens, with no evidence they survive a new
 * sign-in, so nothing is keyed on them. A message is identified by a digest of
 * what it *is* -- its delivery instant, its author's role and its text -- and a
 * thread by its subject and first message. Those digests are plain SHA-256, and
 * live only inside the sealed payload; what is stored in the clear is a keyed
 * blind of them with the health system id (`message_key`, `thread_key`), so a
 * snapshot can neither read nor confirm them. The message digest is also what lets
 * the MCP recognise one message listed by two organisations' portals: see
 * `worker/sync/message-dedupe.ts`.
 *
 * The ids the MCP hands out (`threadId`, `messageId`) are keyed blinds too, of
 * the same digests *without* the health system: stable across runs and across
 * portals, so one conversation has one id however it was read.
 *
 * ### Never deleted, only flagged
 *
 * A message is part of the record, so rows are kept until the health system is
 * deleted. A message the portal's own organisation stops listing in a complete
 * read is marked `missing`. One from another organisation linked to the chart
 * never is: a capture showed such an organisation drop out of the Message Center
 * for a while, with no error anywhere, and its messages come back with it.
 */

import { blinderFor } from "../blind.ts";
import { BATCH_CHUNK, all, batch, chunk, run, sha256Hex } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { PortalMessage, PortalThread } from "../../ehr/mychart/index.ts";
import type { Blinder } from "../blind.ts";
import type { Ctx } from "../client.ts";
import type { PortalMessageRow, PortalMessageSyncRow } from "../rows.ts";

/** A thread's details as stored beside each of its messages. */
type StoredThreadInfo = Omit<PortalThread, "messages">;

/** What one row's payload holds. */
interface MessagePayload {
  /** SHA-256 of the thread's subject and first message. */
  threadFingerprint: string;
  /** SHA-256 of the message's instant, author role and text. */
  fingerprint: string;
  thread: StoredThreadInfo;
  message: PortalMessage;
}

/** A stored message, opened. */
export interface StoredPortalMessage {
  healthSystemId: string;
  /** Stable across runs and portals; see the module comment. */
  threadId: string;
  messageId: string;
  /** The message's content digest: what two portals' copies are matched on. */
  fingerprint: string;
  thread: StoredThreadInfo;
  message: PortalMessage;
  /** True when the portal's own organisation stopped listing it. */
  missing: boolean;
  fetchedAt: number;
}

export interface RecordMessagesReport {
  written: number;
  unchanged: number;
  missing: number;
}

export interface RecordMessagesOptions {
  /**
   * False when the read could not prove it saw everything (an organisation sent
   * no summary, a message would not parse): then absence proves nothing, and no
   * row is marked missing.
   */
  complete: boolean;
}

/** How the last Message Center read went, for one health system. */
export interface PortalMessageSync {
  healthSystemId: string;
  lastAttemptAt: number;
  /** Unix seconds of the last read that succeeded, or null when none has. */
  lastOkAt: number | null;
  /** Null when the last attempt succeeded. */
  lastErrorCode: string | null;
  complete: boolean;
  threads: number;
  messages: number;
}

/** What `markSync` records about one read. */
export type MessageSyncOutcome =
  | { ok: true; complete: boolean; threads: number; messages: number }
  | { ok: false; errorCode: string };

const messageAad = (healthSystemId: string, messageKey: string): string =>
  aadFor("portal_messages", "payload_enc", `${healthSystemId}:${messageKey}`);

/** The digest a message is identified by. Role included: a patient quoting a note is not the note. */
function messageFingerprint(message: PortalMessage): Promise<string> {
  return sha256Hex(`${message.sent}\u{0}${message.role}\u{0}${message.body}`);
}

/** The digest a thread is identified by: its subject and its first message. */
async function threadFingerprint(thread: PortalThread): Promise<string | null> {
  // The earliest message, whatever order the caller handed them in: the key must
  // not depend on it.
  let first: PortalMessage | undefined;
  for (const message of thread.messages) {
    if (first === undefined || message.sent < first.sent) first = message;
  }
  return first === undefined
    ? null
    : sha256Hex(`${thread.subject}\u{0}${await messageFingerprint(first)}`);
}

/** The ids the MCP hands out. No health system in them, on purpose. */
function publicIds(
  blinder: Blinder,
  payload: MessagePayload,
): Promise<[threadId: string, messageId: string]> {
  return Promise.all([
    blinder.id("portal_messages.thread_id", payload.threadFingerprint),
    blinder.id(
      "portal_messages.message_id",
      `${payload.threadFingerprint}\u{0}${payload.fingerprint}`,
    ),
  ]);
}

interface Prepared {
  messageKey: string;
  threadKey: string;
  payload: MessagePayload;
}

/** Every message of one read, keyed by its stored key. */
async function prepare(
  blinder: Blinder,
  healthSystemId: string,
  threads: readonly PortalThread[],
): Promise<Map<string, Prepared>> {
  const out = new Map<string, Prepared>();
  for (const thread of threads) {
    const threadPrint = await threadFingerprint(thread);
    if (threadPrint === null) continue;
    const { messages, ...info } = thread;
    const threadKey = await blinder.id(
      "portal_messages.thread_key",
      `${healthSystemId}\u{0}${threadPrint}`,
    );
    for (const message of messages) {
      const fingerprint = await messageFingerprint(message);
      const messageKey = await blinder.id(
        "portal_messages.message_key",
        `${healthSystemId}\u{0}${threadPrint}\u{0}${fingerprint}`,
      );
      // The same message twice in one read is one row; the later sighting wins.
      out.set(messageKey, {
        messageKey,
        threadKey,
        payload: { threadFingerprint: threadPrint, fingerprint, thread: info, message },
      });
    }
  }
  return out;
}

function syncOf(row: PortalMessageSyncRow): PortalMessageSync {
  return {
    healthSystemId: row.health_system_id,
    lastAttemptAt: row.last_attempt_at,
    lastOkAt: row.last_ok_at,
    lastErrorCode: row.last_error_code,
    complete: row.complete === 1,
    threads: row.threads,
    messages: row.messages,
  };
}

type KnownRow = Pick<
  PortalMessageRow,
  "health_system_id" | "message_key" | "content_hash" | "state" | "payload_enc"
>;

export function makePortalMessagesRepo(ctx: Ctx) {
  const blinder = blinderFor(ctx.env);

  const openPayload = async (
    row: Pick<PortalMessageRow, "health_system_id" | "message_key" | "payload_enc">,
  ): Promise<MessagePayload> =>
    JSON.parse(
      await open(ctx.env, row.payload_enc, messageAad(row.health_system_id, row.message_key)),
    ) as MessagePayload;

  const decode = async (row: PortalMessageRow): Promise<StoredPortalMessage> => {
    const payload = await openPayload(row);
    const [threadId, messageId] = await publicIds(blinder, payload);
    return {
      healthSystemId: row.health_system_id,
      threadId,
      messageId,
      fingerprint: payload.fingerprint,
      thread: payload.thread,
      message: payload.message,
      missing: row.state === "missing",
      fetchedAt: row.fetched_at,
    };
  };

  /**
   * The statement one prepared message needs: none when it is unchanged and
   * active, a state flip when it is unchanged but was missing, and a sealed
   * upsert (`sealed`) otherwise.
   */
  const upsertFor = async (
    healthSystemId: string,
    entry: Prepared,
    prior: KnownRow | undefined,
    now: number,
  ): Promise<{ write: D1PreparedStatement | null; sealed: boolean }> => {
    const plaintext = JSON.stringify(entry.payload);
    const hash = await blinder.digest(
      "portal_messages.content_hash",
      `${healthSystemId}\u{0}${plaintext}`,
    );
    if (prior?.content_hash === hash) {
      if (prior.state === "active") return { write: null, sealed: false };
      const restore = ctx.db
        .prepare(
          `UPDATE portal_messages SET state = 'active', missing_since = NULL, fetched_at = ?
            WHERE health_system_id = ? AND message_key = ?`,
        )
        .bind(now, healthSystemId, entry.messageKey);
      return { write: restore, sealed: false };
    }
    // Padded: a body's exact length is a fingerprint of what it says.
    const payloadEnc = await seal(
      ctx.env,
      plaintext,
      messageAad(healthSystemId, entry.messageKey),
      { pad: true },
    );
    const upsert = ctx.db
      .prepare(
        `INSERT INTO portal_messages
           (health_system_id, message_key, thread_key, payload_enc, content_hash,
            state, missing_since, fetched_at)
         VALUES (?, ?, ?, ?, ?, 'active', NULL, ?)
         ON CONFLICT (health_system_id, message_key) DO UPDATE SET
           thread_key = excluded.thread_key,
           payload_enc = excluded.payload_enc,
           content_hash = excluded.content_hash,
           state = 'active',
           missing_since = NULL,
           fetched_at = excluded.fetched_at`,
      )
      .bind(healthSystemId, entry.messageKey, entry.threadKey, payloadEnc, hash, now);
    return { write: upsert, sealed: true };
  };

  /**
   * The stored keys of the active first-party messages a complete read did not
   * return. Only those rows are opened, and only the portal's own messages are
   * ever flagged: see the module comment.
   */
  const noLongerListed = async (
    known: readonly KnownRow[],
    prepared: ReadonlyMap<string, Prepared>,
  ): Promise<string[]> => {
    const gone: string[] = [];
    for (const row of known) {
      if (prepared.has(row.message_key) || row.state !== "active") continue;
      const payload = await openPayload(row);
      if (!payload.thread.external) gone.push(row.message_key);
    }
    return gone;
  };

  /** The row a successful or failed read leaves in `portal_message_sync`. */
  const syncStatement = (
    healthSystemId: string,
    outcome: MessageSyncOutcome,
    now: number,
  ): D1PreparedStatement => {
    if (!outcome.ok) {
      return ctx.db
        .prepare(
          `INSERT INTO portal_message_sync
             (health_system_id, last_attempt_at, last_ok_at, last_error_code)
           VALUES (?, ?, NULL, ?)
           ON CONFLICT (health_system_id) DO UPDATE SET
             last_attempt_at = excluded.last_attempt_at,
             last_error_code = excluded.last_error_code`,
        )
        .bind(healthSystemId, now, outcome.errorCode);
    }
    return ctx.db
      .prepare(
        `INSERT INTO portal_message_sync
           (health_system_id, last_attempt_at, last_ok_at, last_error_code,
            complete, threads, messages)
         VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (health_system_id) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at,
           last_ok_at = excluded.last_ok_at,
           last_error_code = NULL,
           complete = excluded.complete,
           threads = excluded.threads,
           messages = excluded.messages`,
      )
      .bind(healthSystemId, now, now, outcome.complete ? 1 : 0, outcome.threads, outcome.messages);
  };

  return {
    /**
     * Store every message one Message Center read returned.
     *
     * A new or changed message is sealed and written; an unchanged one is left
     * alone (a missing one that is back becomes active again). With `complete`,
     * a first-party message this read did not return is marked missing.
     */
    async record(
      healthSystemId: string,
      threads: readonly PortalThread[],
      options: RecordMessagesOptions,
    ): Promise<RecordMessagesReport> {
      const now = ctx.now();
      const report: RecordMessagesReport = { written: 0, unchanged: 0, missing: 0 };
      const known = await all<KnownRow>(
        ctx.db
          .prepare(
            `SELECT health_system_id, message_key, content_hash, state, payload_enc
               FROM portal_messages WHERE health_system_id = ?`,
          )
          .bind(healthSystemId),
      );
      const existing = new Map(known.map((row) => [row.message_key, row]));
      const prepared = await prepare(blinder, healthSystemId, threads);

      const statements: D1PreparedStatement[] = [];
      for (const entry of prepared.values()) {
        const statement = await upsertFor(
          healthSystemId,
          entry,
          existing.get(entry.messageKey),
          now,
        );
        if (statement.write === null) {
          report.unchanged += 1;
          continue;
        }
        if (statement.sealed) report.written += 1;
        else report.unchanged += 1;
        statements.push(statement.write);
      }

      if (options.complete) {
        const gone = await noLongerListed(known, prepared);
        report.missing += gone.length;
        for (const messageKey of gone) {
          statements.push(
            ctx.db
              .prepare(
                `UPDATE portal_messages SET state = 'missing', missing_since = ?
                  WHERE health_system_id = ? AND message_key = ?`,
              )
              .bind(now, healthSystemId, messageKey),
          );
        }
      }

      for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
      ctx.log.info("portal_messages.recorded", { healthSystemId, ...report });
      return report;
    },

    /** Every stored message of one health system, opened, in no particular order. */
    async list(healthSystemId: string): Promise<StoredPortalMessage[]> {
      const rows = await all<PortalMessageRow>(
        ctx.db
          .prepare("SELECT * FROM portal_messages WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      return Promise.all(rows.map((row) => decode(row)));
    },

    /** Say how a Message Center read went. Counts and a stable code only. */
    async markSync(healthSystemId: string, outcome: MessageSyncOutcome): Promise<void> {
      await run(syncStatement(healthSystemId, outcome, ctx.now()));
    },

    /** Every health system's last Message Center read. */
    async listSync(): Promise<PortalMessageSync[]> {
      const rows = await all<PortalMessageSyncRow>(
        ctx.db.prepare("SELECT * FROM portal_message_sync"),
      );
      return rows.map((row) => syncOf(row));
    },

    /** Forget every stored message, and the sync row, for one health system. */
    async clearHealthSystem(healthSystemId: string): Promise<number> {
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM portal_messages WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      await run(
        ctx.db
          .prepare("DELETE FROM portal_message_sync WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      return changes;
    },
  };
}
