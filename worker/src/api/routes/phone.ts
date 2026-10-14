/**
`/api/phone` -- paired phones (Health Connect devices) and what each has sent.

Three behaviours are worth reading before changing anything here.

**The token is shown once.** Minting and rotating return `{ device, pairing }`, and the token is inside `pairing`;
only the token's digest is stored (`worker/src/hc/device-token.ts`), so nothing
here can show it again, and a response carrying one is never cached (every
/api response is `no-store`). It is not logged: no handler here logs a body,
and the error handler logs codes and paths only.

**`pairing` is exactly what the QR encodes.** A JSON object with the Worker's
origin, the device id and the token, so the companion app scans one thing and
needs nothing typed. The origin comes from this request, not from a setting:
the owner is looking at the admin UI on the very origin the phone must reach.

**Wiping is two steps and may take several calls.** The body must carry the
device's id (the UI makes the owner type the device's name first), and a
phone's history is far more rows than one request may delete, so the route
deletes a bounded number of slices and answers `{ done }`; the UI calls again
while it is false.
*/

import { Hono } from "hono";
import { z } from "zod";

import { adminDeviceCoverage, coverageResourceType } from "../../hc/coverage.ts";
import { kickIngestRunner } from "../../hc/kick.ts";
import { unparkMarks } from "../../hc/store/dirty.ts";
import { storeBacklog } from "../../hc/store/read.ts";
import { wipeDevice } from "../../hc/store/wipe.ts";
import { AppError } from "../../lib/errors.ts";
import {
  isoFromMs,
  toDeviceCoverageRowDto,
  toDeviceDto,
  toDeviceIngestLogDto,
  toDeviceIngestSummaryDto,
} from "../dto.ts";
import { NO_STORE, apiContext, limitQuerySchema, readJson, readQuery } from "../http.ts";
import { deviceNameSchema, wipeDeviceSchema } from "../schemas.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { DeviceTotals, Device, IngestLogRow } from "../../hc/device.ts";
import type { ApiContext } from "../http.ts";
import type {
  DeviceCoverageRowDto,
  DeviceDto,
  DeviceIngestLogState,
  DeviceIngestSummaryDto,
  DeviceReportDto,
  PairedDeviceDto,
  RetryFailedResponse,
  WipeDeviceResponse,
} from "@shared/types.ts";
import type { Context } from "hono";

export const phoneRouter = new Hono<AppHonoEnv>();

/** Batches shown by default; `?limit=` raises it up to the shared ceiling. */
const DEFAULT_LOG_LIMIT = 50;

/** Slices of `wipeDevice` one request runs before answering `{ done: false }`. */
const WIPE_SLICES_PER_REQUEST = 10;

/** The pairing format version the companion app checks. */
const PAIRING_VERSION = 1;

/** Hosts that may stay on plain http in a pairing URL. `URL` keeps the brackets on an IPv6 host. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** What the type name of one of Health Connect's own hourly totals starts with. */
const PLATFORM_AGGREGATE_PREFIX = "Agg.";

const NO_TOTALS: DeviceTotals = {
  recordCount: 0,
  typesGranted: 0,
  typesDenied: 0,
  typesBackfilled: 0,
};

/** What "applied recently" means in the upload summary, in seconds. */
const RECENT_SECONDS = 3600;

/** Applied batches the summary's median apply time is taken over. */
const APPLY_SAMPLE = 20;

/** The log statuses behind each `?state=` of the ingest log. */
function logStatuses(state: DeviceIngestLogState): readonly IngestLogRow["status"][] {
  return state === "finished" ? ["applied", "failed"] : ["queued", "applying"];
}

const logQuerySchema = limitQuerySchema.extend({
  state: z.enum(["finished", "waiting"]).optional(),
});

const reportSchema = z.looseObject({
  batteryExempt: z.boolean().optional(),
  backgroundRead: z.boolean().optional(),
  historyRead: z.boolean().optional(),
  backfillComplete: z.boolean().optional(),
  exerciseRoutes: z.enum(["granted", "denied", "unavailable"]).optional(),
  lastError: z
    .looseObject({ errorCode: z.string().max(64), at: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});

/**
The phone's last sync report, reduced to the fields the page shows. Tolerant:
a report this version cannot read is no report, not a failed page.
*/
function readReport(json: string | null): DeviceReportDto | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const report = parsed.data;
  return {
    batteryExempt: report.batteryExempt ?? null,
    backgroundRead: report.backgroundRead ?? null,
    historyRead: report.historyRead ?? null,
    backfillComplete: report.backfillComplete ?? null,
    exerciseRoutes: report.exerciseRoutes ?? null,
    lastErrorCode: report.lastError?.errorCode ?? null,
    lastErrorAt: isoFromMs(report.lastError?.at ?? null),
  };
}

async function projectDevice(
  api: ApiContext,
  device: Device,
  totals: DeviceTotals,
): Promise<DeviceDto> {
  const [queue, parkedDepth, backlog, reportJson] = await Promise.all([
    api.repos.hcIngestQueue.depth(device.id),
    api.repos.hcIngestQueue.parked(device.id),
    storeBacklog(api.ctx, device.id),
    api.repos.devices.syncStateJson(device.id),
  ]);
  const errorCodes = parkedDepth.batches > 0 ? await api.repos.hcStatus.failedCodes(device.id) : [];
  return toDeviceDto({
    device,
    now: api.ctx.now(),
    queue,
    parked: { ...parkedDepth, errorCodes },
    parkedMarks: backlog.parkedMarks,
    report: readReport(reportJson),
    totals,
  });
}

/** The device for `:id`, or a 404. */
async function requireDevice(api: ApiContext, id: string): Promise<Device> {
  const device = await api.repos.devices.get(id);
  if (device === null) throw new AppError("not_found", "no such device");
  return device;
}

/** A device projected with its own totals, for the single-device responses. */
async function projectOne(api: ApiContext, device: Device): Promise<DeviceDto> {
  const totals = await api.repos.hcStatus.totalsByDevice();
  return projectDevice(api, device, totals.get(device.id) ?? NO_TOTALS);
}

/**
The text the QR code encodes.

The origin is this request's, upgraded to https: the phone sends a bearer
token, and nothing but a loopback address (a developer's `adb reverse` to a
local Worker) is allowed to stay on plain http.
*/
function pairingString(c: Context<AppHonoEnv>, deviceId: string, token: string): string {
  const url = new URL(c.req.url);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const origin = loopback ? url.origin : `https://${url.host}`;
  return JSON.stringify({ v: PAIRING_VERSION, url: origin, deviceId, token });
}

phoneRouter.get("/devices", async (c) => {
  const api = apiContext(c);
  const [devices, totals] = await Promise.all([
    api.repos.devices.list(),
    api.repos.hcStatus.totalsByDevice(),
  ]);
  const dtos = await Promise.all(
    devices.map((device) => projectDevice(api, device, totals.get(device.id) ?? NO_TOTALS)),
  );
  return c.json(dtos, 200, NO_STORE);
});

phoneRouter.post("/devices", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, deviceNameSchema);
  const { device, token } = await api.repos.devices.mint(body.name);
  const paired: PairedDeviceDto = {
    device: await projectDevice(api, device, NO_TOTALS),
    pairing: pairingString(c, device.id, token),
  };
  return c.json(paired, 201, NO_STORE);
});

phoneRouter.patch("/devices/:id", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, deviceNameSchema);
  const id = c.req.param("id");
  if (!(await api.repos.devices.rename(id, body.name))) {
    throw new AppError("not_found", "no such device");
  }
  return c.json(await projectOne(api, await requireDevice(api, id)), 200, NO_STORE);
});

phoneRouter.post("/devices/:id/rotate", async (c) => {
  const api = apiContext(c);
  const id = c.req.param("id");
  const existing = await requireDevice(api, id);
  if (existing.revokedAt !== null) {
    throw new AppError("conflict", "that device is revoked; pair the phone again instead");
  }
  const minted = await api.repos.devices.rotate(id);
  if (minted === null) throw new AppError("conflict", "that device could not be rotated");
  const paired: PairedDeviceDto = {
    device: await projectOne(api, minted.device),
    pairing: pairingString(c, id, minted.token),
  };
  return c.json(paired, 200, NO_STORE);
});

phoneRouter.post("/devices/:id/revoke", async (c) => {
  const api = apiContext(c);
  const id = c.req.param("id");
  if (!(await api.repos.devices.revoke(id))) throw new AppError("not_found", "no such device");
  return c.json(await projectOne(api, await requireDevice(api, id)), 200, NO_STORE);
});

phoneRouter.post("/devices/:id/retry-failed", async (c) => {
  const api = apiContext(c);
  const id = c.req.param("id");
  await requireDevice(api, id);
  const requeued = await api.repos.hcIngestQueue.unpark(id);
  // Rollup and summary rebuilds that were set aside come back with the batches:
  // "Retry" means everything of this phone's that was parked.
  const remarked = await unparkMarks(api.repos.ctx, id);
  if (requeued > 0 || remarked > 0) await kickIngestRunner(c.env, id);
  return c.json<RetryFailedResponse>({ requeued, remarked }, 200, NO_STORE);
});

phoneRouter.post("/devices/:id/wipe", async (c) => {
  const api = apiContext(c);
  const body = await readJson(c, wipeDeviceSchema);
  const id = c.req.param("id");
  await requireDevice(api, id);
  if (body.confirm !== id) {
    throw new AppError("bad_request", "confirm must be the id of the device being wiped");
  }
  let done = false;
  for (let slice = 0; !done && slice < WIPE_SLICES_PER_REQUEST; slice++) {
    ({ done } = await wipeDevice(api.ctx, id));
  }
  return c.json<WipeDeviceResponse>({ done }, 200, NO_STORE);
});

phoneRouter.get("/devices/:id/coverage", async (c) => {
  const api = apiContext(c);
  const device = await requireDevice(api, c.req.param("id"));
  // Health Connect's own hourly totals (`Agg.<Metric>`) are stored like a
  // record type but are not one: nothing grants or refuses them, so in a table
  // of permissions they would read as a type the phone never asked about.
  const stored = await api.repos.hcStatus.syncRows(device.id);
  const rows = stored.filter((row) => !row.recordType.startsWith(PLATFORM_AGGREGATE_PREFIX));
  const entries = adminDeviceCoverage({ device, rows, now: api.ctx.now() });
  const byType = new Map(entries.map((entry) => [entry.resourceType, entry]));
  const dtos: DeviceCoverageRowDto[] = rows.map((row) => {
    const entry = byType.get(coverageResourceType(row.recordType));
    return toDeviceCoverageRowDto(row, entry ?? { status: "never" });
  });
  return c.json(dtos, 200, NO_STORE);
});

phoneRouter.get("/devices/:id/ingest-log", async (c) => {
  const api = apiContext(c);
  const device = await requireDevice(api, c.req.param("id"));
  const { limit, state } = readQuery(c, logQuerySchema);
  const rows = await api.repos.hcStatus.ingestLog(
    device.id,
    limit ?? DEFAULT_LOG_LIMIT,
    state === undefined ? undefined : logStatuses(state),
  );
  return c.json(
    rows.map((row) => toDeviceIngestLogDto(row)),
    200,
    NO_STORE,
  );
});

// What the log's newest rows cannot show during a backfill, when every one of
// them is still waiting: how many batches are in each state, and how fast they
// are being applied. Counts and instants only.
phoneRouter.get("/devices/:id/ingest-summary", async (c) => {
  const api = apiContext(c);
  const device = await requireDevice(api, c.req.param("id"));
  const [summary, parked] = await Promise.all([
    api.repos.hcStatus.ingestSummary(device.id, api.ctx.now() - RECENT_SECONDS, APPLY_SAMPLE),
    api.repos.hcIngestQueue.parked(device.id),
  ]);
  return c.json<DeviceIngestSummaryDto>(
    toDeviceIngestSummaryDto(summary, parked.batches),
    200,
    NO_STORE,
  );
});
