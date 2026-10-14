// Scaffolding for the Health Connect store tests: real workerd, real D1, the
// real schema. Batches are queued through the same repo the ingest route uses
// and applied by the same function the runner's alarm calls.
//
// Everything here is synthetic, per CLAUDE.md: invented values, RFC 2606 style
// package names, no real device and no record anyone ever measured.

import { env } from "cloudflare:test";

import { makeCtx } from "../../../src/db/client.ts";
import { EMPTY_RUNNER_STATE, runHcSlice } from "../../../src/hc/apply.ts";
import { gzipText } from "../../../src/hc/codec.ts";
import { HOUR_MS } from "../../../src/hc/store/keys.ts";
import { runStampOf } from "../../../src/hc/wire.ts";
import { testCtx as dbTestCtx } from "../db/helpers.ts";

import type { Ctx } from "../../../src/db/client.ts";
import type { Repos } from "../../../src/db/index.ts";
import type { Env } from "../../../src/env.ts";
import type { HcRunnerState } from "../../../src/hc/apply.ts";
import type { SliceBudget } from "../../../src/hc/store/budget.ts";
import type { HcRecord, HcSyncState } from "../../../src/hc/wire.ts";
import type { TestOptions } from "../db/helpers.ts";

/**
 * The db helpers' context, without the alert channel's secrets.
 *
 * A batch that is set aside raises an alert, and with Trello configured the
 * alert opens a card over the network. These suites park batches all the time
 * and none of them is about the card (alerts.test.ts is, with a stub), so here
 * Trello is simply not configured: the alert row is written and nothing is sent.
 */
export function testCtx(options: TestOptions = {}): Ctx {
  const ctx = dbTestCtx(options);
  return makeCtx(ctx.db, withoutTrello(ctx.env), { now: ctx.now, log: ctx.log });
}

/** An Env with the four Trello secrets absent, as on a deployment that has none. */
export function withoutTrello(env: Env): Env {
  const rest: Partial<Env> = { ...env };
  delete rest.TRELLO_KEY;
  delete rest.TRELLO_TOKEN;
  delete rest.TRELLO_MUST_LIST_ID;
  delete rest.TRELLO_DONE_LIST_ID;
  // Only optional members were removed, so this is still a whole Env.
  return rest as Env;
}

export const WEARABLE = "com.example.wearable";
export const PHONE = "com.example.phone";

export const MINUTE_MS = 60_000;

/** An arbitrary fixed UTC hour to hang synthetic records on: 2026-01-10T12:00Z. */
export const H0 = Date.UTC(2026, 0, 10, 12) / HOUR_MS;
export const T = H0 * HOUR_MS;

// Child tables before `devices`, so no delete trips a foreign key.
const TABLES = [
  "hc_ingest_queue",
  "hc_ingest_log",
  "hc_dirty",
  "hc_chunks",
  "hc_record_index",
  "hc_rollup_hour",
  "hc_rollup_day",
  "hc_hr_minute",
  "hc_sleep_night",
  "hc_exercise_session",
  "hc_sync_state",
  "hc_platform_stale",
  "hc_platform_scan",
  "devices",
  "settings",
];

export async function resetHc(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}

export async function seedDevice(repos: Repos, name = "Test phone"): Promise<string> {
  const minted = await repos.devices.mint(name);
  return minted.device.id;
}

type Extra = Partial<HcRecord>;

/** A one-minute Steps interval. */
export function steps(id: string, startMs: number, count: number, extra: Extra = {}): HcRecord {
  return {
    id,
    type: "Steps",
    origin: WEARABLE,
    lastModified: 1000,
    start: startMs,
    end: startMs + MINUTE_MS,
    data: { count },
    ...extra,
  };
}

/** The origin the companion app uploads the platform's own totals under. */
const PLATFORM = "healthconnect";

/**
 * The phone's synthetic platform total of one UTC hour of steps, as it uploads
 * it: id `agg:Steps:<hour start>`, `data.origins` the apps Health Connect
 * counted.
 */
export function aggSteps(
  hourMs: number,
  value: number,
  origins: readonly string[] = [WEARABLE],
  extra: Extra = {},
): HcRecord {
  return {
    id: `agg:Steps:${String(hourMs)}`,
    type: "Agg.Steps",
    origin: PLATFORM,
    lastModified: 1000,
    start: hourMs,
    end: hourMs + HOUR_MS,
    data: { value, unit: "count", origins: [...origins] },
    ...extra,
  };
}

/** A HeartRate series; each sample is `[offsetMs from start, bpm]`. */
export function heartRate(
  id: string,
  startMs: number,
  samples: readonly (readonly [number, number])[],
  extra: Extra = {},
): HcRecord {
  const last = samples.at(-1)?.[0] ?? 0;
  return {
    id,
    type: "HeartRate",
    origin: WEARABLE,
    lastModified: 1000,
    start: startMs,
    end: startMs + last + 1000,
    data: { samples: samples.map(([offset, bpm]) => ({ t: startMs + offset, bpm })) },
    ...extra,
  };
}

/** An instantaneous record of any type. */
export function instant(
  id: string,
  type: string,
  timeMs: number,
  data: Record<string, unknown>,
  extra: Extra = {},
): HcRecord {
  return { id, type, origin: WEARABLE, lastModified: 1000, time: timeMs, data, ...extra };
}

/** An interval record of any type. */
export function interval(
  id: string,
  type: string,
  startMs: number,
  endMs: number,
  data: Record<string, unknown>,
  extra: Extra = {},
): HcRecord {
  return {
    id,
    type,
    origin: WEARABLE,
    lastModified: 1000,
    start: startMs,
    end: endMs,
    data,
    ...extra,
  };
}

export interface TestBatch {
  batchId: string;
  upserts?: HcRecord[];
  deletes?: string[];
  syncState?: HcSyncState;
}

/** Queue a batch exactly as the ingest route would have. */
export async function enqueue(repos: Repos, deviceId: string, batch: TestBatch): Promise<void> {
  const upserts = batch.upserts ?? [];
  const deletes = batch.deletes ?? [];
  const json = JSON.stringify({
    v: 1,
    deviceId,
    appVersion: "0.0.1",
    batchId: batch.batchId,
    phoneTime: T,
    upserts,
    deletes,
    ...(batch.syncState !== undefined && { syncState: batch.syncState }),
  });
  const result = await repos.hcIngestQueue.enqueue({
    deviceId,
    batchId: batch.batchId,
    body: await gzipText(json),
    rawBytes: json.length,
    upserts: upserts.length,
    deletes: deletes.length,
    rejected: 0,
    phoneTime: T,
    run: runStampOf(batch.syncState),
  });
  if (result.duplicate) throw new Error("test batch id reused");
}

/** Run slices until nothing is left, the way the runner's alarm chain does. */
export async function drain(
  ctx: Ctx,
  deviceId: string,
  options: { budget?: SliceBudget; state?: HcRunnerState } = {},
): Promise<{ slices: number; state: HcRunnerState }> {
  let state = options.state ?? EMPTY_RUNNER_STATE;
  for (let slices = 1; slices < 2000; slices += 1) {
    const result = await runHcSlice(ctx, deviceId, state, options.budget);
    state = result.state;
    if (!result.more) return { slices, state };
  }
  throw new Error("the store never went idle");
}

export interface LogRow {
  status: string;
  error_code: string | null;
  applied: number;
  superseded: number;
  removed: number;
  applied_at: number | null;
}

export async function logRow(deviceId: string, batchId: string): Promise<LogRow | null> {
  return env.DB.prepare(
    `SELECT status, error_code, applied, superseded, removed, applied_at
       FROM hc_ingest_log WHERE device_id = ? AND batch_id = ?`,
  )
    .bind(deviceId, batchId)
    .first<LogRow>();
}

/** Rows a device has in one table. */
export async function count(table: string, deviceId: string): Promise<number> {
  const column = table === "devices" ? "id" : "device_id";
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`)
    .bind(deviceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface SyncRow {
  record_type: string;
  permission_state: string;
  first_ms: number | null;
  last_ms: number | null;
  record_count: number;
  last_upload_at: number | null;
  token_age_s: number | null;
  backlog: number | null;
  backfill_complete: number;
  backfill_oldest_ms: number | null;
}

export async function syncRows(deviceId: string): Promise<Record<string, SyncRow>> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM hc_sync_state WHERE device_id = ? ORDER BY record_type",
  )
    .bind(deviceId)
    .all<SyncRow>();
  return Object.fromEntries(results.map((row) => [row.record_type, row]));
}
