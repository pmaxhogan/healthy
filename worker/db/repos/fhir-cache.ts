/**
 * The read cache of FHIR resources that the MCP serves from.
 *
 * This is the PHI-bearing table, so `payload_enc` is sealed against
 * `fhir_cache.payload.<providerId>:<type>:<id>` -- the composite row id, because
 * the primary key is composite. A payload lifted from one patient's row to
 * another's fails to open.
 *
 * `content_hash` is the sha256 of the *plaintext*. Sealing is randomised, so two
 * seals of an unchanged resource differ byte for byte and cannot be compared;
 * hashing the plaintext is what lets a daily refresh tell "unchanged" from
 * "updated" and report a meaningful count.
 */

import { BATCH_CHUNK, all, batch, chunk, one, run, sha256Hex, ttlSeconds } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";

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
const aad = (providerId: string, resourceType: string, resourceId: string): string =>
  aadFor("fhir_cache", "payload", `${providerId}:${resourceType}:${resourceId}`);

export interface UpsertReport {
  written: number;
  unchanged: number;
}

export function makeFhirCacheRepo(ctx: Ctx) {
  const decode = async (row: FhirCacheRow): Promise<CachedResource> => ({
    providerId: row.provider_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    lastUpdated: row.last_updated,
    fetchedAt: row.fetched_at,
    resource: JSON.parse(
      await open(
        ctx.env,
        row.payload_enc,
        aad(row.provider_id, row.resource_type, row.resource_id),
      ),
    ),
  });

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
        const hash = await sha256Hex(plaintext);
        const lastUpdated = parseLastUpdated(resource.meta?.lastUpdated);

        // security/detect-possible-timing-attacks warns because the variable is
        // called `hash`: it is a content digest for change detection, not a secret.
        if (existing.get(`${resource.resourceType}:${resource.id}`) === hash) {
          report.unchanged += 1;
          statements.push(
            ctx.db
              .prepare(
                `UPDATE fhir_cache SET fetched_at = ?, expires_at = ?
                  WHERE provider_id = ? AND resource_type = ? AND resource_id = ?`,
              )
              .bind(fetchedAt, expiresAt, providerId, resource.resourceType, resource.id),
          );
          continue;
        }

        report.written += 1;
        const payloadEnc = await seal(
          ctx.env,
          plaintext,
          aad(providerId, resource.resourceType, resource.id),
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
              resource.id,
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

    /** One resource, or null when it is absent or past its expiry. */
    async get(
      providerId: string,
      resourceType: string,
      resourceId: string,
    ): Promise<CachedResource | null> {
      const row = await one<FhirCacheRow>(
        ctx.db
          .prepare(
            `SELECT * FROM fhir_cache
              WHERE provider_id = ? AND resource_type = ? AND resource_id = ? AND expires_at > ?`,
          )
          .bind(providerId, resourceType, resourceId, ctx.now()),
      );
      return row === null ? null : decode(row);
    },

    /**
     * Every live resource of one type, optionally for a single provider.
     *
     * `providerId: null` is how a cross-provider MCP tool asks for all of them.
     * `since` filters on the org's own `meta.lastUpdated` where it gave one,
     * falling back to when we fetched it.
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
      const limit = options.limit ?? 500;
      const rows = await all<FhirCacheRow>(
        ctx.db
          .prepare(
            `SELECT * FROM fhir_cache WHERE ${clauses.join(" AND ")}
              ORDER BY COALESCE(last_updated, fetched_at) DESC, resource_id
              LIMIT ?`,
          )
          .bind(...values, limit),
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
