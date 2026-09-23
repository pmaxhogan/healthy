/**
 * `portal_visits`: the portal pass's own copy of the upcoming visits it saw.
 *
 * The calendar is not something the MCP can read, and Epic's patient FHIR view
 * never returns an Encounter before the visit happens -- so without this table a
 * question about what is coming up has no answer outside the owner's calendar.
 * The portal pass writes every visit `LoadUpcoming` returned, every run; the MCP
 * (`worker/mcp/appointment-items.ts`) reads them back.
 *
 * `payload_enc` is sealed against `portal_visits.payload_enc.<providerId>:<csn>`
 * -- the composite row id, because the primary key is composite -- so a payload
 * copied onto another visit's row, or another provider's, fails to open.
 *
 * `content_hash` is the sha256 of the plaintext, for the same reason
 * `fhir_cache` keeps one: sealing is randomised, so it is the only way to tell an
 * unchanged visit from an updated one without re-sealing every row every hour.
 *
 * The "missing" rule is the calendar's ghost rule, restated for a table: a visit
 * the portal stops returning while it is still ahead is marked `missing` (as far
 * as anyone can tell, it was cancelled); one that stops being returned after its
 * start time is simply over and is left exactly as it was.
 */

import { BATCH_CHUNK, all, batch, chunk, run, sha256Hex } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { PortalVisit } from "../../providers/mychart/index.ts";
import type { Ctx } from "../client.ts";
import type { PortalVisitRow, PortalVisitState } from "../rows.ts";

/** How long a visit is kept after it happens (or after it was last seen, if later). */
const PORTAL_VISIT_RETENTION_SECONDS = 365 * 24 * 3600;

/** Rows one `list` reads. Far above any real schedule, like `MAX_PORTAL_ROWS`. */
const LIST_LIMIT = 500;

const aad = (providerId: string, csn: string): string =>
  aadFor("portal_visits", "payload_enc", `${providerId}:${csn}`);

/** A stored visit, opened. */
export interface StoredPortalVisit {
  providerId: string;
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
   * False when the list is known to be incomplete -- the parse stopped at
   * `MAX_PARSED_VISITS` -- so absence from it proves nothing and no row is
   * marked missing.
   */
  complete: boolean;
}

/** Unix seconds from a visit's ISO start, or null when it does not parse. */
function startSeconds(visit: PortalVisit): number | null {
  const ms = Date.parse(visit.start);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function makePortalVisitsRepo(ctx: Ctx) {
  return {
    /**
     * Store every visit one `LoadUpcoming` returned, and mark the future ones it
     * stopped returning as missing.
     *
     * A visit that is back after being missing is `active` again. An unchanged
     * visit only has its timestamps moved.
     */
    async record(
      providerId: string,
      visits: readonly PortalVisit[],
      options: RecordVisitsOptions,
    ): Promise<RecordVisitsReport> {
      const now = ctx.now();
      const report: RecordVisitsReport = { written: 0, unchanged: 0, missing: 0 };
      const known = await all<Pick<PortalVisitRow, "csn" | "content_hash" | "state" | "start_at">>(
        ctx.db
          .prepare(
            "SELECT csn, content_hash, state, start_at FROM portal_visits WHERE provider_id = ?",
          )
          .bind(providerId),
      );
      const existing = new Map(known.map((row) => [row.csn, row]));

      // One row per CSN, the last sighting winning: a visit can in principle sit in
      // two buckets of the same payload, and two upserts of one key in a batch
      // would only make the report lie.
      const byCsn = new Map<string, PortalVisit>();
      for (const visit of visits) byCsn.set(visit.csn, visit);

      const statements: D1PreparedStatement[] = [];
      for (const [csn, visit] of byCsn) {
        const start = startSeconds(visit);
        if (start === null) continue;
        const expiresAt = Math.max(start, now) + PORTAL_VISIT_RETENTION_SECONDS;
        const plaintext = JSON.stringify(visit);
        const hash = await sha256Hex(plaintext);
        const prior = existing.get(csn);

        if (prior?.content_hash === hash && prior.state === "active") {
          report.unchanged += 1;
          statements.push(
            ctx.db
              .prepare(
                `UPDATE portal_visits SET fetched_at = ?, expires_at = ?
                  WHERE provider_id = ? AND csn = ?`,
              )
              .bind(now, expiresAt, providerId, csn),
          );
          continue;
        }

        report.written += 1;
        const payloadEnc = await seal(ctx.env, plaintext, aad(providerId, csn));
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO portal_visits
                 (provider_id, csn, payload_enc, content_hash, start_at, status, state,
                  missing_since, fetched_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
               ON CONFLICT (provider_id, csn) DO UPDATE SET
                 payload_enc = excluded.payload_enc,
                 content_hash = excluded.content_hash,
                 start_at = excluded.start_at,
                 status = excluded.status,
                 state = 'active',
                 missing_since = NULL,
                 fetched_at = excluded.fetched_at,
                 expires_at = excluded.expires_at`,
            )
            .bind(providerId, csn, payloadEnc, hash, start, visit.status, now, expiresAt),
        );
      }

      if (options.complete) {
        for (const row of known) {
          if (byCsn.has(row.csn) || row.state !== "active" || row.start_at <= now) continue;
          report.missing += 1;
          statements.push(
            ctx.db
              .prepare(
                `UPDATE portal_visits SET state = 'missing', missing_since = ?
                  WHERE provider_id = ? AND csn = ?`,
              )
              .bind(now, providerId, row.csn),
          );
        }
      }

      for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
      ctx.log.info("portal_visits.recorded", { providerId, ...report });
      return report;
    },

    /** Every live visit for one provider, earliest first. */
    async list(providerId: string): Promise<StoredPortalVisit[]> {
      const rows = await all<PortalVisitRow>(
        ctx.db
          .prepare(
            `SELECT * FROM portal_visits WHERE provider_id = ? AND expires_at > ?
              ORDER BY start_at, csn LIMIT ?`,
          )
          .bind(providerId, ctx.now(), LIST_LIMIT),
      );
      return Promise.all(
        rows.map(async (row) => ({
          providerId: row.provider_id,
          csn: row.csn,
          visit: JSON.parse(
            await open(ctx.env, row.payload_enc, aad(row.provider_id, row.csn)),
          ) as PortalVisit,
          state: row.state,
          missingSince: row.missing_since,
          fetchedAt: row.fetched_at,
        })),
      );
    },

    /** Drop everything past its expiry. Called from the scheduled handler. */
    async purgeExpired(): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM portal_visits WHERE expires_at <= ?").bind(ctx.now()),
      );
      return changes;
    },

    /** Forget every stored visit for one provider, e.g. on disconnect. */
    async clearProvider(providerId: string): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM portal_visits WHERE provider_id = ?").bind(providerId),
      );
      return changes;
    },
  };
}
