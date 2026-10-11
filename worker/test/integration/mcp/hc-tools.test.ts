// The Health Connect tools against the real store, end to end:
//
//   a synthetic batch POSTed to the real `/ingest/health-connect` route (bearer
//   token, gzip, validation, sealed queue) -> applied by the real
//   `HcIngestRunner` Durable Object from its alarm (chunks, index, hour and day
//   rollups, minute rows, night and session summaries, all sealed) -> read back
//   by every tool through the real `ToolDeps`, the real policy rows and the
//   real audit table.
//
// The unit suite pins every tool's arithmetic over an in-memory store. What
// this file adds is the half that cannot be faked: that the readers, the AADs,
// the rollups the runner builds and the zone the day rollups are built for all
// agree with what the tools ask of them.
//
// Everything is synthetic (the invented day of `test/unit/mcp/hc-fake.ts`),
// and the zone is a test parameter, never the owner's. The Durable Object
// seals with the runtime's own `DATA_KEY`, so this file uses that env as is.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createExecutionContext,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { app } from "../../../src/app.ts";
import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { HC_STALE_AFTER_SECONDS } from "../../../src/hc/coverage.ts";
import { localDay } from "../../../src/hc/rollup/day.ts";
import { storeBacklog } from "../../../src/hc/store/read.ts";
import { INGEST_PATH } from "../../../src/ingest/route.ts";
import { makeToolDeps } from "../../../src/mcp/deps-d1.ts";
import { registerTools } from "../../../src/mcp/tools/index.ts";
import {
  CUFF,
  HOUR_MS,
  MINUTE_MS,
  PHONE,
  PLATFORM,
  WEARABLE,
  hcWorldRecords,
  interval,
} from "../../unit/mcp/hc-fake.ts";
import { resetDb } from "../db/helpers.ts";

import type { Env } from "../../../src/env.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The zone the owner's days are counted in, for this file. Five hours west of UTC. */
const ZONE = "Etc/GMT+5";

const ORIGIN = "https://healthy.example";
// `Cloudflare.Env` types the namespaces more narrowly than the hand-written Env.
const RUNTIME_ENV = env as unknown as Env;
const ctx = makeCtx(env.DB, RUNTIME_ENV);
const repos = makeRepos(ctx);

const DAY_MS = 24 * HOUR_MS;
/** The invented day: the last whole UTC day before the real clock. */
const DAY_END = Math.floor(Date.now() / DAY_MS) * DAY_MS;
const DAY = DAY_END - DAY_MS;
const at = (hour: number, minute = 0): number => DAY + hour * HOUR_MS + minute * MINUTE_MS;
const instant = (ms: number): string => new Date(ms).toISOString();

/**
 * The clock the tools see unless a test passes another: six hours after the
 * invented day, in unix seconds. Fixed relative to the data, so that the local
 * day the data falls on is over whatever time of day this file happens to run.
 */
const toolNow = (): number => DAY_END / 1000 + 6 * 3600;

/** Everything the phone sent, as instants: from before the night began to the end of the day. */
const RANGE = { start: instant(DAY - 2 * HOUR_MS), end: instant(DAY_END) };
/** The local date most of the invented day falls on in {@link ZONE}, and the one before. */
const LOCAL_DAY = localDay(at(8), ZONE);
const LOCAL_DAY_BEFORE = localDay(at(8) - DAY_MS, ZONE);
const LOCAL_DAYS = { start: LOCAL_DAY_BEFORE, end: LOCAL_DAY };

const seeded = { deviceId: "", source: "", idleDeviceId: "" };

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** POST one batch to the real ingest route, as the companion app would. */
async function upload(token: string, batch: Record<string, unknown>): Promise<Response> {
  const execution = createExecutionContext();
  const body = await gzip(JSON.stringify(batch));
  const request = new Request(ORIGIN + INGEST_PATH, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body,
  });
  const response = await app.fetch(request, RUNTIME_ENV, execution);
  await waitOnExecutionContext(execution);
  return response;
}

/** Let the runner's alarm chain run until the phone has nothing queued and nothing to rebuild. */
async function settle(deviceId: string): Promise<void> {
  const stub = env.HC_INGEST.getByName(deviceId);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    await runDurableObjectAlarm(stub);
    const backlog = await storeBacklog(ctx, deviceId);
    const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    if (alarm === null && backlog.queuedBatches === 0 && backlog.dirty === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the runner never went idle");
}

beforeAll(async () => {
  await resetDb();
  // Before anything is applied: day rollups are built for the zone configured then.
  await setSetting(ctx, "timezone", ZONE);
  const { device, token } = await repos.devices.mint("Test phone");
  const idle = await repos.devices.mint("Drawer phone");
  seeded.deviceId = device.id;
  seeded.source = `device:${device.id}`;
  seeded.idleDeviceId = idle.device.id;

  const records = hcWorldRecords(DAY_END);
  const types = [...new Set(records.map((record) => record.type))];
  const response = await upload(token, {
    v: 1,
    deviceId: device.id,
    appVersion: "0.1.9",
    batchId: crypto.randomUUID(),
    phoneTime: Date.now(),
    upserts: records,
    deletes: [],
    syncState: {
      types: [
        ...types.map((type) => ({ type, permission: "granted", tokenAgeS: 60, backlog: 0 })),
        { type: "BodyTemperature", permission: "denied" },
        { type: "OxygenSaturation", permission: "unavailable" },
        { type: "Hydration", permission: "granted", tokenAgeS: 60, backlog: 0 },
      ],
      backgroundRead: true,
      historyRead: true,
      batteryExempt: false,
      backfillComplete: true,
      androidSdk: 37,
    },
  });
  if (response.status !== 200) throw new Error(`ingest answered ${String(response.status)}`);
  const ack = await response.json<{ accepted: number; rejected: unknown[] }>();
  if (ack.accepted !== records.length || ack.rejected.length > 0) {
    throw new Error("the synthetic batch was not accepted whole");
  }
  await settle(device.id);
}, 120_000);

afterEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mcp_policy"),
    env.DB.prepare("DELETE FROM mcp_audit"),
  ]);
});

async function connect(now: () => number): Promise<Client> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({
      env: RUNTIME_ENV,
      caller: { clientId: "client-int", grantId: "grant-int" },
      now,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

interface Answer {
  text: string;
  isError: boolean;
  items: Record<string, unknown>[];
  body: Record<string, unknown>;
  warnings: string[];
  coverage: Record<string, unknown>[];
  error?: string;
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  now: () => number = toolNow,
): Promise<Answer> {
  const client = await connect(now);
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A schema rejection is not JSON.
  }
  return {
    text,
    isError: result.isError === true,
    items: (body.items ?? []) as Record<string, unknown>[],
    body,
    warnings: (body.warnings ?? []) as string[],
    coverage: (body.coverage ?? []) as Record<string, unknown>[],
    ...(typeof body.error === "string" && { error: body.error }),
  };
}

/** Every tool, with arguments that make it answer from the seeded day for the seeded phone. */
function tools(): [string, Record<string, unknown>][] {
  const devices = [seeded.source];
  return [
    ["hc_coverage", { devices }],
    ["hc_sync_status", { devices }],
    ["hc_records", { devices, type: "Steps", ...RANGE }],
    ["hc_aggregate", { devices, type: "Steps", ...LOCAL_DAYS }],
    ["hr_series", { devices, ...RANGE }],
    ["hr_events", { devices, ...RANGE }],
    ["sleep_sessions", { devices, ...RANGE }],
    ["exercise_sessions", { devices, ...RANGE }],
    ["blood_pressure", { devices, ...RANGE }],
    ["daily_summary", { devices, ...LOCAL_DAYS }],
    ["data_quality", { devices, ...RANGE }],
  ];
}

const TOOL_NAMES = [
  "hc_coverage",
  "hc_sync_status",
  "hc_records",
  "hc_aggregate",
  "hr_series",
  "hr_events",
  "sleep_sessions",
  "exercise_sessions",
  "blood_pressure",
  "daily_summary",
  "data_quality",
] as const;

const argsOf = (name: string): Record<string, unknown> =>
  tools().find(([tool]) => tool === name)?.[1] ?? {};

describe("every Health Connect tool, over the real store", () => {
  it.each(TOOL_NAMES)(
    "%s answers with rows, and one audit row that carries no content",
    async (name) => {
      const answer = await call(name, argsOf(name));
      const [audit] = await repos.mcpAudit.listRecent(5);

      expect(answer.isError, answer.text).toBe(false);
      expect(answer.items.length, name).toBeGreaterThan(0);
      expect(Object.keys(answer.body)).toStrictEqual(
        expect.arrayContaining(["items", "total", "matched", "coverage", "warnings", "truncated"]),
      );
      expect(answer.body.timeZone).toBe(ZONE);
      expect(new Set(answer.items.map((item) => item.healthSystemId))).toStrictEqual(
        new Set([seeded.source]),
      );
      expect(audit).toMatchObject({
        tool: name,
        clientId: "client-int",
        grantId: "grant-int",
        healthSystems: [seeded.source],
        resultCount: answer.items.length,
        ok: true,
        errorCode: null,
      });
      expect(JSON.stringify(audit)).not.toContain("com.example");
    },
  );

  it.each(TOOL_NAMES)(
    "%s answers policy_denied under a tool rule, and the audit row says so",
    async (name) => {
      await repos.mcpPolicy.add("tool", name);

      const answer = await call(name, argsOf(name));
      const [audit] = await repos.mcpAudit.listRecent(5);

      expect(answer).toMatchObject({ isError: true, error: "policy_denied" });
      expect(answer.text).not.toContain("com.example");
      expect(audit).toMatchObject({
        tool: name,
        ok: false,
        errorCode: "policy_denied",
        resultCount: 0,
      });
    },
  );

  it.each(TOOL_NAMES)("%s returns nothing of a phone the policy denies", async (name) => {
    await repos.mcpPolicy.add("health_system", seeded.source);

    const answer = await call(name, { ...argsOf(name), devices: undefined });

    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).not.toContain(seeded.deviceId);
    expect(answer.text).not.toContain("com.example");
    // The other phone is still there to be told about, the denied one is not.
    expect(answer.coverage.every((entry) => entry.healthSystemId !== seeded.source)).toBe(true);
  });
});

describe("a resource rule on an hc: type", () => {
  /** Each tool, the type whose denial empties it (or a part of it), and how to tell it did. */
  const cases: [string, string, (answer: Answer) => boolean][] = [
    ["hc_coverage", "Steps", (a) => a.items.every((i) => !String(i.type).includes("Steps"))],
    ["hc_sync_status", "Steps", (a) => a.items.every((i) => !String(i.type).includes("Steps"))],
    ["hc_records", "Steps", (a) => a.items.length === 0],
    ["hc_aggregate", "Steps", (a) => a.items.length === 0],
    ["hr_series", "HeartRate", (a) => a.items.length === 0],
    ["hr_events", "HeartRate", (a) => a.items.length === 0],
    ["sleep_sessions", "HeartRate", (a) => a.items.every((i) => !Object.hasOwn(i, "hr"))],
    [
      "exercise_sessions",
      "Steps",
      (a) => a.items.every((i) => !Object.hasOwn(i, "likelyLeftRunning")),
    ],
    ["blood_pressure", "BloodPressure", (a) => a.items.length === 0],
    ["daily_summary", "SkinTemperature", (a) => !JSON.stringify(a.items).includes("skinTempDelta")],
    ["data_quality", "HeartRate", (a) => a.items.every((i) => i.resourceType !== "hc:HeartRate")],
  ];

  it.each(cases)("%s withholds hc:%s", async (name, type, check) => {
    const before = await call(name, argsOf(name));
    await repos.mcpPolicy.add("resource", `hc:${type}`);

    const answer = await call(name, argsOf(name));

    expect(answer.isError, answer.text).toBe(false);
    // The rule changed the answer, and what it names is gone from it.
    expect(check(before)).toBe(false);
    expect(check(answer)).toBe(true);
    expect(answer.coverage.some((entry) => entry.resourceType === `hc:${type}`)).toBe(false);
  });

  it("follows a platform aggregate to the type it aggregates", async () => {
    await repos.mcpPolicy.add("resource", "hc:Steps");

    const raw = await call("hc_records", { type: "Agg.Steps", ...RANGE });

    expect(raw.items).toStrictEqual([]);
    expect(raw.warnings).toContain("policy_resource_denied:hc:Steps");
  });
});

describe("a field rule", () => {
  it("removes a field from a phone's rows, scoped to its type and to the phone", async () => {
    const before = await call("blood_pressure", argsOf("blood_pressure"));
    await repos.mcpPolicy.addField({
      target: "test:bp-origin",
      effect: "hide",
      tool: null,
      resourceType: "hc:BloodPressure",
      healthSystemId: seeded.source,
      paths: ["origins", "readings[].origin"],
    });

    const answer = await call("blood_pressure", argsOf("blood_pressure"));
    const nights = await call("sleep_sessions", argsOf("sleep_sessions"));

    expect(before.text).toContain(CUFF);
    expect(answer.text).not.toContain(CUFF);
    expect(answer.items[0]).toMatchObject({ systolic: 119, readingCount: 2 });
    expect(answer.warnings).toContain("policy_field_removed:hc:BloodPressure.origins");
    // Another type's rows keep theirs.
    expect(nights.items[0]?.origin).toBe(WEARABLE);
  });
});

/** The real clock an hour past the staleness limit: the upload happened moments ago. */
function later(): number {
  return Math.floor(Date.now() / 1000) + HC_STALE_AFTER_SECONDS + 3600;
}

/** Words a client must never be handed about a type the phone has nothing of. */
const BLAME = /permission|permitted|denied|unsupported|grant|not_available|never_synced/iu;

describe("why an answer is empty", () => {
  it("lists only the types with stored records, whatever the phone may read", async () => {
    const answer = await call("hc_coverage", { devices: [seeded.source], origins: false });
    const status = await call("hc_sync_status", { devices: [seeded.source] });
    const byType = new Map(answer.items.map((item) => [item.type, item]));

    // Refused, not offered by the phone, and allowed but empty: none is listed.
    for (const type of ["BodyTemperature", "OxygenSaturation", "Hydration"]) {
      expect(byType.has(type), type).toBe(false);
      expect(
        status.items.some((item) => item.type === type),
        type,
      ).toBe(false);
    }
    expect(byType.get("Steps")).toMatchObject({ availability: "ok", recordCount: 20 });
    expect(answer.warnings).toStrictEqual([]);
    expect(JSON.stringify([answer.items, answer.coverage, status.items])).not.toMatch(BLAME);
  });

  it("answers a named type with no records the same way, whatever the reason", async () => {
    const devices = [seeded.source];
    const refused = await call("hc_records", { devices, type: "BodyTemperature", ...RANGE });
    const empty = await call("hc_aggregate", { devices, type: "Hydration", ...LOCAL_DAYS });
    const named = await call("hc_coverage", { devices, types: ["OxygenSaturation"] });
    const unknown = await call("hc_records", { devices, type: "NotARecordType", ...RANGE });

    expect(refused.items).toStrictEqual([]);
    expect(refused.warnings).toStrictEqual([`no_data:hc:BodyTemperature:${seeded.source}`]);
    expect(refused.coverage[0]).toMatchObject({ status: "ok", recordCount: 0 });
    expect(empty.items.every((item) => item.hasData === false)).toBe(true);
    expect(empty.warnings).toStrictEqual([`no_data:hc:Hydration:${seeded.source}`]);
    expect(named.items).toStrictEqual([
      expect.objectContaining({ type: "OxygenSaturation", availability: "no_data" }),
    ]);
    expect(unknown.warnings).toStrictEqual(["unknown_type:hc:NotARecordType"]);
    expect(JSON.stringify([refused, empty, named].map((answer) => answer.items))).not.toMatch(
      BLAME,
    );
  });

  it("calls the phone stale once six hours pass without an upload, and still returns its data", async () => {
    const devices = [seeded.source];

    const fresh = await call("hc_sync_status", { devices });
    const stale = await call("hc_sync_status", { devices }, later);
    const steps = await call("hc_records", { devices, type: "Steps", ...RANGE }, later);

    expect(fresh.items[0]).toMatchObject({ kind: "device", status: "active" });
    expect(stale.items[0]).toMatchObject({ kind: "device", status: "stale", hoursSinceUpload: 7 });
    expect(steps.items).toHaveLength(20);
    expect(steps.coverage[0]).toMatchObject({ status: "stale", ageHours: 7 });
    expect(steps.warnings).toStrictEqual([`stale:hc:Steps:${seeded.source}:7h`]);
  });

  it("answers `no_data` for a phone that has never uploaded, and lists nothing for it", async () => {
    const idle = `device:${seeded.idleDeviceId}`;

    const answer = await call("hc_records", { devices: [idle], type: "Steps", ...RANGE });
    const listed = await call("hc_coverage", { devices: [idle] });
    const status = await call("hc_sync_status", { devices: [idle] });

    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings).toStrictEqual([`no_data:hc:Steps:${idle}`]);
    expect(listed.items).toStrictEqual([]);
    expect(status.items).toStrictEqual([
      expect.objectContaining({ kind: "device", status: "never", lastUploadAt: null, records: 0 }),
    ]);
  });
});

/** The seeded phone, as a `devices` argument. */
function devices(): string[] {
  return [seeded.source];
}

/** The summed step count of an aggregate answer's rows. */
function stepSum(answer: Answer): number {
  return answer.items.reduce(
    (total, item) => total + (item.values as { count: { sum: number } }).count.sum,
    0,
  );
}

describe("what the real store hands back", () => {
  it("round-trips a record losslessly through the route, the runner and the sealed chunk", async () => {
    const answer = await call("hc_records", {
      devices: devices(),
      type: "BloodPressure",
      ...RANGE,
      tz: "UTC",
    });

    expect(answer.items.map((item) => [item.id, item.origin])).toStrictEqual([
      ["bp-1", CUFF],
      ["bp-1-relayed", PHONE],
      ["bp-2", CUFF],
    ]);
    expect(answer.items[0]).toMatchObject({
      resourceType: "hc:BloodPressure",
      time: instant(at(9)).replace(".000Z", "+00:00"),
      data: { systolic: 121, diastolic: 79, bodyPosition: "SITTING_DOWN" },
    });
    expect(answer.body.units).toStrictEqual({ systolic: "mmHg", diastolic: "mmHg" });
  });

  it("answers a local day from the day rollups the runner built for the configured zone", async () => {
    const answer = await call("hc_aggregate", {
      devices: devices(),
      type: "Steps",
      ...LOCAL_DAYS,
      origin_mode: "all_separately",
    });
    const priority = await call("hc_aggregate", {
      devices: devices(),
      type: "Steps",
      ...LOCAL_DAYS,
    });

    expect(answer.body.answeredFrom).toStrictEqual(["day_rollup"]);
    expect(
      answer.items.map((item) => [item.bucket, (item.origins as string[])[0], item.hasData]),
    ).toStrictEqual([
      [LOCAL_DAY_BEFORE, PHONE, false],
      [LOCAL_DAY_BEFORE, WEARABLE, false],
      [LOCAL_DAY, PHONE, true],
      [LOCAL_DAY, WEARABLE, true],
    ]);
    expect(answer.items[3]).toMatchObject({
      start: `${LOCAL_DAY}T00:00:00-05:00`,
      values: { count: { sum: 5000 } },
    });
    // The platform's hours where the phone uploaded them, the wearable's elsewhere.
    expect(priority.items[1]).toMatchObject({
      method: "platform_and_max_origin",
      origins: [WEARABLE, PLATFORM],
      values: { count: { sum: 4 * 520 + 6 * 500 } },
    });
  });

  it("gives the same totals from hour rollups in another zone, and from raw records by the quarter hour", async () => {
    const range = { start: instant(at(8)), end: instant(at(12)) };
    const mode = `origin:${WEARABLE}`;

    const hourly = await call("hc_aggregate", {
      devices: devices(),
      type: "Steps",
      ...range,
      bucket: "hour",
      tz: "UTC",
      origin_mode: mode,
    });
    const quarters = await call("hc_aggregate", {
      devices: devices(),
      type: "Steps",
      ...range,
      bucket: "15min",
      origin_mode: mode,
    });

    expect(hourly.body.answeredFrom).toStrictEqual(["hour_rollup"]);
    expect(quarters.body.answeredFrom).toStrictEqual(["raw"]);
    expect(hourly.items).toHaveLength(4);
    expect(quarters.items).toHaveLength(16);
    expect(stepSum(hourly)).toBe(2000);
    expect(stepSum(quarters)).toBe(2000);
  });

  it("reads heart rate from the stored minute rows, the artefact taken out", async () => {
    const answer = await call("hr_series", {
      devices: devices(),
      start: instant(at(8, 20)),
      end: instant(at(9)),
    });

    expect(answer.body).toMatchObject({ resolution: "1min", totalPoints: 40, decimated: false });
    expect(answer.items).toHaveLength(40);
    expect(answer.items[10]).toMatchObject({ origin: WEARABLE, mean: 105, n: 1 });
    expect(answer.items.every((item) => Number(item.max) <= 200)).toBe(true);
    expect(answer.warnings).toContain("hr_artefacts_dropped:1");
  });

  it("finds the rise in the stored minutes", async () => {
    const answer = await call("hr_events", { devices: devices(), ...RANGE });

    expect(answer.items).toStrictEqual([
      expect.objectContaining({ baselineBpm: 62, peakBpm: 105, deltaBpm: 43, durationS: 360 }),
    ]);
  });

  it("returns the night the runner summarised, with its overnight joins", async () => {
    const answer = await call("sleep_sessions", {
      devices: devices(),
      ...RANGE,
      include_stages: true,
    });

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      inBedMin: 480,
      asleepMin: 460,
      awakeMin: 20,
      stageMin: { DEEP: 120, REM: 120 },
      hrv: { median: 43, n: 7 },
      respiratoryRate: 14,
      restingHr: 52,
      origin: WEARABLE,
    });
    expect((answer.items[0]?.hr as { min: number }).min).toBe(54);
    expect(answer.items[0]?.stages).toHaveLength(5);

    // The night and its members carry the id hc_records gives the SleepSession record.
    const raw = await call("hc_records", { devices: devices(), type: "SleepSession", ...RANGE });
    const rawIds = raw.items.map((item) => item.id);
    expect(rawIds).toHaveLength(1);
    expect([answer.items[0]?.id]).toStrictEqual(rawIds);
    expect((answer.items[0]?.members as { id: string }[]).map((m) => m.id)).toStrictEqual(rawIds);
  });

  it("returns the workouts the runner summarised, the forgotten one flagged", async () => {
    const answer = await call("exercise_sessions", { devices: devices(), ...RANGE });

    expect(
      answer.items.map((item) => [item.exerciseType, item.durationMin, item.likelyLeftRunning]),
    ).toStrictEqual([
      ["WALKING", 40, false],
      ["OTHER_WORKOUT", 240, true],
    ]);
    expect(answer.items[0]).toMatchObject({
      title: "Evening walk",
      distance: 3000,
      origin: WEARABLE,
    });
    expect((answer.items[0]?.hr as { mean: number }).mean).toBe(128);
  });

  it("dedupes and groups blood pressure, with the cuff's pulse from its minute row", async () => {
    const answer = await call("blood_pressure", { devices: devices(), ...RANGE });

    expect(answer.warnings).toStrictEqual(["hc_duplicates_dropped:1"]);
    expect(answer.items).toStrictEqual([
      expect.objectContaining({
        kind: "session",
        systolic: 119,
        diastolic: 78,
        pulse: 68,
        readingCount: 2,
        origins: [CUFF],
      }),
    ]);
  });

  it("joins the day", async () => {
    const answer = await call("daily_summary", { devices: devices(), date: LOCAL_DAY });

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      resourceType: "hc:DailySummary",
      date: LOCAL_DAY,
      steps: 4 * 520 + 6 * 500,
      distance: 3000,
      activeKcal: 200,
      totalKcal: 1000,
      sleep: { asleepMin: 460 },
      restingHr: 52,
      // The two readings after local midnight: the night's earlier ones were the day before.
      hrvRmssd: 45.5,
      bloodPressure: { systolic: 119, diastolic: 78, readings: 2 },
      weight: 70.5,
    });
    expect(answer.items[0]?.flags).toStrictEqual(
      expect.arrayContaining([
        "bp_duplicates_dropped",
        "resting_hr_cuff_pulse_excluded",
        "weight_profile_artefact_excluded",
        "exercise_likely_left_running",
      ]),
    );
  });

  it("reports what to read with care", async () => {
    const answer = await call("data_quality", {
      devices: devices(),
      ...RANGE,
      max_bytes: 1_000_000,
    });
    const kinds = answer.items.map((item) => `${String(item.resourceType)}:${String(item.kind)}`);

    expect(kinds).toStrictEqual(
      expect.arrayContaining([
        "hc:BloodPressure:duplicate",
        "hc:HeartRate:artefact",
        "hc:Weight:artefact",
        "hc:ExerciseSession:likely_left_running",
        "hc:Steps:overlapping_origins",
        "hc:FloorsClimbed:noisy_series",
      ]),
    );
  });

  it("reports the pipeline and the phone's own flags", async () => {
    const answer = await call("hc_sync_status", { devices: devices() });

    expect(answer.items[0]).toMatchObject({
      kind: "device",
      healthSystem: "Test phone",
      status: "active",
      appVersion: "0.1.9",
      backgroundRead: true,
      batteryOptimisationExempt: false,
      backfillComplete: true,
      androidSdk: 37,
      queuedBatches: 0,
      rollupsPending: 0,
      recentBatches: 1,
      recentFailures: [],
    });
    expect(answer.items.find((item) => item.type === "Steps")).toMatchObject({
      kind: "type_sync",
      recordCount: 20,
      tokenAgeS: 60,
    });
  });

  it("names the apps behind a type, read out of the sealed chunks", async () => {
    const answer = await call("hc_coverage", { devices: devices(), types: ["BloodPressure"] });

    expect(answer.items).toStrictEqual([
      expect.objectContaining({
        type: "BloodPressure",
        recordCount: 3,
        origins: [CUFF, PHONE],
        lastRecordFrom: expect.objectContaining({ origin: CUFF }),
      }),
    ]);
  });

  it("pages a long answer by the byte budget and resumes from the cursor", async () => {
    const args = { devices: devices(), type: "Steps", ...RANGE };
    const whole = await call("hc_records", args);
    const first = await call("hc_records", { ...args, max_bytes: 1200 });
    const rest = await call("hc_records", { ...args, cursor: first.body.cursor });

    expect(whole.body.truncated).toBe(false);
    expect(first.body.truncated).toBe(true);
    expect(first.items.length).toBeLessThan(whole.items.length);
    expect([...first.items, ...rest.items]).toStrictEqual(whole.items);
    expect(rest.body.cursor).toBeUndefined();
  });

  it("adds the phone's lines to get_health_summary", async () => {
    const answer = await call("get_health_summary", { jq: '.[] | select(.kind == "phone")' });
    const mine = answer.items.filter((item) => item.healthSystemId === seeded.source);

    expect(mine.map((item) => item.section)).toStrictEqual([
      "sync",
      "latest_blood_pressure",
      "last_night_sleep",
    ]);
    expect(mine[1]).toMatchObject({ systolic: 117, diastolic: 77, origin: CUFF });
    expect(mine[2]).toMatchObject({ asleepMin: 460, origin: WEARABLE });
  });
});

/** One synthetic workout, titled by its id. */
function workout(id: string, type: string, startMs: number, endMs: number, origin: string) {
  return interval(
    id,
    "ExerciseSession",
    startMs,
    endMs,
    { exerciseType: type, title: id },
    { origin },
  );
}

describe("overlapping workouts, whatever order the phone sent them in", () => {
  // The backfill sends the newest month first, so the older half of an
  // overlapping pair can arrive batches after the summary of the newer half was
  // built. Which sessions are one row is decided when the tool answers, from
  // every stored summary in range, so the order cannot matter. Kept last in the
  // file: it pairs a third phone.
  const BASE = DAY - 40 * DAY_MS;
  const on = (hour: number, minute = 0): number => BASE + hour * HOUR_MS + minute * MINUTE_MS;
  const paired = { source: "" };

  beforeAll(async () => {
    const { device, token } = await repos.devices.mint("Overlap phone");
    paired.source = `device:${device.id}`;
    const batches = [
      // First: the newer sessions. A run across UTC midnight, the one after it, one app's ride.
      [
        workout("run-late", "RUNNING", on(23, 40), on(24, 20), PHONE),
        workout("run-last", "RUNNING", on(24, 10), on(24, 40), PHONE),
        workout("ride-copy", "BIKING", on(10, 10), on(11, 5), PHONE),
      ],
      // Batches later: the older session each of them overlaps, and another activity inside one.
      [
        workout("run-early", "RUNNING", on(23), on(23, 50), WEARABLE),
        workout("ride", "BIKING", on(10), on(11), WEARABLE),
        workout("stretch", "YOGA", on(10, 20), on(10, 40), WEARABLE),
      ],
    ];
    for (const upserts of batches) {
      const response = await upload(token, {
        v: 1,
        deviceId: device.id,
        appVersion: "0.1.9",
        batchId: crypto.randomUUID(),
        phoneTime: Date.now(),
        upserts,
        deletes: [],
        syncState: {
          types: [{ type: "ExerciseSession", permission: "granted", tokenAgeS: 60, backlog: 0 }],
          backgroundRead: true,
          historyRead: true,
          batteryExempt: false,
          backfillComplete: false,
          androidSdk: 37,
        },
      });
      if (response.status !== 200) throw new Error(`ingest answered ${String(response.status)}`);
      // Each batch is applied and summarised before the next arrives.
      await settle(device.id);
    }
  }, 120_000);

  it("puts every overlapping pair of one type in one row, and no other pair", async () => {
    const answer = await call("exercise_sessions", {
      devices: [paired.source],
      start: instant(BASE),
      end: instant(BASE + 2 * DAY_MS),
    });

    expect(
      answer.items.map((item) => [
        item.exerciseType,
        item.title,
        item.mergedSessions,
        item.durationMin,
        item.spanMin,
      ]),
    ).toStrictEqual([
      ["BIKING", "ride", 2, 60, 65],
      ["YOGA", "stretch", 1, 20, 20],
      // A chain: early overlaps late, late overlaps last, early does not reach last.
      ["RUNNING", "run-early", 3, 50, 100],
    ]);
    // The row's own times are its longest session's; the span is what holds every member.
    const run = answer.items[2] ?? {};
    expect(
      [run.start, run.end, run.spanStart, run.spanEnd].map((time) => Date.parse(String(time))),
    ).toStrictEqual([on(23), on(23, 50), on(23), on(24, 40)]);
    expect(run.origins).toStrictEqual([PHONE, WEARABLE]);
    // Every member, and the row itself, is named by the id hc_records gives that record.
    const raw = await call("hc_records", {
      devices: [paired.source],
      type: "ExerciseSession",
      start: instant(BASE),
      end: instant(BASE + 2 * DAY_MS),
    });
    const memberIds = answer.items.flatMap((item) =>
      (item.members as { id: string }[]).map((member) => member.id),
    );
    expect(memberIds).toHaveLength(6);
    expect(new Set(memberIds)).toStrictEqual(
      new Set(["ride", "ride-copy", "run-early", "run-last", "run-late", "stretch"]),
    );
    expect(raw.items).toHaveLength(6);
    expect(new Set(raw.items.map((item) => item.id))).toStrictEqual(new Set(memberIds));
    expect(answer.items.map((item) => item.id)).toStrictEqual(["ride", "stretch", "run-early"]);
    for (const row of answer.items) {
      for (const member of row.members as { start: string; end: string }[]) {
        expect(Date.parse(member.start)).toBeGreaterThanOrEqual(Date.parse(String(row.spanStart)));
        expect(Date.parse(member.end)).toBeLessThanOrEqual(Date.parse(String(row.spanEnd)));
      }
    }
  });
});
