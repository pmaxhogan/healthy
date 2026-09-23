/**
 * `portal_visits`: the portal pass's own copy of the upcoming visits it saw.
 *
 * The calendar is not something the MCP can read, and Epic's patient FHIR view
 * never returns an Encounter before the visit happens -- so without this table a
 * question about what is coming up has no answer outside the owner's calendar.
 * The portal pass writes every visit `LoadUpcoming` returned, every run; the MCP
 * (`worker/mcp/appointment-items.ts`) reads them back.
 *
 * Nothing about the visit is stored in the clear:
 *
 *   - `csn` is `blindCsn(...)`, a keyed HMAC of the health system and the
 *     portal's visit number (`worker/db/blind.ts`). Still the primary key and
 *     still an exact match, but a snapshot no longer carries the portal's own
 *     identifiers, and the same visit listed by two organisations' portals
 *     blinds to two unrelated values.
 *   - `payload_enc` is the whole parsed visit, sealed against
 *     `portal_visits.payload_enc.<healthSystemId>:<csn>` with the stored (blinded)
 *     `csn` -- the composite row id, because the primary key is composite. The
 *     real visit number and start time are only in here.
 *   - `content_hash` is a keyed digest of the plaintext, for the same reason
 *     `fhir_cache` keeps one: sealing is randomised, so it is the only way to tell
 *     an unchanged visit from an updated one without re-sealing every row every
 *     hour. Keyed, because a plain sha256 of a guessable visit is a confirmation
 *     oracle.
 *   - There is no start column (0008 dropped it): the visit's start is in the
 *     payload, and every reader here already opens the payload.
 *   - `expires_at` is coarsened to a `EXPIRY_BUCKET_SECONDS` boundary. It is a
 *     year after the visit, so to the second it *was* the visit's start time;
 *     rounded up to a 30-day boundary it only drives the purge, which does not
 *     mind running a few weeks late.
 *
 * The "missing" rule is the calendar's ghost rule, restated for a table: a visit
 * the portal stops returning while it is still ahead is marked `missing` (as far
 * as anyone can tell, it was cancelled); one that stops being returned after its
 * start time is simply over and is left exactly as it was. Deciding that needs the
 * start of each visit that was *not* returned, so exactly those rows are opened.
 */

import { blindCsn, blinderFor } from "../blind.ts";
import { BATCH_CHUNK, all, batch, chunk, run } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { PortalVisit } from "../../ehr/mychart/index.ts";
import type { Blinder } from "../blind.ts";
import type { Ctx } from "../client.ts";
import type { PortalVisitRow, PortalVisitState } from "../rows.ts";

/** How long a visit is kept after it happens (or after it was last seen, if later). */
const PORTAL_VISIT_RETENTION_SECONDS = 365 * 24 * 3600;

/**
 * The granularity `expires_at` is rounded up to. Thirty days: coarse enough that
 * the column no longer dates the visit, fine enough that the purge still runs
 * within a month of when it would have.
 */
export const EXPIRY_BUCKET_SECONDS = 30 * 24 * 3600;

/** The AAD for one stored visit, by the id the row is stored under. */
const portalVisitAad = (healthSystemId: string, storedCsn: string): string =>
  aadFor("portal_visits", "payload_enc", `${healthSystemId}:${storedCsn}`);

/** The stored digest of one plaintext payload. */
function portalVisitDigest(
  blinder: Blinder,
  healthSystemId: string,
  plaintext: string,
): Promise<string> {
  return blinder.digest("portal_visits.content_hash", `${healthSystemId}\u{0}${plaintext}`);
}

/** `expires_at` for a visit starting at `start`, seen at `now`. */
function portalVisitExpiry(start: number, now: number): number {
  const exact = Math.max(start, now) + PORTAL_VISIT_RETENTION_SECONDS;
  return Math.ceil(exact / EXPIRY_BUCKET_SECONDS) * EXPIRY_BUCKET_SECONDS;
}

/** A stored visit, opened. */
export interface StoredPortalVisit {
  healthSystemId: string;
  /** The portal's real visit number, from the payload. */
  csn: string;
  visit: PortalVisit;
  state: PortalVisitState;
  /** When a future visit first stopped being returned. Null while `active`. */
  missingSince: number | null;
  fetchedAt: number;
}

export interface RecordVisitsReport {
  written: number;
  unchanged: number;
  missing: number;
}

export interface RecordVisitsOptions {
  /**
   * False when the caller knows this list is not everything `LoadUpcoming`
   * would have returned, so absence from it proves nothing and no row is
   * marked missing. The portal pass always passes `true`: the parse itself
   * never truncates, so every call it makes has the whole answer.
   */
  complete: boolean;
}

/** Unix seconds from a visit's ISO start, or null when it does not parse. */
function startSeconds(visit: PortalVisit): number | null {
  const ms = Date.parse(visit.start);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Earliest first, then by visit number: what `ORDER BY start_at, csn` used to say. */
function byStart(a: StoredPortalVisit, b: StoredPortalVisit): number {
  const apart = (startSeconds(a.visit) ?? 0) - (startSeconds(b.visit) ?? 0);
  if (apart !== 0) return apart;
  if (a.healthSystemId !== b.healthSystemId) return a.healthSystemId < b.healthSystemId ? -1 : 1;
  if (a.csn === b.csn) return 0;
  return a.csn < b.csn ? -1 : 1;
}

export function makePortalVisitsRepo(ctx: Ctx) {
  const blinder = blinderFor(ctx.env);

  const openPayload = async (
    row: Pick<PortalVisitRow, "health_system_id" | "csn" | "payload_enc">,
  ) =>
    JSON.parse(
      await open(ctx.env, row.payload_enc, portalVisitAad(row.health_system_id, row.csn)),
    ) as PortalVisit;

  const decode = async (row: PortalVisitRow): Promise<StoredPortalVisit> => {
    const visit = await openPayload(row);
    return {
      healthSystemId: row.health_system_id,
      csn: visit.csn,
      visit,
      state: row.state,
      missingSince: row.missing_since,
      fetchedAt: row.fetched_at,
    };
  };

  /**
   * The stored numbers of the rows whose visit is still ahead. Only the rows that
   * went quiet are opened: their start decides between "cancelled" and "over",
   * and it is nowhere but in the payload.
   */
  const stillAhead = async (
    rows: readonly Pick<PortalVisitRow, "health_system_id" | "csn" | "payload_enc">[],
    now: number,
  ): Promise<string[]> => {
    const ahead: string[] = [];
    for (const row of rows) {
      const start = startSeconds(await openPayload(row));
      if (start !== null && start > now) ahead.push(row.csn);
    }
    return ahead;
  };

  return {
    /**
     * Store every visit one `LoadUpcoming` returned, and mark the future ones it
     * stopped returning as missing.
     *
     * A visit that is back after being missing is `active` again. An unchanged
     * visit only has its timestamps moved.
     */
    async record(
      healthSystemId: string,
      visits: readonly PortalVisit[],
      options: RecordVisitsOptions,
    ): Promise<RecordVisitsReport> {
      const now = ctx.now();
      const report: RecordVisitsReport = { written: 0, unchanged: 0, missing: 0 };
      const known = await all<
        Pick<PortalVisitRow, "health_system_id" | "csn" | "content_hash" | "state" | "payload_enc">
      >(
        ctx.db
          .prepare(
            `SELECT health_system_id, csn, content_hash, state, payload_enc FROM portal_visits
              WHERE health_system_id = ?`,
          )
          .bind(healthSystemId),
      );
      const existing = new Map(known.map((row) => [row.csn, row]));

      // One row per CSN, the last sighting winning: a visit can in principle sit in
      // two buckets of the same payload, and two upserts of one key in a batch
      // would only make the report lie. Keyed by the stored (blinded) number.
      const byCsn = new Map<string, PortalVisit>();
      for (const visit of visits)
        byCsn.set(await blindCsn(blinder, healthSystemId, visit.csn), visit);

      const statements: D1PreparedStatement[] = [];
      for (const [storedCsn, visit] of byCsn) {
        const start = startSeconds(visit);
        if (start === null) continue;
        const expiresAt = portalVisitExpiry(start, now);
        const plaintext = JSON.stringify(visit);
        const hash = await portalVisitDigest(blinder, healthSystemId, plaintext);
        const prior = existing.get(storedCsn);

        if (prior?.content_hash === hash && prior.state === "active") {
          report.unchanged += 1;
          statements.push(
            ctx.db
              .prepare(
                `UPDATE portal_visits SET fetched_at = ?, expires_at = ?
                  WHERE health_system_id = ? AND csn = ?`,
              )
              .bind(now, expiresAt, healthSystemId, storedCsn),
          );
          continue;
        }

        report.written += 1;
        const payloadEnc = await seal(
          ctx.env,
          plaintext,
          portalVisitAad(healthSystemId, storedCsn),
        );
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO portal_visits
                 (health_system_id, csn, payload_enc, content_hash, status, state,
                  missing_since, fetched_at, expires_at)
               VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?)
               ON CONFLICT (health_system_id, csn) DO UPDATE SET
                 payload_enc = excluded.payload_enc,
                 content_hash = excluded.content_hash,
                 status = excluded.status,
                 state = 'active',
                 missing_since = NULL,
                 fetched_at = excluded.fetched_at,
                 expires_at = excluded.expires_at`,
            )
            .bind(healthSystemId, storedCsn, payloadEnc, hash, visit.status, now, expiresAt),
        );
      }

      if (options.complete) {
        const gone = await stillAhead(
          known.filter((row) => !byCsn.has(row.csn) && row.state === "active"),
          now,
        );
        report.missing += gone.length;
        for (const storedCsn of gone) {
          statements.push(
            ctx.db
              .prepare(
                `UPDATE portal_visits SET state = 'missing', missing_since = ?
                  WHERE health_system_id = ? AND csn = ?`,
              )
              .bind(now, healthSystemId, storedCsn),
          );
        }
      }

      for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
      ctx.log.info("portal_visits.recorded", { healthSystemId, ...report });
      return report;
    },

    /** Every live visit for one health system, earliest first. */
    async list(healthSystemId: string): Promise<StoredPortalVisit[]> {
      const rows = await all<PortalVisitRow>(
        ctx.db
          .prepare(`SELECT * FROM portal_visits WHERE health_system_id = ? AND expires_at > ?`)
          .bind(healthSystemId, ctx.now()),
      );
      const decoded = await Promise.all(rows.map((row) => decode(row)));
      // Sorted in place: `decoded` is this call's own array. The start is sealed, so
      // the order `ORDER BY start_at` used to give is applied here.
      decoded.sort(byStart);
      return decoded;
    },

    /**
     * Every live visit of every health system but one: what the portal pass compares a
     * health system's visits against to find the ones another organisation's record
     * already covers (`worker/sync/portal-dedupe.ts`).
     */
    async listExcept(healthSystemId: string): Promise<StoredPortalVisit[]> {
      const rows = await all<PortalVisitRow>(
        ctx.db
          .prepare(`SELECT * FROM portal_visits WHERE health_system_id <> ? AND expires_at > ?`)
          .bind(healthSystemId, ctx.now()),
      );
      const decoded = await Promise.all(rows.map((row) => decode(row)));
      // Sorted in place: `decoded` is this call's own array. The start is sealed, so
      // the order `ORDER BY start_at` used to give is applied here.
      decoded.sort(byStart);
      return decoded;
    },

    /** Drop everything past its expiry. Called from the scheduled handler. */
    async purgeExpired(): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM portal_visits WHERE expires_at <= ?").bind(ctx.now()),
      );
      return changes;
    },

    /** Forget every stored visit for one health system, e.g. on disconnect. */
    async clearHealthSystem(healthSystemId: string): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM portal_visits WHERE health_system_id = ?").bind(healthSystemId),
      );
      return changes;
    },
  };
}
