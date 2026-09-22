/**
 * `/api/providers` -- the connected health systems and the actions on one.
 *
 * Three behaviours are worth reading before changing anything here.
 *
 * **Creation validates the endpoint, not the owner's typing.** A `brandId` comes
 * from `data/epic-brands.json`, which is Epic's own published directory, so its
 * FHIR base is taken as given. A manual `fhirBaseUrl` is not: it must be https and
 * it must answer a SMART discovery request *before* the row is written. Storing an
 * endpoint that turns out not to be an Epic FHIR server produces a provider that
 * can never be connected and a reconnect card that can never be cleared.
 *
 * **Deletion is a disconnect plus a soft delete.** The calendar events already
 * written are left exactly as they are -- they are the owner's appointment history,
 * and a provider being removed from the admin UI is not a reason to rewrite a
 * year of their calendar. `providers.deleted_at` hides the row; the tokens are
 * destroyed by `connections.disconnect`.
 *
 * **The long-running actions answer 202, by two different mechanisms.** A calendar
 * sync runs in `waitUntil` after the response. A full refresh cannot: `waitUntil` is
 * cancelled about thirty seconds in, and a large record takes minutes, so that one is
 * queued on a Durable Object alarm instead (`worker/sync/runner.ts`). Either way the
 * Runs page polls `GET /api/runs` every few seconds while a row is still `running`,
 * so the 202 itself carries no `runId` to report.
 */

import { Hono } from "hono";

import { brandById } from "../../brands.ts";
import { AppError } from "../../lib/errors.ts";
import { makeLogger } from "../../lib/log.ts";
import { adapterFor } from "../../providers/registry.ts";
import { closeAlert, providerSubject } from "../close-alert.ts";
import { fromProviderConfigDto, toConnectionDto, toProviderDto } from "../dto.ts";
import { NO_STORE, afterResponse, apiContext, readJson, readOptionalJson } from "../http.ts";
import {
  providerCreateSchema,
  providerSecretSchema,
  syncRequestSchema,
  updateProviderSchema,
} from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { ProviderRow } from "../../db/rows.ts";
import type { ApiContext } from "../http.ts";
import type { ProviderDto } from "@shared/types.ts";

/** The only vendor today. `worker/providers/registry.ts` is where a second lands. */
const VENDOR = "epic";

export const providersRouter = new Hono<AppHonoEnv>();

/** Project one provider row, reading its config and connection. Shared with /api/overview. */
async function projectProvider(api: ApiContext, row: ProviderRow): Promise<ProviderDto> {
  const [config, connection] = await Promise.all([
    api.repos.providers.getConfig(row.id),
    api.repos.connections.getForProvider(row.id),
  ]);
  return toProviderDto({ row, config, connection });
}

/**
 * A provider row that exists and has not been soft-deleted.
 *
 * Shared with the OAuth routes: a soft-deleted provider must not be reachable
 * through a stale start link either, and one predicate is how the two stay agreed.
 */
export function isLiveProvider(row: ProviderRow | null): row is ProviderRow {
  return row !== null && row.deleted_at === null;
}

/** The row for `:id`, or a 404. Soft-deleted providers are gone as far as /api is concerned. */
async function requireProvider(api: ApiContext, id: string): Promise<ProviderRow> {
  const row = await api.repos.providers.get(id);
  if (!isLiveProvider(row)) throw new AppError("not_found", "no such provider");
  return row;
}

/** Every live provider, projected. Shared with /api/overview. */
export async function listProviderDtos(api: ApiContext): Promise<ProviderDto[]> {
  const rows = await api.repos.providers.list();
  return Promise.all(rows.map((row) => projectProvider(api, row)));
}

providersRouter.get("/", async (c) => {
  const api = apiContext(c);
  return c.json(await listProviderDtos(api), 200, NO_STORE);
});

/**
 * Resolve the endpoint a new provider points at.
 *
 * Exactly one of `brandId` and `fhirBaseUrl`: with both, a disagreement between
 * them has no right answer, and silently preferring one is how a provider ends up
 * pointing somewhere the owner did not choose.
 */
async function resolveEndpoint(
  api: ApiContext,
  input: {
    brandId?: string | undefined;
    fhirBaseUrl?: string | undefined;
    portalUrl?: string | undefined;
  },
): Promise<{ fhirBaseUrl: string; portalUrl: string | null; brandKey: string | null }> {
  const hasBrand = input.brandId !== undefined;
  const hasManual = input.fhirBaseUrl !== undefined;
  if (hasBrand === hasManual) {
    throw new AppError("bad_request", "give exactly one of brandId and fhirBaseUrl");
  }

  if (input.brandId !== undefined) {
    const brand = brandById(input.brandId);
    if (brand === null) throw new AppError("bad_request", "unknown brandId");
    return {
      fhirBaseUrl: brand.fhirBaseUrl,
      portalUrl: input.portalUrl ?? brand.portalUrl,
      brandKey: brand.id,
    };
  }

  // Manual entry: prove it is really a SMART endpoint before writing the row.
  // `discover` throws `upstream_*` on a failure, which is the honest answer --
  // the request was fine, the endpoint was not.
  const fhirBaseUrl = input.fhirBaseUrl ?? "";
  const adapter = adapterFor(VENDOR, {
    fetchImpl: api.ports.fetch,
    logger: makeLogger({ src: "api.discover" }),
    now: Date.now,
  });
  await adapter.discover(fhirBaseUrl);
  return { fhirBaseUrl, portalUrl: input.portalUrl ?? null, brandKey: null };
}

providersRouter.post("/", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, providerCreateSchema);
  const endpoint = await resolveEndpoint(api, body);

  const row = await api.repos.providers.create({
    vendor: VENDOR,
    displayName: body.displayName,
    fhirBaseUrl: endpoint.fhirBaseUrl,
    brandKey: endpoint.brandKey,
    portalUrl: endpoint.portalUrl,
    environment: body.environment,
    ...(body.config !== undefined && { config: fromProviderConfigDto(body.config) }),
    // Sealed by the repo against this row's id. It is never read back by /api.
    ...(body.clientSecret !== undefined && { clientSecret: body.clientSecret }),
  });
  return c.json(await projectProvider(api, row), 201, NO_STORE);
});

providersRouter.get("/:id", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  return c.json(await projectProvider(api, row), 200, NO_STORE);
});

providersRouter.patch("/:id", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  const body = await readJson(c, updateProviderSchema);

  const updated = await api.repos.providers.update(row.id, {
    ...(body.displayName !== undefined && { displayName: body.displayName }),
    ...(body.portalUrl !== undefined && { portalUrl: body.portalUrl }),
    ...(body.config !== undefined && { config: fromProviderConfigDto(body.config) }),
  });
  if (updated === null) throw new AppError("not_found", "no such provider");
  return c.json(await projectProvider(api, updated), 200, NO_STORE);
});

/**
 * Disconnect and hide a provider.
 *
 * The calendar is not touched: see the module comment. The FHIR cache is cleared,
 * because it is the one store that holds clinical content and nothing will read it
 * again.
 */
providersRouter.delete("/:id", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));

  const connection = await api.repos.connections.getForProvider(row.id);
  if (connection !== null) await api.repos.connections.disconnect(connection.id);
  await api.repos.fhirCache.clearProvider(row.id);
  await closeAlert(api, c.env, providerSubject(row.id));
  await api.repos.providers.softDelete(row.id);

  return c.json({ ok: true }, 200, NO_STORE);
});

/** Set or rotate the per-organisation client secret. Write-only, by design. */
providersRouter.post("/:id/secret", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  const body = await readJson(c, providerSecretSchema);
  await api.repos.providers.setClientSecret(row.id, body.clientSecret);
  // Re-read: `row` was loaded before the write, so projecting it would answer
  // `hasClientSecret: false` immediately after setting the secret.
  return c.json(await projectProvider(api, await requireProvider(api, row.id)), 200, NO_STORE);
});

/** Sync one provider's appointments now. 202: the work outlives the response. */
providersRouter.post("/:id/sync", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  afterResponse(c, "providers.sync", () =>
    api.ports.sync.runCalendarSync(api.ctx, { providerIds: [row.id], trigger: "manual" }),
  );
  // No `runId`: the row is opened by the sync engine after this response has been
  // sent, so there is nothing to report yet. RunsView polls GET /api/runs on an
  // interval while any row is running, and stops once none is.
  return c.json({ accepted: true }, 202, NO_STORE);
});

/**
 * Force a token refresh.
 *
 * Awaited, unlike the two above: it is a single round trip, and the useful answer
 * is the connection's new state -- which is the whole reason the owner pressed it.
 */
providersRouter.post("/:id/refresh-token", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  await api.ports.sync.refreshConnectionToken(api.ctx, row.id, { force: true });
  const connection = await api.repos.connections.getForProvider(row.id);
  if (connection === null) throw new AppError("not_connected", "this provider has no connection");
  return c.json(toConnectionDto(connection), 200, NO_STORE);
});

/**
 * Re-walk every resource type for this provider, repopulating the MCP cache.
 *
 * Queued, not detached. This is the one long action that `waitUntil` cannot carry:
 * it is cancelled about thirty seconds after the response, which for the largest
 * record meant a half-filled cache and a run row left open forever. `startFullRefresh`
 * hands the work to a Durable Object alarm and returns, so the call awaited here is a
 * storage write. `started: false` reports that one was already in flight for this
 * provider -- still a 202, because the refresh the owner asked for is happening.
 */
providersRouter.post("/:id/full-refresh", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  const { started } = await api.ports.sync.startFullRefresh(api.ctx, { providerId: row.id });
  return c.json({ accepted: true, started }, 202, NO_STORE);
});

/** `POST /api/sync/run`: every enabled provider. Mounted separately by index.ts. */
export const syncRouter = new Hono<AppHonoEnv>();

syncRouter.post("/run", async (c) => {
  const api = apiContext(c);
  // An empty body is the common case ("sync everything"), so it is allowed --
  // hence `readOptionalJson` rather than `readJson`.
  const body = await readOptionalJson(c, syncRequestSchema);
  afterResponse(c, "sync.run", () =>
    api.ports.sync.runCalendarSync(api.ctx, {
      ...(body.providerIds !== undefined && { providerIds: body.providerIds }),
      trigger: "manual",
    }),
  );
  return c.json({ accepted: true }, 202, NO_STORE);
});
