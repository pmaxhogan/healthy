/**
 * The connected health systems.
 *
 * Deletion is soft: `calendar_events` and `fhir_cache` reference a provider, and
 * a hard delete would cascade away the history of events already written to the
 * calendar. `list()` therefore hides deleted rows unless asked.
 *
 * `client_secret_enc` is the per-organisation confidential-client secret. It is
 * sealed against `providers.client_secret_enc.<id>`, so it cannot be read from a
 * D1 dump and cannot be moved to another provider's row.
 *
 * The identity columns -- `display_name`, `fhir_base_url`, `brand_key`,
 * `portal_url` and `config_json` -- are sealed in place (0007), padded, against
 * `providers.<column>.<id>`: each one names the organisation, directly, through
 * the public brands index, or (the config's `org_short` and title template) in
 * words the owner typed. Nothing filters or orders on them in SQL
 * (the `providers_live` index is on `deleted_at, vendor`), so the list is sorted
 * after it is opened. A repo instance opens each row once and reuses the result
 * until the row's `updated_at` moves, so a sync run that reads the same provider
 * five times decrypts it once. A row the backfill has not reached is still
 * plaintext and reads either way; the rename migration moves the columns to
 * `_enc` names.
 */

import { AppError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { aadFor, open, openLegacy, sealShort } from "../crypto.ts";
import { parseJsonColumn, providerConfigSchema } from "../schemas.ts";

import type { Ctx } from "../client.ts";
import type { ProviderEnvironment, ProviderRow } from "../rows.ts";
import type { ProviderConfig, ProviderConfigInput } from "../schemas.ts";

interface CreateProvider {
  vendor: string;
  displayName: string;
  fhirBaseUrl: string;
  brandKey?: string | null;
  portalUrl?: string | null;
  environment?: ProviderEnvironment;
  config?: ProviderConfigInput;
  /** Sealed before it is written; never stored in the clear. */
  clientSecret?: string;
}

interface UpdateProvider {
  displayName?: string;
  fhirBaseUrl?: string;
  brandKey?: string | null;
  portalUrl?: string | null;
  environment?: ProviderEnvironment;
  config?: ProviderConfigInput;
}

const SELECT = "SELECT * FROM providers";

const secretAad = (id: string): string => aadFor("providers", "client_secret_enc", id);

/** The identity columns, sealed in place. */
export const PROVIDER_IDENTITY_COLUMNS = [
  "display_name",
  "fhir_base_url",
  "brand_key",
  "portal_url",
  "config_json",
] as const;
type IdentityColumn = (typeof PROVIDER_IDENTITY_COLUMNS)[number];

export const providerIdentityAad = (column: IdentityColumn, id: string): string =>
  aadFor("providers", column, id);

export function makeProvidersRepo(ctx: Ctx) {
  const sealIdentity = (column: IdentityColumn, id: string, value: string) =>
    sealShort(ctx.env, value, providerIdentityAad(column, id));
  const sealNullable = (column: IdentityColumn, id: string, value: string | null) =>
    value === null ? null : sealIdentity(column, id, value);
  const openIdentity = (column: IdentityColumn, id: string, value: string) =>
    openLegacy(ctx.env, value, providerIdentityAad(column, id));

  // Opened rows, by id, valid while `updated_at` is unchanged. Per repo
  // instance, and repos are built per request or per run.
  const opened = new Map<string, { updatedAt: number; row: Promise<ProviderRow> }>();

  const decodeFresh = async (row: ProviderRow): Promise<ProviderRow> => ({
    ...row,
    display_name: await openIdentity("display_name", row.id, row.display_name),
    fhir_base_url: await openIdentity("fhir_base_url", row.id, row.fhir_base_url),
    brand_key:
      row.brand_key === null ? null : await openIdentity("brand_key", row.id, row.brand_key),
    portal_url:
      row.portal_url === null ? null : await openIdentity("portal_url", row.id, row.portal_url),
    config_json: await openIdentity("config_json", row.id, row.config_json),
  });

  const decode = (row: ProviderRow): Promise<ProviderRow> => {
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

  const byId = async (id: string): Promise<ProviderRow | null> => {
    const row = await one<ProviderRow>(ctx.db.prepare(`${SELECT} WHERE id = ?`).bind(id));
    return row === null ? null : decode(row);
  };

  const require_ = async (id: string): Promise<ProviderRow> => {
    const row = await byId(id);
    if (row === null) throw new AppError("not_found", "no such provider");
    return row;
  };

  return {
    async create(input: CreateProvider): Promise<ProviderRow> {
      const id = newId();
      const at = ctx.now();
      const config = providerConfigSchema.parse(input.config ?? {});
      const configEnc = await sealIdentity("config_json", id, JSON.stringify(config));
      const clientSecretEnc =
        input.clientSecret === undefined
          ? null
          : await sealShort(ctx.env, input.clientSecret, secretAad(id));
      await run(
        ctx.db
          .prepare(
            `INSERT INTO providers
               (id, vendor, display_name, brand_key, fhir_base_url, portal_url, environment,
                client_secret_enc, config_json, created_at, updated_at)
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
      ctx.log.info("providers.created", { providerId: id, vendor: input.vendor });
      return require_(id);
    },

    /** Patch the columns present in `patch`; absent ones are left alone. */
    async update(id: string, patch: UpdateProvider): Promise<ProviderRow | null> {
      const existing = await byId(id);
      if (existing === null) return null;

      const sets: string[] = [];
      const values: unknown[] = [];
      const put = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.displayName !== undefined) {
        put("display_name", await sealIdentity("display_name", id, patch.displayName));
      }
      if (patch.fhirBaseUrl !== undefined) {
        put("fhir_base_url", await sealIdentity("fhir_base_url", id, patch.fhirBaseUrl));
      }
      if (patch.brandKey !== undefined) {
        put("brand_key", await sealNullable("brand_key", id, patch.brandKey));
      }
      if (patch.portalUrl !== undefined) {
        put("portal_url", await sealNullable("portal_url", id, patch.portalUrl));
      }
      if (patch.environment !== undefined) put("environment", patch.environment);
      if (patch.config !== undefined) {
        // Replace rather than merge: the admin UI always sends the whole config,
        // and a merge would make removing an override impossible.
        const json = JSON.stringify(providerConfigSchema.parse(patch.config));
        put("config_json", await sealIdentity("config_json", id, json));
      }
      put("updated_at", ctx.now());

      await run(
        ctx.db.prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id),
      );
      // `updated_at` has second resolution, so a write in the same second as the
      // cached read would otherwise look unchanged.
      opened.delete(id);
      return byId(id);
    },

    get: byId,

    async list(options: { includeDeleted?: boolean } = {}): Promise<ProviderRow[]> {
      const where = options.includeDeleted ? "" : " WHERE deleted_at IS NULL";
      const rows = await all<ProviderRow>(ctx.db.prepare(`${SELECT}${where}`));
      const decoded = await Promise.all(rows.map((row) => decode(row)));
      // The name is sealed, so the order the admin UI shows is applied here.
      // Sorted in place: `decoded` is this call's own array.
      decoded.sort((a, b) => byName(a.display_name, b.display_name) || byName(a.id, b.id));
      return decoded;
    },

    /** Stop syncing a provider without losing what it has already produced. */
    async softDelete(id: string): Promise<boolean> {
      const at = ctx.now();
      const { changes } = await run(
        ctx.db
          .prepare(
            "UPDATE providers SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
          )
          .bind(at, at, id),
      );
      if (changes > 0) ctx.log.info("providers.soft_deleted", { providerId: id });
      return changes > 0;
    },

    async setClientSecret(id: string, secret: string): Promise<void> {
      await require_(id);
      const sealed = await sealShort(ctx.env, secret, secretAad(id));
      await run(
        ctx.db
          .prepare("UPDATE providers SET client_secret_enc = ?, updated_at = ? WHERE id = ?")
          .bind(sealed, ctx.now(), id),
      );
    },

    /** The decrypted secret, or null when the provider has none yet. */
    async getClientSecret(id: string): Promise<string | null> {
      const row = await require_(id);
      return row.client_secret_enc === null
        ? null
        : open(ctx.env, row.client_secret_enc, secretAad(id));
    },

    /** The parsed per-provider overrides, defaults applied. */
    async getConfig(id: string): Promise<ProviderConfig> {
      const row = await require_(id);
      return parseJsonColumn(providerConfigSchema, row.config_json, `providers.config_json.${id}`);
    },
  };
}

/** `row` with the identity columns of an already-opened copy of it. */
async function withIdentity(row: ProviderRow, opened: Promise<ProviderRow>): Promise<ProviderRow> {
  return { ...row, ...pickIdentity(await opened) };
}

/** The opened identity values of a row. */
function pickIdentity(
  row: ProviderRow,
): Pick<
  ProviderRow,
  "display_name" | "fhir_base_url" | "brand_key" | "portal_url" | "config_json"
> {
  return {
    display_name: row.display_name,
    fhir_base_url: row.fhir_base_url,
    brand_key: row.brand_key,
    portal_url: row.portal_url,
    config_json: row.config_json,
  };
}

/** Byte order, which is what SQLite's default `ORDER BY` on TEXT gave. */
function byName(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
