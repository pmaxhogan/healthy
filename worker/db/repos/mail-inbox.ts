/**
 * `mail_inbox`: the sign-in flow's only view of what has landed in the
 * portal's 2FA mailbox.
 *
 * Bodies are never stored -- see `worker/mail/handler.ts` -- and a code is
 * sealed the same way every other secret in this repository is, AAD bound to
 * `mail_inbox.code_enc.<id>`. `takeFreshOtp` is the security-relevant
 * operation: a single `UPDATE ... RETURNING`, so two concurrent sign-in
 * attempts (or a retry racing the original) can never both claim the same
 * code -- the second finds nothing to update, exactly like
 * `oauth_states.consume`.
 *
 * `listRecent` never opens an 'otp' row's code, even though it is free to:
 * a one-time login code has no reason to ever appear on a screen, and the
 * one thing the admin UI needs to show the owner is the *other* kind of code
 * this table holds -- Gmail's own forwarding-confirmation code -- which is
 * not a secret and exists specifically so a human can read and use it.
 */

import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { MailInboxRow, MailKind } from "../rows.ts";

const aad = (id: string): string => aadFor("mail_inbox", "code_enc", id);

export interface MailInboxInsert {
  fromAddr: string;
  subject: string | null;
  kind: MailKind;
  /** Plaintext digits for 'otp' or 'forward_verify'. Ignored for 'other'. */
  code: string | null;
  /** The confirmation link. Only meaningful for 'forward_verify'. */
  url: string | null;
  receivedAt: number;
  /** Null for a row with no TTL (currently every kind but 'otp'). */
  expiresAt: number | null;
  rawSize: number;
}

export interface MailInboxEntry {
  id: string;
  receivedAt: number;
  fromAddr: string;
  subject: string | null;
  kind: MailKind;
  consumedAt: number | null;
  expiresAt: number | null;
  rawSize: number;
  /** Opened only for a 'forward_verify' row; always null otherwise. */
  pendingCode: string | null;
  pendingUrl: string | null;
}

/**
 * What actually goes into `code_enc`.
 *
 * One column has to carry two different shapes: a bare OTP string, or a
 * `forward_verify` message's `{ code, url }` pair. Encoding that difference
 * lives here, entirely inside the repo, so nothing upstream has to know the
 * column moonlights as small JSON for one kind and plain text for another.
 */
function payloadFor(input: Pick<MailInboxInsert, "kind" | "code" | "url">): string | null {
  if (input.kind === "other") return null;
  if (input.kind === "forward_verify") {
    return input.code === null && input.url === null
      ? null
      : JSON.stringify({ code: input.code, url: input.url });
  }
  return input.code;
}

/** The inverse of `payloadFor`, for a 'forward_verify' row. Never throws. */
function readForwardVerifyPayload(payload: string): { code: string | null; url: string | null } {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      const { code, url } = parsed as { code?: unknown; url?: unknown };
      return {
        code: typeof code === "string" ? code : null,
        url: typeof url === "string" ? url : null,
      };
    }
  } catch {
    // Fall through to the "nothing readable" answer below.
  }
  return { code: null, url: null };
}

export function makeMailInboxRepo(ctx: Ctx) {
  /** A row plus its opened fields, honouring the "never an otp code" rule above. */
  const toEntry = async (row: MailInboxRow): Promise<MailInboxEntry> => {
    let pendingCode: string | null = null;
    let pendingUrl: string | null = null;
    if (row.kind === "forward_verify" && row.code_enc !== null) {
      const payload = await open(ctx.env, row.code_enc, aad(row.id));
      ({ code: pendingCode, url: pendingUrl } = readForwardVerifyPayload(payload));
    }
    return {
      id: row.id,
      receivedAt: row.received_at,
      fromAddr: row.from_addr,
      subject: row.subject,
      kind: row.kind,
      consumedAt: row.consumed_at,
      expiresAt: row.expires_at,
      rawSize: row.raw_size,
      pendingCode,
      pendingUrl,
    };
  };

  return {
    /** Store one accepted message. The caller has already run the allowlist gate. */
    async insert(input: MailInboxInsert): Promise<MailInboxEntry> {
      const id = newId();
      const plaintext = payloadFor(input);
      const codeEnc = plaintext === null ? null : await seal(ctx.env, plaintext, aad(id));
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mail_inbox (id, received_at, from_addr, subject, kind, code_enc, expires_at, raw_size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.receivedAt,
            input.fromAddr,
            input.subject,
            input.kind,
            codeEnc,
            input.expiresAt,
            input.rawSize,
          ),
      );
      return {
        id,
        receivedAt: input.receivedAt,
        fromAddr: input.fromAddr,
        subject: input.subject,
        kind: input.kind,
        consumedAt: null,
        expiresAt: input.expiresAt,
        rawSize: input.rawSize,
        pendingCode: input.kind === "forward_verify" ? input.code : null,
        pendingUrl: input.kind === "forward_verify" ? input.url : null,
      };
    },

    /**
     * Atomically claim the newest unconsumed, unexpired OTP received after
     * `since` (a login attempt's `SendCode` time), marking it consumed in the
     * same statement. Null when there is nothing to claim -- an expired code,
     * an already-consumed one, or nothing having arrived yet all look the
     * same to the caller, which is the point: there is nothing it could do
     * differently for any of them.
     */
    async takeFreshOtp(options: { since: number; now: number }): Promise<{
      id: string;
      code: string;
    } | null> {
      const row = await one<MailInboxRow>(
        ctx.db
          .prepare(
            `UPDATE mail_inbox
                SET consumed_at = ?
              WHERE id = (
                      SELECT id FROM mail_inbox
                       WHERE kind = 'otp' AND consumed_at IS NULL
                         AND expires_at > ? AND received_at > ?
                       ORDER BY received_at DESC LIMIT 1
                    )
                AND consumed_at IS NULL
              RETURNING *`,
          )
          .bind(options.now, options.now, options.since),
      );
      // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- not equivalent: `row?.code_enc === null` is `false` (not `true`) when `row` itself is null, since the chain short-circuits to `undefined`.
      if (row === null || row.code_enc === null) return null;
      const code = await open(ctx.env, row.code_enc, aad(row.id));
      return { id: row.id, code };
    },

    /** Recent inbox entries, newest first. Never an 'otp' row's code -- see the module comment. */
    async listRecent(limit = 50): Promise<MailInboxEntry[]> {
      const rows = await all<MailInboxRow>(
        ctx.db.prepare("SELECT * FROM mail_inbox ORDER BY received_at DESC LIMIT ?").bind(limit),
      );
      return Promise.all(rows.map((row) => toEntry(row)));
    },

    /** Drop rows past their TTL. Called from the email handler after each insert. */
    async purgeExpired(now: number): Promise<number> {
      const { changes } = await run(
        ctx.db
          .prepare("DELETE FROM mail_inbox WHERE expires_at IS NOT NULL AND expires_at <= ?")
          .bind(now),
      );
      return changes;
    },
  };
}
