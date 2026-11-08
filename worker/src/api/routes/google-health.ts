/**
`/api/google-health` -- the Google Health side of the Google grant.

What the admin UI shows about it is bookkeeping only: per metric, whether the
grant covers it, how many days are stored and over which dates, and how the
last read went (a stable code). Never a value; those are for the MCP, behind
its exposure policy.

`POST /sync` starts a read after the response (`afterResponse`): the
granted metrics' recent days, or with `full: true` every one's whole history.
A full read that outlives the request's `waitUntil` is not lost: a metric
whose history has not been read yet is read again by the hourly cron.
*/

import { Hono } from "hono";

import { GH_TYPES, grantedTypes, hasHealthScope } from "../../google/health.ts";
import { toIso } from "../../lib/time.ts";
import { NO_STORE, afterResponse, apiContext, readOptionalJson } from "../http.ts";
import { googleHealthSyncSchema } from "../schemas.ts";

import { projectGoogle } from "./google.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { GoogleHealthDto } from "@shared/types.ts";

/** Where the owner grants the Google Health scopes. */
const CONNECT_PATH = "/oauth/google/start?health=1";

export const googleHealthRouter = new Hono<AppHonoEnv>();

const isoOrNull = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined ? null : toIso(seconds);

googleHealthRouter.get("/", async (c) => {
  const api = apiContext(c);
  const [google, account, extents, rows] = await Promise.all([
    projectGoogle(api),
    api.repos.google.get(),
    api.repos.googleHealth.extents(),
    api.repos.googleHealth.syncRows(),
  ]);
  const granted = new Set(grantedTypes(account.scope).map((spec) => spec.type));
  const extentOf = new Map(extents.map((extent) => [extent.dataType, extent]));
  const rowOf = new Map(rows.map((row) => [row.data_type, row]));
  const dto: GoogleHealthDto = {
    googleStatus: google.status,
    granted: hasHealthScope(account.scope),
    connectPath: CONNECT_PATH,
    types: GH_TYPES.map((spec) => {
      const extent = extentOf.get(spec.type);
      const row = rowOf.get(spec.type);
      return {
        type: spec.type,
        scopeGranted: granted.has(spec.type),
        days: extent?.days ?? 0,
        firstDate: extent?.firstDate ?? null,
        lastDate: extent?.lastDate ?? null,
        lastOkAt: isoOrNull(row?.last_ok_at),
        lastAttemptAt: isoOrNull(row?.last_attempt_at),
        lastErrorCode: row?.last_error_code ?? null,
        historyRead: (row?.backfilled_at ?? null) !== null,
      };
    }),
  };
  return c.json(dto, 200, NO_STORE);
});

googleHealthRouter.post("/sync", async (c) => {
  const api = apiContext(c);
  const body = await readOptionalJson(c, googleHealthSyncSchema);
  afterResponse(c, "google_health.sync", () =>
    api.ports.sync.runGoogleHealthSync(api.ctx, { full: body.full === true }),
  );
  return c.json({ accepted: true }, 202, NO_STORE);
});
