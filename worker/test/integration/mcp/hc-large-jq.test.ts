// `hc_records` with a `jq` projection over records far larger than jq can hold
// at once, against the real store.
//
// An exercise session can carry a GPS route of thousands of points, so a few
// hundred sessions are tens of megabytes of rows while the two fields a caller
// usually wants from each are a few kilobytes in all. The jq engine's memory
// stops at 64 MiB, which holds roughly 6 MB of such rows; a `.[] | ...`
// program is therefore run over the items a piece at a time
// (`runJqOverItems`, worker/src/mcp/jq/engine.ts), and this file holds the
// tool to the result: every matching record's projection comes back, however
// large the records were. A program that needs the whole array at once still
// has to fit, and says so when it does not.
//
// Everything is synthetic: invented sessions on an invented week, routes that
// are a straight line of made-up coordinates, an RFC 2606 style origin.

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
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "../../../src/app.ts";
import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { storeBacklog } from "../../../src/hc/store/read.ts";
import { INGEST_PATH } from "../../../src/ingest/route.ts";
import { makeToolDeps } from "../../../src/mcp/deps-d1.ts";
import { registerTools } from "../../../src/mcp/tools/index.ts";
import { HOUR_MS, MINUTE_MS, interval } from "../../unit/mcp/hc-fake.ts";
import { resetDb } from "../db/helpers.ts";

import type { Env } from "../../../src/env.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const ORIGIN = "https://healthy.example";
// `Cloudflare.Env` types the namespaces more narrowly than the hand-written Env.
const RUNTIME_ENV = env as unknown as Env;
const ctx = makeCtx(env.DB, RUNTIME_ENV);
const repos = makeRepos(ctx);

/** How many sessions the phone holds, one starting every hour. */
const SESSIONS = 240;
/** Every tenth session carries a route: 24 of them. */
const ROUTE_EVERY = 10;
/** Points in such a route: about half a megabyte of JSON once its times are ISO-8601. */
const ROUTE_POINTS = 6000;
/** Route-bearing sessions per upload, which keeps a batch under the route's 16 MiB. */
const ROUTES_PER_UPLOAD = 8;

/** The invented week ends at the last whole UTC hour before the real clock. */
const END = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
const FIRST = END - SESSIONS * HOUR_MS;
const startOf = (index: number): number => FIRST + index * HOUR_MS;
const endOf = (index: number): number => startOf(index) + 30 * MINUTE_MS;
const hasRoute = (index: number): boolean => index % ROUTE_EVERY === 0;

const RANGE = { start: new Date(FIRST).toISOString(), end: new Date(END).toISOString() };
const toolNow = (): number => END / 1000 + 600;

const seeded = { source: "" };

/** A straight line of invented coordinates, one point every 300 ms of the session. */
function route(startMs: number): Record<string, number>[] {
  const points: Record<string, number>[] = [];
  for (let point = 0; point < ROUTE_POINTS; point += 1) {
    points.push({
      t: startMs + point * 300,
      lat: 10.5 + point * 0.0000125,
      lon: 20.25 + point * 0.0000175,
      alt: 30.48 + (point % 97) * 0.25,
      hAcc: 4.5 + (point % 7) * 0.5,
      vAcc: 6.25,
    });
  }
  return points;
}

function session(index: number): HcRecord {
  const startMs = startOf(index);
  return interval(
    `session-${String(index).padStart(3, "0")}`,
    "ExerciseSession",
    startMs,
    endOf(index),
    {
      exerciseType: hasRoute(index) ? "RUNNING" : "WALKING",
      title: `Session ${String(index)}`,
      ...(hasRoute(index) && { route: route(startMs) }),
    },
  );
}

async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** POST one batch to the real ingest route, as the companion app would, and require it whole. */
async function upload(
  token: string,
  deviceId: string,
  records: readonly HcRecord[],
): Promise<void> {
  const execution = createExecutionContext();
  const batch = {
    v: 1,
    deviceId,
    appVersion: "0.1.9",
    batchId: crypto.randomUUID(),
    phoneTime: Date.now(),
    upserts: records,
    deletes: [],
    syncState: {
      types: [{ type: "ExerciseSession", permission: "granted", tokenAgeS: 60, backlog: 0 }],
      backgroundRead: true,
      historyRead: true,
      batteryExempt: false,
      backfillComplete: true,
      androidSdk: 37,
    },
  };
  const request = new Request(ORIGIN + INGEST_PATH, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: await gzip(JSON.stringify(batch)),
  });
  const response = await app.fetch(request, RUNTIME_ENV, execution);
  await waitOnExecutionContext(execution);
  if (response.status !== 200) throw new Error(`ingest answered ${String(response.status)}`);
  const ack = await response.json<{ accepted: number; rejected: unknown[] }>();
  if (ack.accepted !== records.length || ack.rejected.length > 0) {
    throw new Error("the synthetic batch was not accepted whole");
  }
}

/** Let the runner's alarm chain run until the phone has nothing queued and nothing to rebuild. */
async function settle(deviceId: string): Promise<void> {
  const stub = env.HC_INGEST.getByName(deviceId);
  for (let attempt = 0; attempt < 2000; attempt += 1) {
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
  await setSetting(ctx, "timezone", "UTC");
  const { device, token } = await repos.devices.mint("Test phone");
  seeded.source = `device:${device.id}`;

  const indexes = Array.from({ length: SESSIONS }, (_unused, index) => index);
  const routed = indexes.filter((index) => hasRoute(index));
  // The routes go up a few sessions at a time, built as they are sent.
  for (let from = 0; from < routed.length; from += ROUTES_PER_UPLOAD) {
    const batch = routed.slice(from, from + ROUTES_PER_UPLOAD).map((index) => session(index));
    await upload(token, device.id, batch);
  }
  const plain = indexes.filter((index) => !hasRoute(index)).map((index) => session(index));
  await upload(token, device.id, plain);
  await settle(device.id);
}, 300_000);

interface Answer {
  isError: boolean;
  text: string;
  body: Record<string, unknown>;
  items: unknown[];
}

async function call(args: Record<string, unknown>): Promise<Answer> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({
      env: RUNTIME_ENV,
      caller: { clientId: "client-int", grantId: "grant-int" },
      now: toolNow,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = (await client.callTool({
    name: "hc_records",
    arguments: { devices: [seeded.source], type: "ExerciseSession", ...RANGE, ...args },
  })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  const body = JSON.parse(text) as Record<string, unknown>;
  return { isError: result.isError === true, text, body, items: (body.items ?? []) as unknown[] };
}

/** `[start, end]` of every session, as epoch ms, in start order. */
const EXPECTED = Array.from({ length: SESSIONS }, (_unused, index) => [
  startOf(index),
  endOf(index),
]);

const asMs = (rows: readonly unknown[]): number[][] =>
  rows.map((row) => (row as string[]).map((text) => Date.parse(text)));

describe("hc_records with jq over records larger than jq can hold at once", () => {
  it("projects every session, routes and all, with a `.[] | ...` program", async () => {
    const answer = await call({ max_bytes: 50_000_000, jq: ".[] | [.start, .end]" });

    expect(answer.isError ? answer.text : "").toBe("");
    expect(answer.body).toMatchObject({ total: SESSIONS, matched: SESSIONS, truncated: false });
    expect(answer.body.warnings).not.toContain("jq_result_empty");
    expect(asMs(answer.items)).toEqual(EXPECTED);
  }, 120_000);

  it("reads inside the large field of each record as it goes", async () => {
    const answer = await call({
      max_bytes: 50_000_000,
      jq: ".[] | select(.data.route != null) | {id, points: (.data.route | length), last: .data.route[-1].lat}",
    });

    const routed = Array.from({ length: SESSIONS / ROUTE_EVERY }, (_unused, slot) => ({
      id: `session-${String(slot * ROUTE_EVERY).padStart(3, "0")}`,
      points: ROUTE_POINTS,
      last: 10.5 + (ROUTE_POINTS - 1) * 0.0000125,
    }));
    expect(answer.isError ? answer.text : "").toBe("");
    expect(answer.body).toMatchObject({ total: SESSIONS, matched: routed.length });
    expect(answer.items).toEqual(routed);
  }, 120_000);

  it("pages what the program emitted, counting the whole answer on every page", async () => {
    const jq = ".[] | [.start, .end]";
    const first = await call({ jq, limit: 100 });
    const rest = await call({ jq, cursor: first.body.cursor, max_bytes: 50_000_000 });

    expect(first.body).toMatchObject({ total: SESSIONS, matched: SESSIONS, truncated: true });
    expect(first.items).toHaveLength(100);
    expect(rest.body).toMatchObject({ total: SESSIONS, matched: SESSIONS, truncated: false });
    expect(asMs([...first.items, ...rest.items])).toEqual(EXPECTED);
  }, 120_000);

  it("reports the first failing record's error and returns nothing", async () => {
    // Session 235 is a small one late in the answer, long after the first piece.
    const answer = await call({
      jq: String.raw`.[] | if .id == "session-235" then error("stop at \(.id)") else .id end`,
    });

    expect(answer.isError).toBe(true);
    expect(answer.body).toMatchObject({ error: "jq_error" });
    expect(answer.body.detail).toBe("jq: error: stop at session-235");
    expect(answer.body.items).toBeUndefined();
  }, 120_000);

  it("refuses a whole-array program that cannot fit, and says what would", async () => {
    const answer = await call({ jq: "length" });

    expect(answer.isError).toBe(true);
    expect(answer.body).toMatchObject({ error: "jq_out_of_memory" });
    expect(answer.body.detail).toContain("`.[] | ...`");
  }, 120_000);

  it("runs the same whole-array program once the large field is left out", async () => {
    const answer = await call({ jq: "length", fields: ["exerciseType"] });

    expect(answer.isError ? answer.text : "").toBe("");
    expect(answer.items).toEqual([SESSIONS]);
  }, 120_000);
});
