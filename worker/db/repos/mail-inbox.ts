/**
 * `mail_inbox`: the sign-in flow's only view of what has landed in the
 * portal's 2FA mailbox.
 *
 * Bodies are never stored -- see `worker/mail/handler.ts` -- and everything
 * this table does keep about a message is sealed the same way every other
 * secret in this repository is, AAD bound to `mail_inbox.<column>.<id>`: the
 * code, and since 0005 the sender address and the subject too. Both of those
 * name the health system for a forwarded portal message, and both are chosen
 * by whoever sent it. The old plaintext `from_addr` / `subject` columns are
 * still in the schema and new rows write an empty string into them; a row
 * written before 0005 is read through them as a fallback.
 *
 * `takeFreshOtp` is the security-relevant operation, and it has two jobs.
 *
 *   - **Only the right sender's code may be claimed.** An eligible row is one
 *     from the health system's own expected sender where it has one, and otherwise
 *     one that is both on the sender allowlist and on the same site
 *     (registrable domain) as this portal's own base URL. Without either half,
 *     a stranger who can reach the inbound address -- or, before any sender is
 *     learned, a second configured portal's own allowlisted sender arriving in
 *     the same window -- could have a code of their own choosing submitted to
 *     the owner's real portal.
 *   - **A code can never be claimed twice.** The claim is an
 *     `UPDATE ... WHERE consumed_at IS NULL RETURNING`, one row at a time, so
 *     two concurrent sign-in attempts (or a retry racing the original) cannot
 *     both take the same code -- the second finds nothing to update and moves
 *     on, exactly like `oauth_states.consume`.
 *
 * Oldest eligible first, not newest: the portal's own code is the one that
 * arrived closest behind the `SendCode` call, and preferring the newest handed
 * every poll to whoever was sending fastest.
 *
 * `listRecent` never opens an 'otp' row's code, even though it is free to:
 * a one-time login code has no reason to ever appear on a screen, and the
 * one thing the admin UI needs to show the owner is the *other* kind of code
 * this table holds -- Gmail's own forwarding-confirmation code -- which is
 * not a secret and exists specifically so a human can read and use it.
 */

import { registrableDomain } from "../../ehr/mychart/site.ts";
import { newId } from "../../lib/ids.ts";
import { domainAllowed, domainOf } from "../../mail/classify.ts";
// A repo reaching into `worker/ehr/mychart/**` is otherwise unheard of --
// see the "opaque" comments in `rows.ts`/`schemas.ts` -- but `registrableDomain`
// is a pure, dependency-free string function (see its own module comment) and
// this is the one place outside that directory that needs the same "same site"
// question `sameRegistrableSite` answers for redirects and cookies.
import { all, one, run } from "../client.ts";
import { aadFor, open, openOrNull, sealShort } from "../crypto.ts";

import type { Ctx } from "../client.ts";
import type { MailInboxRow, MailKind } from "../rows.ts";

const codeAad = (id: string): string => aadFor("mail_inbox", "code_enc", id);
const fromAad = (id: string): string => aadFor("mail_inbox", "from_addr_enc", id);
const subjectAad = (id: string): string => aadFor("mail_inbox", "subject_enc", id);

/**
 * How many pending rows one claim will consider.
 *
 * The sender filter cannot be pushed into SQL -- a sealed column has a random
 * IV per row, so two seals of the same address are different ciphertext and
 * `WHERE from_addr_enc = ?` can never match. So the candidates are read
 * oldest-first and opened one at a time until one is eligible, and this is the
 * bound on that work. Far above any real inbox (a portal sends one code per
 * attempt); a flood beyond it is exactly the case the TTL and the purge cover.
 */
const CLAIM_CANDIDATES = 25;

/** Rows older than this are dropped whatever their `expires_at` says. */
const MAIL_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export interface MailInboxInsert {
  fromAddr: string;
  subject: string | null;
  kind: MailKind;
  /** Plaintext digits for 'otp' or 'forward_verify'. Ignored for 'other'. */
  code: string | null;
  /** The confirmation link. Only meaningful for 'forward_verify'. */
  url: string | null;
  receivedAt: number;
  /** Every kind has one -- see `mailTtlSeconds` in `worker/mail/classify.ts`. */
  expiresAt: number;
  rawSize: number;
}

export interface MailInboxEntry {
  id: string;
  receivedAt: number;
  /**
   * The sender's domain, and only the domain.
   *
   * Reduced here rather than in `worker/api/dto.ts` so the full address never
   * leaves this module: it is opened from `from_addr_enc`, the local part is
   * dropped, and what travels is the one part the admin UI shows.
   */
  senderDomain: string;
  /** Opened only for a 'forward_verify' row -- the one kind the UI needs it for. */
  subject: string | null;
  kind: MailKind;
  consumedAt: number | null;
  expiresAt: number | null;
  rawSize: number;
  /** Opened only for a 'forward_verify' row; always null otherwise. */
  pendingCode: string | null;
  pendingUrl: string | null;
}

/** A claimed verification code, and which sender's it was. */
export interface ClaimedOtp {
  id: string;
  code: string;
  /** The domain the claimed row came from, for the caller's learning step. */
  senderDomain: string;
}

/** Which rows a claim may take. */
export interface OtpClaimFilter {
  /** Unix second `SendCode` was called: the floor for `received_at`. */
  since: number;
  now: number;
  /**
   * The domain this health system's codes come from, when it is known.
   *
   * Non-null narrows eligibility to that domain (or a subdomain of it) and
   * nothing else. Null falls back to the sender allowlist -- narrowed by
   * `portalHost`, below -- which is what makes the very first sign-in -- the
   * one that *learns* the sender -- possible.
   */
  expectedSender: string | null;
  /** The `mail_sender_allowlist` setting, parsed. Used only when there is no expected sender. */
  allowlist: readonly string[];
  /**
   * This account's own portal, as a hostname (from `portal_accounts.base_url`).
   *
   * Used only when there is no expected sender yet: a candidate then also has to
   * share a registrable domain with this host, not merely be on the (global,
   * shared-across-every-configured-portal) allowlist. Without this, a second
   * configured portal's own allowlisted sender is eligible for this one too,
   * which is exactly the cross-portal claim this field exists to rule out. Null
   * fails closed -- nothing is eligible via the allowlist path at all -- which
   * in production never happens: `openPortalSession` refuses to run without a
   * `base_url`, so a call this far into a sign-in always has one.
   */
  portalHost: string | null;
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
  /**
   * The row's sender domain.
   *
   * An absent or unreadable ciphertext reads as "no sender", which makes the
   * row ineligible for any claim rather than eligible for all of them.
   */
  const senderDomainOf = async (row: MailInboxRow): Promise<string> => {
    const opened = await openOrNull(ctx.env, row.from_addr_enc, fromAad(row.id));
    return opened === null ? "" : domainOf(opened);
  };

  /** A row plus its opened fields, honouring the "never an otp code" rule above. */
  const toEntry = async (row: MailInboxRow): Promise<MailInboxEntry> => {
    let pendingCode: string | null = null;
    let pendingUrl: string | null = null;
    let subject: string | null = null;
    if (row.kind === "forward_verify") {
      if (row.code_enc !== null) {
        const payload = await open(ctx.env, row.code_enc, codeAad(row.id));
        ({ code: pendingCode, url: pendingUrl } = readForwardVerifyPayload(payload));
      }
      // Only this kind: the subject of a portal message is the portal's own
      // wording about the owner's care, and nothing on the Mail page needs it.
      subject = await openOrNull(ctx.env, row.subject_enc, subjectAad(row.id));
    }
    return {
      id: row.id,
      receivedAt: row.received_at,
      senderDomain: await senderDomainOf(row),
      subject,
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
      const codeEnc = plaintext === null ? null : await sealShort(ctx.env, plaintext, codeAad(id));
      const fromEnc = await sealShort(ctx.env, input.fromAddr, fromAad(id));
      const subjectEnc =
        input.subject === null ? null : await sealShort(ctx.env, input.subject, subjectAad(id));
      await run(
        ctx.db
          .prepare(
            `INSERT INTO mail_inbox
               (id, received_at, from_addr_enc, subject_enc, kind, code_enc, expires_at, raw_size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.receivedAt,
            fromEnc,
            subjectEnc,
            input.kind,
            codeEnc,
            input.expiresAt,
            input.rawSize,
          ),
      );
      return {
        id,
        receivedAt: input.receivedAt,
        senderDomain: domainOf(input.fromAddr),
        subject: input.kind === "forward_verify" ? input.subject : null,
        kind: input.kind,
        consumedAt: null,
        expiresAt: input.expiresAt,
        rawSize: input.rawSize,
        pendingCode: input.kind === "forward_verify" ? input.code : null,
        pendingUrl: input.kind === "forward_verify" ? input.url : null,
      };
    },

    /**
     * Atomically claim the oldest unconsumed, unexpired, *eligible* OTP
     * received after `filter.since` (a login attempt's `SendCode` time),
     * marking it consumed in the same statement.
     *
     * Null when there is nothing to claim -- an expired code, an
     * already-consumed one, one from a sender this health system has never had a
     * code from, or nothing having arrived yet all look the same to the caller,
     * which is the point: there is nothing it could do differently for any of
     * them.
     */
    async takeFreshOtp(filter: OtpClaimFilter): Promise<ClaimedOtp | null> {
      const candidates = await all<MailInboxRow>(
        ctx.db
          .prepare(
            `SELECT * FROM mail_inbox
              WHERE kind = 'otp' AND consumed_at IS NULL
                AND expires_at > ? AND received_at > ?
              ORDER BY received_at ASC, id ASC
              LIMIT ?`,
          )
          .bind(filter.now, filter.since, CLAIM_CANDIDATES),
      );

      for (const candidate of candidates) {
        if (candidate.code_enc === null) continue;
        const senderDomain = await senderDomainOf(candidate);
        if (!eligible(senderDomain, filter)) continue;
        // The claim itself, one row at a time: whoever's UPDATE lands first
        // owns the code, and a loser simply moves to the next candidate.
        const claimed = await one<MailInboxRow>(
          ctx.db
            .prepare(
              `UPDATE mail_inbox SET consumed_at = ?
                WHERE id = ? AND consumed_at IS NULL
                RETURNING *`,
            )
            .bind(filter.now, candidate.id),
        );
        // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- not equivalent: `claimed?.code_enc === null` is `false` (not `true`) when `claimed` itself is null, since the chain short-circuits to `undefined`.
        if (claimed === null || claimed.code_enc === null) continue;
        const code = await open(ctx.env, claimed.code_enc, codeAad(claimed.id));
        return { id: claimed.id, code, senderDomain };
      }
      return null;
    },

    /** Recent inbox entries, newest first. Never an 'otp' row's code -- see the module comment. */
    async listRecent(limit = 50): Promise<MailInboxEntry[]> {
      const rows = await all<MailInboxRow>(
        ctx.db.prepare("SELECT * FROM mail_inbox ORDER BY received_at DESC LIMIT ?").bind(limit),
      );
      return Promise.all(rows.map((row) => toEntry(row)));
    },

    /**
     * Drop rows past their TTL, and rows past the hard age ceiling whatever
     * their TTL says.
     *
     * The second half is the backstop: every kind gets an `expires_at` now, but
     * a row written before that was true (or by some future caller that forgets)
     * would otherwise be kept for ever. Called from the email handler after each
     * insert *and* from the daily cron, so collection does not depend on inbound
     * mail arriving.
     */
    async purgeExpired(now: number): Promise<number> {
      const { changes } = await run(
        ctx.db
          .prepare(
            `DELETE FROM mail_inbox
              WHERE (expires_at IS NOT NULL AND expires_at <= ?)
                 OR received_at <= ?`,
          )
          .bind(now, now - MAIL_MAX_AGE_SECONDS),
      );
      return changes;
    },
  };
}

/**
 * Whether a row from `senderDomain` may be claimed under `filter`.
 *
 * An expected sender narrows eligibility to that domain (or a subdomain of it)
 * and nothing else -- the strongest rule, and once a health system has one it wins
 * outright, even for a sender on a different site than the portal itself (a
 * vendor-hosted deployment can legitimately email from a different domain than
 * it serves the portal from). Without one, two things both have to hold: the
 * sender is on the general allowlist, same as before, and it shares a
 * registrable domain with this portal's own host -- which is what makes the
 * very first sign-in -- the one that learns the sender -- possible without also
 * admitting a second configured portal's own allowlisted sender.
 */
function eligible(senderDomain: string, filter: OtpClaimFilter): boolean {
  return filter.expectedSender === null
    ? domainAllowed(senderDomain, filter.allowlist) &&
        filter.portalHost !== null &&
        registrableDomain(senderDomain) === registrableDomain(filter.portalHost)
    : domainAllowed(senderDomain, [filter.expectedSender]);
}
