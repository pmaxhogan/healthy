/**
 * The read cache of FHIR resources that the MCP serves from.
 *
 * This is the PHI-bearing table, so `payload_enc` is sealed against
 * `fhir_cache.payload.<providerId>:<type>:<resource_id>` -- the composite row id,
 * because the primary key is composite. A payload lifted from one patient's row
 * to another's fails to open.
 *
 * `resource_id` is not the upstream id. It is `blindResourceId(...)`, a keyed
 * HMAC of the health system, the type and the Epic id (`worker/db/blind.ts`), so
 * the cache is still keyed and indexed by it but a D1 snapshot no longer carries
 * the patient's own FHIR id (the Patient row) or the id-prefix structure of
 * everything else. Every lookup blinds the id it is given, which is what lets an
 * MCP tool take a real id as its argument; the real id is only inside the sealed
 * payload, and that is what `CachedResource.resourceId` reports.
 *
 * `content_hash` is a keyed digest of the *plaintext*. Sealing is randomised, so
 * two seals of an unchanged resource differ byte for byte and cannot be
 * compared; a digest of the plaintext is what lets a daily refresh tell
 * "unchanged" from "updated" and report a meaningful count. Keyed rather than a
 * plain sha256, which would be a confirmation oracle for anyone who can guess a
 * resource, and bound to the health system, so the same document under two
 * organisations does not link them.
 *
 * A row written before 0007 still has the upstream id and a hex sha256 here; the
 * backfill (`worker/sync/backfill.ts`) rewrites it. Until then `decode` opens it
 * under its old AAD and `get` finds it by its old id.
 */

import { blindResourceId, blinderFor, isBlinded } from "../blind.ts";
import { BATCH_CHUNK, all, batch, chunk, run, ttlSeconds } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

import type { Blinder } from "../blind.ts";
import type { Ctx } from "../client.ts";
import type { FhirCacheRow } from "../rows.ts";

/** The little a cache write needs to know about a FHIR resource. */
export interface CacheableResource {
  resourceType: string;
  id: string;
  meta?: { lastUpdated?: string | undefined } | undefined;
  [key: string]: unknown;
}

/** A resource read back out of the cache. */
export interface CachedResource {
  providerId: string;
  resourceType: string;
  resourceId: string;
  /** Unix second from `meta.lastUpdated`, when the org supplied one. */
  lastUpdated: number | null;
  fetchedAt: number;
  resource: unknown;
}

/**
 * The AAD for one cached payload.
 *
 * The column name here is `payload`, but the column is `payload_enc`. That is a
 * mismatch with every other `aadFor` call in the db layer, and it is deliberate
 * now: the AAD is part of the ciphertext's authentication tag, so "correcting" it
 * would make every row already in the cache fail to open. If it is ever worth
 * fixing it has to be a migration that re-seals, not an edit here.
 */
export const fhirCacheAad = (providerId: string, resourceType: string, storedId: string): string =>
  aadFor("fhir_cache", "payload", `${providerId}:${resourceType}:${storedId}`);

/** The stored digest of one plaintext payload. */
export function fhirCacheDigest(
  blinder: Blinder,
  providerId: string,
  plaintext: string,
): Promise<string> {
  return blinder.digest("fhir_cache.content_hash", `${providerId}\u{0}${plaintext}`);
}

/** The payload's own `id`, which is the real upstream id. */
function payloadId(resource: unknown): string | null {
  if (typeof resource !== "object" || resource === null || !("id" in resource)) return null;
  const id = (resource as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}

export interface UpsertReport {
  written: number;
  unchanged: number;
}

export function makeFhirCacheRepo(ctx: Ctx) {
  const blinder = blinderFor(ctx.env);
  const blindId = (providerId: string, resourceType: string, resourceId: string) =>
    blindResourceId(blinder, providerId, resourceType, resourceId);

  const decode = async (row: FhirCacheRow): Promise<CachedResource> => {
    // Both shapes open under the id the row is stored by: the blind for a row
    // written since 0007, the upstream id for one the backfill has not reached.
    const resource: unknown = JSON.parse(
      await open(
        ctx.env,
        row.payload_enc,
        fhirCacheAad(row.provider_id, row.resource_type, row.resource_id),
      ),
    );
    const realId = payloadId(resource) ?? (isBlinded(row.resource_id) ? "" : row.resource_id);
    return {
      providerId: row.provider_id,
      resourceType: row.resource_type,
      resourceId: realId,
      lastUpdated: row.last_updated,
      fetchedAt: row.fetched_at,
      resource,
    };
  };

  const getStored = async (
    providerId: string,
    resourceType: string,
    storedIds: readonly string[],
  ): Promise<CachedResource | null> => {
    const placeholders = storedIds.map(() => "?").join(", ");
    const rows = await all<FhirCacheRow>(
      ctx.db
        .prepare(
          `SELECT * FROM fhir_cache
            WHERE provider_id = ? AND resource_type = ? AND resource_id IN (${placeholders})
              AND expires_at > ?`,
        )
        .bind(providerId, resourceType, ...storedIds, ctx.now()),
    );
    // The blinded row wins while the backfill has not yet removed a legacy twin.
    const row = rows.find((candidate) => isBlinded(candidate.resource_id)) ?? rows[0];
    return row === undefined ? null : decode(row);
  };

  return {
    /**
     * Seal and store a page of resources, extending the expiry of the ones whose
     * content has not changed rather than rewriting them.
     *
     * Statements are chunked because a full refresh can hand this thousands of
     * resources at once and D1 caps a batch.
     */
    async upsertMany(
      providerId: string,
      resources: readonly CacheableResource[],
      ttlMs: number,
    ): Promise<UpsertReport> {
      if (resources.length === 0) return { written: 0, unchanged: 0 };
      const fetchedAt = ctx.now();
      const expiresAt = fetchedAt + ttlSeconds(ttlMs);
      const report: UpsertReport = { written: 0, unchanged: 0 };

      const known = await all<Pick<FhirCacheRow, "resource_type" | "resource_id" | "content_hash">>(
        ctx.db
          .prepare(
            "SELECT resource_type, resource_id, content_hash FROM fhir_cache WHERE provider_id = ?",
          )
          .bind(providerId),
      );
      const existing = new Map<string, string>();
      for (const row of known) {
        existing.set(`${row.resource_type}:${row.resource_id}`, row.content_hash);
      }

      const statements: D1PreparedStatement[] = [];
      for (const resource of resources) {
        const plaintext = JSON.stringify(resource);
        const hash = await fhirCacheDigest(blinder, providerId, plaintext);
        const storedId = await blindId(providerId, resource.resourceType, resource.id);
        const lastUpdated = parseLastUpdated(resource.meta?.lastUpdated);

        // security/detect-possible-timing-attacks warns because the variable is
        // called `hash`: it is a content digest for change detection, not a secret.
        if (existing.get(`${resource.resourceType}:${storedId}`) === hash) {
          report.unchanged += 1;
          statements.push(
            ctx.db
              .prepare(
                `UPDATE fhir_cache SET fetched_at = ?, expires_at = ?
                  WHERE provider_id = ? AND resource_type = ? AND resource_id = ?`,
              )
              .bind(fetchedAt, expiresAt, providerId, resource.resourceType, storedId),
          );
          continue;
        }

        report.written += 1;
        const payloadEnc = await seal(
          ctx.env,
          plaintext,
          fhirCacheAad(providerId, resource.resourceType, storedId),
        );
        statements.push(
          ctx.db
            .prepare(
              `INSERT INTO fhir_cache
                 (provider_id, resource_type, resource_id, payload_enc, content_hash,
                  last_updated, fetched_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (provider_id, resource_type, resource_id) DO UPDATE SET
                 payload_enc = excluded.payload_enc,
                 content_hash = excluded.content_hash,
                 last_updated = excluded.last_updated,
                 fetched_at = excluded.fetched_at,
                 expires_at = excluded.expires_at`,
            )
            .bind(
              providerId,
              resource.resourceType,
              storedId,
              payloadEnc,
              hash,
              lastUpdated,
              fetchedAt,
              expiresAt,
            ),
        );
      }

      for (const page of chunk(statements, BATCH_CHUNK)) await batch(ctx.db, page);
      ctx.log.info("fhir_cache.upserted", { providerId, ...report });
      return report;
    },

    /**
     * One resource by its upstream id, or null when it is absent or past its
     * expiry. The id is blinded here, on the way in -- which is how an MCP tool
     * that takes an id finds it -- and the caller never sees the stored form.
     * The upstream id is looked up as well, for a row the 0007 backfill has not
     * rewritten yet: a query parameter, never stored.
     */
    async get(
      providerId: string,
      resourceType: string,
      resourceId: string,
    ): Promise<CachedResource | null> {
      const storedId = await blindId(providerId, resourceType, resourceId);
      return getStored(providerId, resourceType, [storedId, resourceId]);
    },

    /**
     * One resource by its *stored* id: what `calendar_events.encounter_id` holds,
     * which is the same blind this table keys the Encounter by.
     */
    async getByStoredId(
      providerId: string,
      resourceType: string,
      storedId: string,
    ): Promise<CachedResource | null> {
      return getStored(providerId, resourceType, [storedId]);
    },

    /**
     * Every live resource of one type, optionally for a single provider.
     *
     * `providerId: null` is how a cross-provider MCP tool asks for all of them.
     * `since` filters on the org's own `meta.lastUpdated` where it gave one,
     * falling back to when we fetched it. `limit` is omitted by every caller in
     * this codebase -- an MCP tool's own `limit` argument is applied later, in
     * `respond()`, after the policy filter -- so there is no `LIMIT` clause at
     * all unless a caller actually wants one: the owner's whole record is what
     * "every live resource of one type" means.
     */
    async listByType(
      providerId: string | null,
      resourceType: string,
      options: { since?: number; limit?: number } = {},
    ): Promise<CachedResource[]> {
      const clauses = ["resource_type = ?", "expires_at > ?"];
      const values: unknown[] = [resourceType, ctx.now()];
      if (providerId !== null) {
        clauses.push("provider_id = ?");
        values.push(providerId);
      }
      if (options.since !== undefined) {
        clauses.push("COALESCE(last_updated, fetched_at) >= ?");
        values.push(options.since);
      }
      const limitClause = options.limit === undefined ? "" : " LIMIT ?";
      if (options.limit !== undefined) values.push(options.limit);
      const rows = await all<FhirCacheRow>(
        ctx.db
          .prepare(
            `SELECT * FROM fhir_cache WHERE ${clauses.join(" AND ")}
              ORDER BY COALESCE(last_updated, fetched_at) DESC, resource_id${limitClause}`,
          )
          .bind(...values),
      );
      return Promise.all(rows.map((row) => decode(row)));
    },

    /** Drop everything past its expiry. Called from the scheduled handler. */
    async purgeExpired(): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM fhir_cache WHERE expires_at <= ?").bind(ctx.now()),
      );
      return changes;
    },

    /** Live row counts per provider and type. Feeds the overview and get_health_summary. */
    async countsByType(): Promise<{ providerId: string; resourceType: string; count: number }[]> {
      const rows = await all<{ provider_id: string; resource_type: string; n: number }>(
        ctx.db
          .prepare(
            `SELECT provider_id, resource_type, COUNT(*) AS n FROM fhir_cache
              WHERE expires_at > ?
              GROUP BY provider_id, resource_type
              ORDER BY provider_id, resource_type`,
          )
          .bind(ctx.now()),
      );
      return rows.map((row) => ({
        providerId: row.provider_id,
        resourceType: row.resource_type,
        count: row.n,
      }));
    },

    /** Forget everything cached for one provider, e.g. on disconnect. */
    async clearProvider(providerId: string): Promise<number> {
      const { changes } = await run(
        ctx.db.prepare("DELETE FROM fhir_cache WHERE provider_id = ?").bind(providerId),
      );
      return changes;
    },
  };
}

function parseLastUpdated(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  // A malformed meta.lastUpdated is the org's problem, not a reason to drop the
  // resource: the column simply stays null and fetched_at is used instead.
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
