// `data_quality` over a range of years, against the real store: real D1, real
// sealed rollups and session summaries, the real tool through the real
// `ToolDeps`.
//
// One request cannot open years of the store, so the tool walks the range half
// a year at a time and reads at most two windows a call. What this pins is that
// the stopping is honest and loses nothing: a page that stopped short says
// `truncated` and carries a cursor even when it found little, the pages of a
// long range together hold exactly the findings of the same range asked a few
// months at a time, and none is repeated.
//
// Everything is synthetic: invented sessions and readings, RFC 2606 style
// package names, and a zone that is a test parameter.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { storeBacklog } from "../../../src/hc/store/read.ts";
import { makeToolDeps } from "../../../src/mcp/deps-d1.ts";
import { registerTools } from "../../../src/mcp/tools/index.ts";
import { resetDb } from "../db/helpers.ts";
import { drain, enqueue, instant, interval, withoutTrello } from "../hc/helpers.ts";

import type { Env } from "../../../src/env.ts";
import type { HcRecord } from "../../../src/hc/wire.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const ZONE = "Etc/GMT+5";
const TIMEOUT = 120_000;

// The runtime's own key seals and opens, as in production.
const RUNTIME_ENV: Env = withoutTrello(env);
const ctx = makeCtx(env.DB, RUNTIME_ENV);
const repos = makeRepos(ctx);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The clock the tool sees, and the end of the history: an arbitrary noon. */
const NOW_MS = Date.UTC(2026, 5, 1, 12);
/** Three and a half years of history before it. */
const HISTORY_DAYS = 1280;
const START_MS = NOW_MS - HISTORY_DAYS * DAY_MS;
const iso = (ms: number): string => new Date(ms).toISOString();

const seeded = { source: "" };

/**
Something to find every few weeks, for three and a half years: a session
nobody stopped (four hours, nothing measured during it), and a
blood-pressure reading a second app wrote again.
*/
function history(): HcRecord[] {
  const records: HcRecord[] = [];
  for (let day = 5; day < HISTORY_DAYS; day += 47) {
    const at = START_MS + day * DAY_MS;
    records.push(
      interval(`left-${String(day)}`, "ExerciseSession", at, at + 4 * HOUR_MS, {
        exerciseType: "YOGA",
      }),
    );
  }
  for (let day = 20; day < HISTORY_DAYS; day += 83) {
    const at = START_MS + day * DAY_MS + 9 * HOUR_MS;
    const reading = { systolic: 120 + (day % 7), diastolic: 80 };
    records.push(
      instant(`bp-${String(day)}`, "BloodPressure", at, reading, { origin: "com.example.cuff" }),
      instant(`bp-copy-${String(day)}`, "BloodPressure", at, reading, {
        origin: "com.example.phone",
        lastModified: 2000,
      }),
    );
  }
  return records;
}

beforeAll(async () => {
  await resetDb();
  await setSetting(ctx, "timezone", ZONE);
  const { device } = await repos.devices.mint("Test phone");
  seeded.source = `device:${device.id}`;
  await enqueue(repos, device.id, { batchId: "batch-0001", upserts: history() });
  await drain(ctx, device.id);
  const backlog = await storeBacklog(ctx, device.id);
  if (backlog.dirty !== 0 || backlog.queuedBatches !== 0) throw new Error("the store is not idle");
}, TIMEOUT);

interface Page {
  items: Record<string, unknown>[];
  total: number;
  truncated: boolean;
  cursor?: string;
  warnings: string[];
}

async function call(args: Record<string, unknown>): Promise<Page> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({
      env: RUNTIME_ENV,
      caller: { clientId: "client-int", grantId: "grant-int" },
      now: () => NOW_MS / 1000,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const result = (await client.callTool({
    name: "data_quality",
    arguments: { devices: [seeded.source], tz: ZONE, ...args },
  })) as CallToolResult;
  const [first] = result.content;
  if (result.isError === true || first?.type !== "text") {
    throw new Error(first?.type === "text" ? first.text : "no text answer");
  }
  return JSON.parse(first.text) as Page;
}

/** Every page of one question, following each cursor to the end. */
async function pagesOf(args: Record<string, unknown>): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await call({ ...args, ...(cursor !== undefined && { cursor }) });
    pages.push(page);
    if (!page.truncated) return pages;
    if (page.cursor === undefined) throw new Error("a truncated page without a cursor");
    ({ cursor } = page);
    if (pages.length > 200) throw new Error("the cursors do not converge");
  }
}

const rowsOf = (pages: readonly Page[]): string[] =>
  pages.flatMap((page) => page.items.map((item) => JSON.stringify(item)));
const inOrder = (rows: readonly string[]): string[] => {
  const out = [...rows];
  // Code-unit order: the rows are only compared with each other.
  out.sort((left, right) => (left < right ? -1 : Number(left > right)));
  return out;
};

const WHOLE = { start: iso(START_MS), end: iso(NOW_MS) };

describe("data_quality over three and a half years", () => {
  it(
    "comes back in pages, each saying it is not the end until the last",
    async () => {
      const pages = await pagesOf({ ...WHOLE, max_bytes: 10_000_000 });

      // Seven windows of half a year, two to a call.
      expect(pages).toHaveLength(4);
      expect(pages.map((page) => page.truncated)).toStrictEqual([true, true, true, false]);
      expect(pages.at(-1)?.cursor).toBeUndefined();
      // `total` is the findings so far, and only on the last page all of them.
      const totals = pages.map((page) => page.total);
      expect(totals.every((total, index) => total >= (totals[index - 1] ?? 0))).toBe(true);
      expect(totals.at(-1)).toBe(rowsOf(pages).length);
      expect(totals[0]).toBe(pages[0]?.items.length);
      expect(totals[0]).toBeLessThan(totals.at(-1) ?? 0);
    },
    TIMEOUT,
  );

  it(
    "holds, over its pages, exactly what the same range holds asked a few months at a time",
    async () => {
      const pages = await pagesOf({ ...WHOLE, max_bytes: 10_000_000 });

      // Four months is less than a window: each of these is one call, whole.
      const pieces: Page[] = [];
      for (let from = START_MS; from < NOW_MS; from += 120 * DAY_MS) {
        const piece = await call({
          start: iso(from),
          end: iso(Math.min(from + 120 * DAY_MS, NOW_MS)),
          max_bytes: 10_000_000,
        });
        expect(piece.truncated).toBe(false);
        pieces.push(piece);
      }

      const paged = rowsOf(pages);
      expect(new Set(paged).size).toBe(paged.length);
      expect(inOrder(paged)).toStrictEqual(inOrder(rowsOf(pieces)));
      // Every session nobody stopped, and every reading written twice.
      const kinds = pages.flatMap((page) => page.items.map((item) => String(item.kind)));
      expect(kinds.filter((kind) => kind === "likely_left_running")).toHaveLength(28);
      expect(kinds.filter((kind) => kind === "long_session")).toHaveLength(28);
      expect(kinds.filter((kind) => kind === "duplicate")).toHaveLength(16);
    },
    TIMEOUT,
  );

  it(
    "returns the same findings, in the same order, however small the byte budget",
    async () => {
      const whole = await pagesOf({ ...WHOLE, max_bytes: 10_000_000 });
      const small = await pagesOf({ ...WHOLE, max_bytes: 600 });

      expect(small.length).toBeGreaterThan(whole.length);
      expect(rowsOf(small)).toStrictEqual(rowsOf(whole));
      expect(small.slice(0, -1).every((page) => page.truncated && page.cursor !== undefined)).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  it(
    "says truncated on a page that found nothing, when the range goes on",
    async () => {
      // Only heart rate is asked about, and there is none: nothing to find
      // anywhere, and still more than one call's worth of range to say so for.
      const first = await call({ ...WHOLE, types: ["HeartRate"] });

      expect(first.items).toStrictEqual([]);
      expect(first.truncated).toBe(true);
      expect(first.cursor).toBeDefined();
    },
    TIMEOUT,
  );
});
