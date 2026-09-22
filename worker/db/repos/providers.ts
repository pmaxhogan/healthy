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
 */

import { AppError } from "../../lib/errors.ts";
import { newId } from "../../lib/ids.ts";
import { all, one, run } from "../client.ts";
import { aadFor, open, seal } from "../crypto.ts";
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

export function makeProvidersRepo(ctx: Ctx) {
  const byId = async (id: string): Promise<ProviderRow | null> =>
    one<ProviderRow>(ctx.db.prepare(`${SELECT} WHERE id = ?`).bind(id));

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
      const clientSecretEnc =
        input.clientSecret === undefined
          ? null
          : await seal(ctx.env, input.clientSecret, secretAad(id));
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
            input.displayName,
            input.brandKey ?? null,
            input.fhirBaseUrl,
            input.portalUrl ?? null,
            input.environment ?? "prod",
            clientSecretEnc,
            JSON.stringify(config),
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
      if (patch.displayName !== undefined) put("display_name", patch.displayName);
      if (patch.fhirBaseUrl !== undefined) put("fhir_base_url", patch.fhirBaseUrl);
      if (patch.brandKey !== undefined) put("brand_key", patch.brandKey);
      if (patch.portalUrl !== undefined) put("portal_url", patch.portalUrl);
      if (patch.environment !== undefined) put("environment", patch.environment);
      if (patch.config !== undefined) {
        // Replace rather than merge: the admin UI always sends the whole config,
        // and a merge would make removing an override impossible.
        put("config_json", JSON.stringify(providerConfigSchema.parse(patch.config)));
      }
      put("updated_at", ctx.now());

      await run(
        ctx.db.prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id),
      );
      return byId(id);
    },

    get: byId,

    async list(options: { includeDeleted?: boolean } = {}): Promise<ProviderRow[]> {
      const where = options.includeDeleted ? "" : " WHERE deleted_at IS NULL";
      return all<ProviderRow>(ctx.db.prepare(`${SELECT}${where} ORDER BY display_name`));
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
      const sealed = await seal(ctx.env, secret, secretAad(id));
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
