// Running a `.[] | ...` program over the items a piece at a time
// (`runJqOverItems`, worker/src/mcp/jq/engine.ts).
//
// The claim under test is equivalence: for every program `streamsPerItem`
// accepts, the pieces give exactly what one run over the whole array gives --
// the same outputs in the same order, or the same error -- and every program
// it does not accept is still run over the whole array. The pieces here are a
// few dozen characters, so a forty-item array is cut into dozens of them and
// every boundary a real answer could have is crossed.
//
// The items are invented: numbered rows with a nested list, nothing from a record.

import { describe, expect, it } from "vitest";

import { PIECE_CHARS, runJq, runJqOverItems, streamsPerItem } from "../../../src/mcp/jq/engine.ts";

interface Row {
  id: string;
  n: number;
  tag: string | null;
  points: { t: number; v: number }[];
}

const ITEMS: Row[] = Array.from({ length: 40 }, (_unused, index) => ({
  id: `row-${String(index).padStart(2, "0")}`,
  n: index,
  tag: index % 7 === 0 ? null : `t${String(index % 3)}`,
  points: Array.from({ length: index % 5 }, (_none, point) => ({ t: point, v: index * point })),
}));

/** Small enough that most pieces hold one or two rows. */
const TINY = 120;

/** Programs that start `.[] |` and stay inside their item. */
const PER_ITEM = [
  ".[] | [.id, .n]",
  ".[]|.id",
  "  .[]  |  .n",
  ".[ ] | .n",
  ".[]? | .id",
  ".[] | select(.n > 30) | {id, n}",
  ".[] | select(.tag == null) | .id",
  ".[] | .points[] | .v",
  ".[] | .id, .n",
  ".[] | . as $row | .points | length | [$row.id, .]",
  ".[] | .n as $n | .points | map(.v + $n) | add",
  ".[] | def twice: . * 2; .n | twice",
  ".[] | reduce .points[] as $p (0; . + $p.v)",
  ".[] | [limit(2; .points[])] | length",
  ".[] | first(.points[] | .v) // -1",
  ".[] | label $out | .points[] | if .v > 20 then break $out else .v end",
  '.[] | try (if .n == 3 then error("three") else .n end) catch .',
  ".[] | .tag // empty",
  ".[] | select(.n > 1000)",
  ".[] | empty",
  ".[] | null",
  ".[] | $__loc__",
  '.[] | .id | test("row-1")',
  ".[] | tojson | length",
  ".[] | [paths] | length",
  '.[] | .n | if . % 2 == 0 then "even" else "odd" end',
  ".[] |\n  select(.n < 3)\n  | .id",
];

/** The same shape, failing: at compile time, or at an item somewhere in the middle. */
const PER_ITEM_FAILING = [
  String.raw`.[] | if .n == 17 then error("stop at \(.id)") else .id end`,
  '.[] | if .n == 0 then error("first") else .id end',
  '.[] | if .n == 39 then error("last") else .id end',
  ".[] | if .n == 20 then error(null) else .id end",
  ".[] | if .n == 20 then error({code: .n}) else .id end",
  ".[] | .id | .nope",
  ".[] | .points | .[0] | .t | ltrimstr(1) | .x",
  ".[] | nosuchfunction",
  ".[] | )",
  ".[] |",
  '.[] | include "x"; .',
  ".[] | .n as [$a] | $a",
];

/** Programs that need the whole array, or might: each is run over all of it at once. */
const WHOLE_ARRAY: [string, unknown[]][] = [
  ["length", [40]],
  ["map(.n) | add", [780]],
  ["[.[] | .n] | length", [40]],
  ["sort_by(-.n) | .[0].id", ["row-39"]],
  ["group_by(.tag) | length", [4]],
  ["first(.[] | .id)", ["row-00"]],
  ["limit(3; .[]) | .n", [0, 1, 2]],
  ["[limit(3; .[] | .n)]", [[0, 1, 2]]],
  [".[] as $row | length", Array.from({ length: 40 }, () => 40)],
  ["def ids: .[] | .id; [ids] | length", [40]],
  ["# every id\n.[] | .id", ITEMS.map((row) => row.id)],
  [". | .[] | .n", ITEMS.map((row) => row.n)],
  [".[1:3] | .[] | .n", [1, 2]],
  [".[0] | .id", ["row-00"]],
  ["..[]? | numbers | select(. > 100)", [102, 117]],
  ["reduce .[] as $row (0; . + $row.n)", [780]],
  ["label $out | .[] | if .n == 2 then break $out else .n end", [0, 1]],
  [".[] |= .n | add", [780]],
  // Each of these could see or stop something beyond its own item.
  [".[] | if .n == 2 then halt else .n end", [0, 1]],
  ["[.[] | .n] | .[0], (.[] | select(. == 39))", [0, 39]],
  [".[] | select(.n < 2) | debug | .n", [0, 1]],
  [".[] | select(.n < 2) | stderr | .n", [0, 1]],
  ['.[] | select(.n == 0) | [.n, (try input catch "none")]', [[0, "none"]]],
  [".[] | select(.n == 0) | [inputs] | length", [0]],
  [".[] | select(.n == 0) | input_line_number", [0]],
];

describe("streamsPerItem", () => {
  it.each(PER_ITEM)("accepts %j", (program) => {
    expect(streamsPerItem(program)).toBe(true);
  });

  it.each(PER_ITEM_FAILING)("accepts %j, which fails the same either way", (program) => {
    expect(streamsPerItem(program)).toBe(true);
  });

  it.each(WHOLE_ARRAY.map(([program]) => program))("refuses %j", (program) => {
    expect(streamsPerItem(program)).toBe(false);
  });

  it("refuses a name that reaches beyond the item wherever it appears, strings included", () => {
    expect(streamsPerItem('.[] | select(.id == "halt")')).toBe(false);
    expect(streamsPerItem(".[] | .input")).toBe(false);
    expect(streamsPerItem(".[] | halt_error")).toBe(false);
    expect(streamsPerItem(".[] | .n # debug")).toBe(false);
  });
});

describe("a program run over the items a piece at a time", () => {
  it("cuts these items into many pieces at the size the tests use", () => {
    // Otherwise every case below would be one run and prove nothing.
    expect(JSON.stringify(ITEMS).length).toBeGreaterThan(TINY * 20);
    expect(PIECE_CHARS).toBeGreaterThan(TINY * 1000);
  });

  it.each(PER_ITEM)("gives what one run over the whole array gives: %j", async (program) => {
    const whole = await runJq(program, JSON.stringify(ITEMS));
    const inPieces = await runJqOverItems(program, ITEMS, TINY);

    expect(whole.ok).toBe(true);
    expect(inPieces).toEqual(whole);
  });

  it.each(PER_ITEM_FAILING)("fails exactly as one run does: %j", async (program) => {
    const whole = await runJq(program, JSON.stringify(ITEMS));
    const inPieces = await runJqOverItems(program, ITEMS, TINY);

    expect(whole.ok).toBe(false);
    expect(inPieces).toEqual(whole);
  });

  it.each(PER_ITEM)("is the same with one item to a piece: %j", async (program) => {
    expect(await runJqOverItems(program, ITEMS, 1)).toEqual(
      await runJq(program, JSON.stringify(ITEMS)),
    );
  });

  it.each(WHOLE_ARRAY)("runs %j over the whole array", async (program, expected) => {
    const run = await runJqOverItems(program, ITEMS, TINY);

    expect(run).toEqual({ ok: true, outputs: expected });
    expect(run).toEqual(await runJq(program, JSON.stringify(ITEMS)));
  });

  it("is one run over everything when the items fit in one piece", async () => {
    const program = ".[] | [.id, .n]";

    expect(await runJqOverItems(program, ITEMS)).toEqual(
      await runJq(program, JSON.stringify(ITEMS)),
    );
  });

  it("still compiles the program when there are no items", async () => {
    expect(await runJqOverItems(".[] | .id", [], TINY)).toEqual({ ok: true, outputs: [] });
    expect(await runJqOverItems(".[] | )", [], TINY)).toEqual(await runJq(".[] | )", "[]"));
    expect(await runJqOverItems(".[] | )", [], TINY)).toMatchObject({
      ok: false,
      code: "jq_error",
    });
  });

  it("writes an item that has no JSON form as null, as JSON.stringify does in an array", async () => {
    const items = [1, undefined, 3];

    expect(await runJqOverItems(".[] | [.]", items, 1)).toEqual(
      // eslint-disable-next-line unicorn/no-unsafe-json-serialization -- JSON.stringify's handling of undefined is the behaviour under comparison.
      await runJq(".[] | [.]", JSON.stringify(items)),
    );
  });

  it("keeps one step budget for the call, not one for each piece", async () => {
    // Each item burns tens of millions of units, so forty of them are far past
    // the budget of this input however it is cut.
    const program = ".[] | last(range(4000000))";
    const whole = await runJq(program, JSON.stringify(ITEMS));
    const inPieces = await runJqOverItems(program, ITEMS, 1);

    expect(whole).toMatchObject({ ok: false, code: "jq_budget_exceeded" });
    expect(inPieces).toEqual(whole);
  });

  it("stops a runaway inside one item", async () => {
    const run = await runJqOverItems(".[] | last(repeat(1))", ITEMS, TINY);

    expect(run).toMatchObject({ ok: false, code: "jq_budget_exceeded" });
  });

  it("says a single item was too large when one piece runs out of memory", async () => {
    const run = await runJqOverItems('.[] | "x" * 200000000 | length', [1, 2], 1);

    expect(run).toMatchObject({ ok: false, code: "jq_out_of_memory" });
    expect(run.ok ? "" : run.message).toContain("a single item");
    expect(run.ok ? "" : run.message).toContain("`fields`");
  });

  it("says which programs are run in pieces when a whole-array one runs out of memory", async () => {
    const run = await runJqOverItems('map("x" * 200000000) | length', [1, 2], 1);

    expect(run).toMatchObject({ ok: false, code: "jq_out_of_memory" });
    expect(run.ok ? "" : run.message).toContain("`.[] | ...`");
    expect(run.ok ? "" : run.message).toContain("narrow the call");
  });

  it("projects items far larger than one run can hold", async () => {
    // Forty rows of 4,000 points: about 9 MB of JSON, where one run holds about 6.
    const heavy = Array.from({ length: 40 }, (_unused, index) => ({
      id: `row-${String(index)}`,
      points: Array.from({ length: 4000 }, (_none, point) => ({
        t: 1_790_000_000_000 + point * 1000,
        lat: 10.5 + point * 0.0000125,
        lon: 20.25 + point * 0.0000175,
        alt: 30.48,
        hAcc: 4.5,
        vAcc: 6.25,
      })),
    }));
    const program = ".[] | [.id, (.points | length)]";

    const whole = await runJq(program, JSON.stringify(heavy));
    const inPieces = await runJqOverItems(program, heavy);

    expect(whole).toMatchObject({ ok: false, code: "jq_out_of_memory" });
    expect(inPieces).toEqual({
      ok: true,
      outputs: heavy.map((row) => [row.id, 4000]),
    });
  }, 60_000);
});
