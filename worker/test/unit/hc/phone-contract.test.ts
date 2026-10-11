// The phone and the Worker agree on the wire, checked from both sides.
//
// `worker/test/fixtures/hc/phone-batches.json` is written by the Android
// project's own unit test (`PhoneBatchFixtureTest`), from its real serializer
// and batcher, and that test fails if the checked-in file is not what it would
// write. This test runs every one of those batches through the Worker's
// validator. Together they mean neither side can change the contract alone: a
// mapper that emits something `wire.ts` refuses fails here, and a `wire.ts`
// that tightens fails here too.
//
// The records are synthetic by construction: invented values and
// `com.example.*` package names.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rollupFieldsFor } from "../../../src/hc/rollup/hour.ts";
import { exceedsRecordLimit, parseBatch } from "../../../src/hc/wire.ts";

interface FixtureBatch {
  name: string;
  expect: { upserts: number; deletes: number; rejected: number; hasSyncState: boolean };
  body: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "../../fixtures/hc/phone-batches.json"), "utf8"),
) as { batches: FixtureBatch[] };

describe("batches the phone really builds", () => {
  it("come with at least the kinds the engine sends", () => {
    const names = fixture.batches.map((batch) => batch.name);

    expect(names).toStrictEqual(
      expect.arrayContaining(["changes", "backfill-month", "deletes-only", "state-only"]),
    );
  });

  it.each(fixture.batches.map((batch) => [batch.name, batch] as const))(
    "%s passes the Worker's validator with nothing rejected",
    (_name, batch) => {
      const parsed = parseBatch(batch.body);

      expect(exceedsRecordLimit(batch.body)).toBe(false);
      expect(parsed).not.toBeNull();
      expect(parsed?.rejected).toStrictEqual([]);
      expect(parsed?.upserts).toHaveLength(batch.expect.upserts);
      expect(parsed?.deletes).toHaveLength(batch.expect.deletes);
      expect(parsed?.syncState !== undefined).toBe(batch.expect.hasSyncState);
    },
  );

  it("names every summarised field the way the rollups read it", () => {
    // One fully populated record per mapped type lives in the `changes` batch.
    // Every scalar field the rollup table says a type has must be present on
    // that type's record, or the rollup would quietly summarise nothing.
    const changes = fixture.batches.find((batch) => batch.name === "changes");
    const parsed = parseBatch(changes?.body);
    const records = parsed?.upserts ?? [];
    const missing: string[] = [];
    for (const record of records) {
      const present = new Set(Object.keys(record.data));
      for (const field of rollupFieldsFor(record.type)) {
        const root = field.path.split(/[.[]/u, 1)[0] ?? field.path;
        if (!present.has(root)) missing.push(`${record.type}.${root}`);
      }
    }

    expect(records.length).toBeGreaterThan(30);
    expect(missing).toStrictEqual([]);
  });
});
