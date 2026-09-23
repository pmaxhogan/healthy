/**
 * The connected health systems.
 *
 * Deletion is soft: `calendar_events` and `fhir_cache` reference a health system, and
 * a hard delete would cascade away the history of events already written to the
 * calendar. `list()` therefore hides deleted rows unless asked.
 *
 * `client_secret_enc` is the per-organisation confidential-client secret. It is
 * sealed against `providers.client_secret_enc.<id>`, so it cannot be read from a
 * D1 dump and cannot be moved to another health system's row.
 *
 * The identity columns -- `display_name`, `fhir_base_url`, `brand_key`,
 * `portal_url` and `config_json` -- are sealed in place (0007), padded, against
 * `health_systems.<column>.<id>`: each one names the organisation, directly, through
 * the public brands index, or (the config's `org_short` and title template) in
 * words the owner typed. Nothing filters or orders on them in SQL
 * (the `health_systems_live` index is on `deleted_at, vendor`), so the list is sorted
 * after it is opened. A repo instance opens each row once and reuses the result
 * until the row's `updated_at` moves, so a sync run that reads the same health system
 * five times decrypts it once. The columns carry `_enc` names since 0009; the
 * AAD keeps the name each value was first sealed under
 * (`health_systems.<plain name>.<id>`), because the AAD is part of the tag.
 */

import { AppError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { aadFor, open, sealShort } from "../crypto.ts";
import { parseJsonColumn, healthSystemConfigSchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { HealthSystemDbRow, HealthSystemEnvironment, HealthSystemRow } from "../rows.ts";
import type { HealthSystemConfig, HealthSystemConfigInput } from "../schemas.ts";

interface CreateHealthSystem {
  vendor: string;
  displayName: string;
  fhirBaseUrl: string;
  brandKey?: string | null;
  portalUrl?: string | null;
  environment?: HealthSystemEnvironment;
  config?: HealthSystemConfigInput;
  /** Sealed before it is written; never stored in the clear. */
  clientSecret?: string;
}

interface UpdateHealthSystem {
  displayName?: string;
  fhirBaseUrl?: string;
  brandKey?: string | null;
  portalUrl?: string | null;
  environment?: HealthSystemEnvironment;
  config?: HealthSystemConfigInput;
}

const SELECT = "SELECT * FROM health_systems";

const secretAad = (id: string): string => aadFor("providers", "client_secret_enc", id);

/** The identity fields, by the name their AAD was bound to. */
type IdentityColumn = "display_name" | "fhir_base_url" | "brand_key" | "portal_url" | "config_json";

/** Which stored column holds each identity field. */
const STORED: Record<IdentityColumn, string> = {
  display_name: "display_name_enc",
  fhir_base_url: "fhir_base_url_enc",
  brand_key: "brand_key_enc",
  portal_url: "portal_url_enc",
  config_json: "config_enc",
};

const healthSystemIdentityAad = (column: IdentityColumn, id: string): string =>
  aadFor("providers", column, id);

export function makeHealthSystemsRepo(ctx: Ctx) {
  const sealIdentity = (column: IdentityColumn, id: string, value: string) =>
    sealShort(ctx.env, value, healthSystemIdentityAad(column, id));
  const sealNullable = (column: IdentityColumn, id: string, value: string | null) =>
    value === null ? null : sealIdentity(column, id, value);
  const openIdentity = (column: IdentityColumn, id: string, value: string) =>
    open(ctx.env, value, healthSystemIdentityAad(column, id));

  // Opened rows, by id, valid while `updated_at` is unchanged. Per repo
  // instance, and repos are built per request or per run.
  const opened = new Map<string, { updatedAt: number; row: Promise<HealthSystemRow> }>();

  const decodeFresh = async (row: HealthSystemDbRow): Promise<HealthSystemRow> => {
    const {
      display_name_enc: displayName,
      fhir_base_url_enc: fhirBaseUrl,
      brand_key_enc: brandKey,
      portal_url_enc: portalUrl,
      config_enc: config,
      ...plain
    } = row;
    return {
      ...plain,
      display_name: await openIdentity("display_name", row.id, displayName),
      fhir_base_url: await openIdentity("fhir_base_url", row.id, fhirBaseUrl),
      brand_key: brandKey === null ? null : await openIdentity("brand_key", row.id, brandKey),
      portal_url: portalUrl === null ? null : await openIdentity("portal_url", row.id, portalUrl),
      config_json: await openIdentity("config_json", row.id, config),
    };
  };

  const decode = (row: HealthSystemDbRow): Promise<HealthSystemRow> => {
    const cached = opened.get(row.id);
    if (cached?.updatedAt === row.updated_at) {
      // The plaintext columns (deletion, timestamps) come from the row just read;
      // only the opened values come from the cache.
      return withIdentity(row, cached.row);
    }
    const fresh = decodeFresh(row);
    opened.set(row.id, { updatedAt: row.updated_at, row: fresh });
    void fresh.catch(() => opened.delete(row.id));
    return fresh;
  };

  const byId = async (id: string): Promise<HealthSystemRow | null> => {
    const row = await one<HealthSystemDbRow>(ctx.db.prepare(`${SELECT} WHERE id = ?`).bind(id));
    return row === null ? null : decode(row);
  };

  const require_ = async (id: string): Promise<HealthSystemRow> => {
    const row = await byId(id);
    if (row === null) throw new AppError("not_found", "no such health system");
    return row;
  };

  return {
    async create(input: CreateHealthSystem): Promise<HealthSystemRow> {
      const id = newId();
      const at = ctx.now();
      const config = healthSystemConfigSchema.parse(input.config ?? {});
      const configEnc = await sealIdentity("config_json", id, JSON.stringify(config));
      const clientSecretEnc =
        input.clientSecret === undefined
          ? null
          : await sealShort(ctx.env, input.clientSecret, secretAad(id));
      await run(
        ctx.db
          .prepare(
            `INSERT INTO health_systems
               (id, vendor, display_name_enc, brand_key_enc, fhir_base_url_enc, portal_url_enc,
                environment, client_secret_enc, config_enc, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            input.vendor,
            await sealIdentity("display_name", id, input.displayName),
            await sealNullable("brand_key", id, input.brandKey ?? null),
            await sealIdentity("fhir_base_url", id, input.fhirBaseUrl),
            await sealNullable("portal_url", id, input.portalUrl ?? null),
            input.environment ?? "prod",
            clientSecretEnc,
            configEnc,
            at,
            at,
          ),
      );
      ctx.log.info("health_systems.created", { healthSystemId: id, vendor: input.vendor });
      return require_(id);
    },

    /** Patch the columns present in `patch`; absent ones are left alone. */
    async update(id: string, patch: UpdateHealthSystem): Promise<HealthSystemRow | null> {
      const existing = await byId(id);
      if (existing === null) return null;

      const sets: string[] = [];
      const values: unknown[] = [];
      const put = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.displayName !== undefined) {
        put(STORED.display_name, await sealIdentity("display_name", id, patch.displayName));
      }
      if (patch.fhirBaseUrl !== undefined) {
        put(STORED.fhir_base_url, await sealIdentity("fhir_base_url", id, patch.fhirBaseUrl));
      }
      if (patch.brandKey !== undefined) {
        put(STORED.brand_key, await sealNullable("brand_key", id, patch.brandKey));
      }
      if (patch.portalUrl !== undefined) {
        put(STORED.portal_url, await sealNullable("portal_url", id, patch.portalUrl));
      }
      if (patch.environment !== undefined) put("environment", patch.environment);
      if (patch.config !== undefined) {
        // Replace rather than merge: the admin UI always sends the whole config,
        // and a merge would make removing an override impossible.
        const json = JSON.stringify(healthSystemConfigSchema.parse(patch.config));
        put(STORED.config_json, await sealIdentity("config_json", id, json));
      }
      put("updated_at", ctx.now());

      await run(
        ctx.db
          .prepare(`UPDATE health_systems SET ${sets.join(", ")} WHERE id = ?`)
          .bind(...values, id),
      );
      // `updated_at` has second resolution, so a write in the same second as the
      // cached read would otherwise look unchanged.
      opened.delete(id);
      return byId(id);
    },

    get: byId,

    async list(options: { includeDeleted?: boolean } = {}): Promise<HealthSystemRow[]> {
      const where = options.includeDeleted ? "" : " WHERE deleted_at IS NULL";
      const rows = await all<HealthSystemDbRow>(ctx.db.prepare(`${SELECT}${where}`));
      const decoded = await Promise.all(rows.map((row) => decode(row)));
      // The name is sealed, so the order the admin UI shows is applied here.
      // Sorted in place: `decoded` is this call's own array.
      decoded.sort((a, b) => byName(a.display_name, b.display_name) || byName(a.id, b.id));
      return decoded;
    },

    /** Stop syncing a health system without losing what it has already produced. */
    async softDelete(id: string): Promise<boolean> {
      const at = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            "UPDATE health_systems SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
          )
          .bind(at, at, id),
      );
      if (changes > 0) ctx.log.info("health_systems.soft_deleted", { healthSystemId: id });
      return changes > 0;
    },

    async setClientSecret(id: string, secret: string): Promise<void> {
      await require_(id);
      const sealed = await sealShort(ctx.env, secret, secretAad(id));
      await run(
        ctx.db
          .prepare("UPDATE health_systems SET client_secret_enc = ?, updated_at = ? WHERE id = ?")
          .bind(sealed, ctx.now(), id),
      );
    },

    /** The decrypted secret, or null when the health system has none yet. */
    async getClientSecret(id: string): Promise<string | null> {
      const row = await require_(id);
      return row.client_secret_enc === null
        ? null
        : open(ctx.env, row.client_secret_enc, secretAad(id));
    },

    /** The parsed per-health system overrides, defaults applied. */
    async getConfig(id: string): Promise<HealthSystemConfig> {
      const row = await require_(id);
      return parseJsonColumn(
        healthSystemConfigSchema,
        row.config_json,
        `health_systems.config_json.${id}`,
      );
    },
  };
}

/** `row` with the identity columns of an already-opened copy of it. */
async function withIdentity(
  row: HealthSystemDbRow,
  opened: Promise<HealthSystemRow>,
): Promise<HealthSystemRow> {
  return {
    ...(await opened),
    vendor: row.vendor,
    environment: row.environment,
    client_secret_enc: row.client_secret_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

/** Byte order, which is what SQLite's default `ORDER BY` on TEXT gave. */
function byName(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
