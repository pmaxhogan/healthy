/**
 * `portal_message_attachments` and `portal_message_attachment_chunks`: the files
 * attached to secure messages, fetched by the portal pass and sealed.
 *
 * The portal names an attachment only by a per-session token, so the same run
 * that listed it has to fetch it (`worker/src/sync/portal-sync.ts`). What is stored
 * is keyed on content instead -- `attachment_key` is the key
 * `worker/src/db/repos/portal-messages.ts` derives from the message's own digest and
 * the attachment's position in it -- so the next run, with a new session, knows
 * the file is already here and does not fetch it again.
 *
 * ### Every byte, in pieces
 *
 * A file is kept whole, however large. D1 holds at most 2,000,000 bytes in one
 * value, so the file is base64-encoded and cut into {@link CHUNK_BASE64_CHARS}-
 * character pieces, each sealed and padded on its own: a full piece pads to a
 * 1 MiB bucket and seals to about 1.4 MB. The pieces and the row that says the
 * file is stored are written in one batch, so a reader never sees a file with a
 * piece missing.
 *
 * ### A failure is a row too
 *
 * A download that does not work (another organisation's attachment the portal
 * will not serve, an expired session, a page where the file should be) is
 * recorded as `failed` with a stable code, so the MCP can say so instead of
 * pretending the file does not exist. It is tried again on a later run once
 * {@link RETRY_FAILED_AFTER_SECONDS} have passed.
 */

import { base64ToBytes, bytesToBase64 } from "../../lib/base64.ts";
import { all, batch, one, run } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { Ctx } from "../client.ts";

/**
 * Base64 characters per stored piece: 576 KiB of the file. With the padding's
 * length prefix that fills a 1 MiB bucket exactly, which seals to ~1.4 MB --
 * under D1's 2,000,000-byte value limit with room to spare. A multiple of four,
 * so every piece decodes on its own.
 */
export const CHUNK_BASE64_CHARS = 786_432;

/** How long a failed download waits before the portal pass tries it again. */
export const RETRY_FAILED_AFTER_SECONDS = 24 * 60 * 60;

/** What is kept about an attachment besides its bytes. */
export interface AttachmentMeta {
  name?: string | undefined;
  extension?: string | undefined;
  /** The download's content type. Only for a stored file. */
  contentType?: string | undefined;
  /** Bytes. Only for a stored file. */
  size?: number | undefined;
}

/** One attachment row, opened. */
export interface StoredAttachment {
  healthSystemId: string;
  attachmentKey: string;
  state: "stored" | "failed";
  /** Null unless `failed`. */
  errorCode: string | null;
  meta: AttachmentMeta;
  attemptedAt: number;
  fetchedAt: number | null;
}

interface AttachmentRow {
  health_system_id: string;
  attachment_key: string;
  meta_enc: string;
  state: "stored" | "failed";
  error_code: string | null;
  chunks: number;
  attempted_at: number;
  fetched_at: number | null;
}

const metaAad = (healthSystemId: string, key: string): string =>
  aadFor("portal_message_attachments", "meta_enc", `${healthSystemId}:${key}`);

const chunkAad = (healthSystemId: string, key: string, seq: number): string =>
  aadFor("portal_message_attachment_chunks", "data_enc", `${healthSystemId}:${key}:${String(seq)}`);

/** A base64 string cut into stored pieces. Never empty: an empty file is one empty piece. */
export function base64Pieces(base64: string): string[] {
  const pieces: string[] = [];
  for (let offset = 0; offset < base64.length; offset += CHUNK_BASE64_CHARS) {
    pieces.push(base64.slice(offset, offset + CHUNK_BASE64_CHARS));
  }
  return pieces.length === 0 ? [""] : pieces;
}

export function makePortalMessageAttachmentsRepo(ctx: Ctx) {
  const decode = async (row: AttachmentRow): Promise<StoredAttachment> => ({
    healthSystemId: row.health_system_id,
    attachmentKey: row.attachment_key,
    state: row.state,
    errorCode: row.error_code,
    meta: JSON.parse(
      await open(ctx.env, row.meta_enc, metaAad(row.health_system_id, row.attachment_key)),
    ) as AttachmentMeta,
    attemptedAt: row.attempted_at,
    fetchedAt: row.fetched_at,
  });

  const sealMeta = (healthSystemId: string, key: string, meta: AttachmentMeta) =>
    seal(ctx.env, JSON.stringify(meta), metaAad(healthSystemId, key), { pad: true });

  return {
    /**
     * Of these keys, the ones the portal pass should fetch now: never tried, or
     * failed long enough ago to try again. A stored file is never fetched twice.
     */
    async needingFetch(healthSystemId: string, keys: readonly string[]): Promise<Set<string>> {
      const rows = await all<Pick<AttachmentRow, "attachment_key" | "state" | "attempted_at">>(
        ctx.db
          .prepare(
            `SELECT attachment_key, state, attempted_at
               FROM portal_message_attachments WHERE health_system_id = ?`,
          )
          .bind(healthSystemId),
      );
      const known = new Map(rows.map((row) => [row.attachment_key, row]));
      const now = ctx.now();
      const out = new Set<string>();
      for (const key of keys) {
        const row = known.get(key);
        const retry =
          row?.state === "failed" && now - row.attempted_at >= RETRY_FAILED_AFTER_SECONDS;
        if (row === undefined || retry) out.add(key);
      }
      return out;
    },

    /** Seal and store one fetched file, every byte of it, replacing whatever was there. */
    async store(
      healthSystemId: string,
      key: string,
      meta: AttachmentMeta,
      bytes: Uint8Array,
    ): Promise<{ chunks: number }> {
      const now = ctx.now();
      const pieces = base64Pieces(bytesToBase64(bytes));
      const sealedMeta = await sealMeta(healthSystemId, key, { ...meta, size: bytes.length });
      const statements: D1PreparedStatement[] = [
        ctx.db
          .prepare(
            `INSERT INTO portal_message_attachments
               (health_system_id, attachment_key, meta_enc, state, error_code, chunks,
                attempted_at, fetched_at)
             VALUES (?, ?, ?, 'stored', NULL, ?, ?, ?)
             ON CONFLICT (health_system_id, attachment_key) DO UPDATE SET
               meta_enc = excluded.meta_enc,
               state = 'stored',
               error_code = NULL,
               chunks = excluded.chunks,
               attempted_at = excluded.attempted_at,
               fetched_at = excluded.fetched_at`,
          )
          .bind(healthSystemId, key, sealedMeta, pieces.length, now, now),
        ctx.db
          .prepare(
            `DELETE FROM portal_message_attachment_chunks
              WHERE health_system_id = ? AND attachment_key = ?`,
          )
          .bind(healthSystemId, key),
      ];
      for (const [seq, piece] of pieces.entries()) {
        const sealed = await seal(ctx.env, piece, chunkAad(healthSystemId, key, seq), {
          pad: true,
        });
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO portal_message_attachment_chunks
                 (health_system_id, attachment_key, seq, data_enc) VALUES (?, ?, ?, ?)`,
            )
            .bind(healthSystemId, key, seq, sealed),
        );
      }
      await batch(ctx.db, statements);
      return { chunks: pieces.length };
    },

    /** Record a download that did not work. Never overwrites a stored file. */
    async fail(
      healthSystemId: string,
      key: string,
      meta: AttachmentMeta,
      errorCode: string,
    ): Promise<void> {
      const now = ctx.now();
      const sealedMeta = await sealMeta(healthSystemId, key, {
        name: meta.name,
        extension: meta.extension,
      });
      await run(
        ctx.db
          .prepare(
            `INSERT INTO portal_message_attachments
               (health_system_id, attachment_key, meta_enc, state, error_code, chunks,
                attempted_at, fetched_at)
             VALUES (?, ?, ?, 'failed', ?, 0, ?, NULL)
             ON CONFLICT (health_system_id, attachment_key) DO UPDATE SET
               meta_enc = excluded.meta_enc,
               error_code = excluded.error_code,
               attempted_at = excluded.attempted_at
             WHERE portal_message_attachments.state = 'failed'`,
          )
          .bind(healthSystemId, key, sealedMeta, errorCode, now),
      );
    },

    /** Every attachment row of one health system, opened. No file content. */
    async list(healthSystemId: string): Promise<StoredAttachment[]> {
      const rows = await all<AttachmentRow>(
        ctx.db
          .prepare("SELECT * FROM portal_message_attachments WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      return Promise.all(rows.map((row) => decode(row)));
    },

    /** One stored file's bytes, every piece in order; null when it is not stored. */
    async content(healthSystemId: string, key: string): Promise<Uint8Array | null> {
      const row = await one<AttachmentRow>(
        ctx.db
          .prepare(
            `SELECT * FROM portal_message_attachments
              WHERE health_system_id = ? AND attachment_key = ?`,
          )
          .bind(healthSystemId, key),
      );
      if (row?.state !== "stored") return null;
      const pieces = await all<{ seq: number; data_enc: string }>(
        ctx.db
          .prepare(
            `SELECT seq, data_enc FROM portal_message_attachment_chunks
              WHERE health_system_id = ? AND attachment_key = ? ORDER BY seq`,
          )
          .bind(healthSystemId, key),
      );
      // Written in one batch with the row, so a short count is corruption, not a race.
      if (pieces.length !== row.chunks || pieces.some((piece, index) => piece.seq !== index)) {
        return null;
      }
      let base64 = "";
      for (const piece of pieces) {
        base64 += await open(ctx.env, piece.data_enc, chunkAad(healthSystemId, key, piece.seq));
      }
      return base64ToBytes(base64);
    },

    /** Forget every attachment of one health system. */
    async clearHealthSystem(healthSystemId: string): Promise<number> {
      await run(
        ctx.db
          .prepare("DELETE FROM portal_message_attachment_chunks WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM portal_message_attachments WHERE health_system_id = ?")
          .bind(healthSystemId),
      );
      return changes;
    },
  };
}
