/**
The jq engine behind every tool's optional `jq` argument.

Real jq (1.8.x, via the jq-wasm Emscripten build), not a look-alike: a model
that has written jq for years gets exactly the semantics it expects. Workers
forbid `eval`, `new Function` and compiling wasm from bytes at run time; this
uses none of them -- the wasm is a module the bundler compiles at deploy time,
and the glue is plain JavaScript. See `worker/scripts/build-jq-wasm.mjs` for how the
vendored wasm is derived and why the glue is vendored with it.

Engine choice, measured (Node 26, synthetic lab items, see docs/mcp.md):

 - jq-wasm (chosen): 1.04 MB wasm / 361 KB gzipped after metering; a fresh
   instance is ~0.5-1 ms; a call is ~1 ms at 4 KB of input, ~8 ms at 470 KB
   and ~40-60 ms at 2.3 MB. The fuel metering costs ~10-15%.
 - jaq (Rust) to wasm: no wasm32 target or wasm-pack on the build machine,
   and a close-but-not-exact jq dialect besides.
 - A pure-JS interpreter (jqjs and friends): nothing can interrupt a
   synchronous JavaScript loop inside a Worker, so a runaway filter would run
   until the CPU limit killed the whole request. That fails the cost-bound
   requirement outright.

Cost bounds, all on the caller's PROGRAM, never on the data:

 - Fuel. The vendored wasm decrements a counter at every function entry and
   every loop iteration and traps at zero. The budget is {@link fuelFor}:
   100 million units plus 100 per byte of input, at most 2^31 - 1 (a few
   seconds of CPU: ~4 s in Node, ~6-7 s in workerd). Parsing the input costs ~7-15 units per byte and a
   `group_by` over it ~16, so an honest filter uses a small fraction of it.
 - Memory. The wasm's linear memory stops at 64 MiB. jq's parsed form of a
   document is 6-10x its JSON text (ten for rows that are mostly numbers,
   such as a GPS route: 5.8 MB of them parse to 58 MiB), so that holds
   roughly 6 MB of input at once. Past it the call fails
   `jq_out_of_memory`; it never truncates.
 - A fresh instance per call, thrown away afterwards: an aborted or
   out-of-fuel jq leaves its heap mid-operation, and a new instance from the
   already-compiled module costs under a millisecond.

Items larger than that go through a piece at a time ({@link runJqOverItems}).
A tool's items can be far more than 6 MB -- a few hundred exercise sessions
with GPS routes are tens of megabytes -- while the program a caller writes
over them is nearly always the one every tool description teaches,
`.[] | f`: take each item, emit something small. Such a program never needs
the array, so it is handed the array in consecutive pieces of about
{@link PIECE_CHARS} of JSON and its outputs are concatenated. The program is
NOT rewritten: each piece is itself an array, and the caller's text runs on
it as written. What makes that the same answer is jq's grammar and nothing
else -- `|` binds loosest of all, so a program that starts `.[] |` is `.[]`
piped into everything after it, and `.[] | f` over an array is the
concatenation of `.[] | f` over any split of it, as long as `f` cannot see
or stop anything beyond its own item. {@link streamsPerItem} is that test,
and it errs towards "no": a program it is not sure of runs on the whole
array, where the ceiling above applies and the error says what to do.
*/

import { makeLoadJq } from "./vendor/jq-glue.mjs";
import jqWasm from "./vendor/jq.wasm";

import type { CompiledWasm, JqHandle } from "./vendor/jq-glue.mjs";

const FUEL_BASE = 100_000_000;
const FUEL_PER_INPUT_BYTE = 100;
const FUEL_MAX = 0x7f_ff_ff_ff;

/** How a jq run can fail, as a stable tool error code. */
export type JqFailureCode = "jq_error" | "jq_budget_exceeded" | "jq_out_of_memory";

export type JqRunResult =
  { ok: true; outputs: unknown[] } | { ok: false; code: JqFailureCode; message: string };

/** The fuel a run over `inputBytes` of JSON gets. */
export function fuelFor(inputBytes: number): number {
  return Math.min(FUEL_MAX, FUEL_BASE + FUEL_PER_INPUT_BYTE * inputBytes);
}

/** The glue's own loaders (fetch a URL, fall back to a default) are never used. */
function noLoader(): Record<string, never> {
  return {};
}

// Every load passes `instantiateWasm`, so these exist only to satisfy its shape.
const loadJq = makeLoadJq({ defaultBuilder: noLoader, fromURL: () => noLoader });

/**
The slice of the WebAssembly JS API used here, typed structurally.

This file is also compiled by the plain-Node test project, whose libs declare
no `WebAssembly` namespace (it lives in the DOM lib and in workerd's generated
types), so the few members it needs are named here and read off the global.
*/
interface WasmInstance {
  readonly exports: Readonly<Record<string, unknown>>;
}
interface WasmRuntime {
  instantiate(module: CompiledWasm, imports: object): Promise<WasmInstance>;
  Global: abstract new (...args: never[]) => { value: unknown };
}
const wasm = Reflect.get(globalThis, "WebAssembly") as WasmRuntime;

/** A mutable wasm global holding a number: the fuel counter. */
interface FuelGlobal {
  value: number;
}

interface Loaded {
  handle: JqHandle;
  fuel: FuelGlobal;
}

function isFuelGlobal(value: unknown): value is FuelGlobal {
  return value instanceof wasm.Global && typeof value.value === "number";
}

async function instantiate(module: CompiledWasm): Promise<Loaded> {
  let instance: WasmInstance | undefined;
  const handle = await loadJq({
    // Async on purpose: the glue rejects the load when this promise rejects,
    // where a synchronous hook's failure would leave it waiting forever.
    instantiateWasm: async (imports, onSuccess) => {
      instance = await wasm.instantiate(module, imports);
      onSuccess(instance, module);
    },
  });
  const fuel = instance?.exports.fuel;
  if (!isFuelGlobal(fuel)) throw new Error("the jq module is not the metered build");
  return { handle, fuel };
}

/** jq names its input `/dev/stdin:0`, which means nothing to a caller. */
function cleanMessage(stderr: string, exitCode: number): string {
  const text = stderr.replaceAll(/ \(at \/dev\/stdin:\d+\)/gu, "").trim();
  return text === "" ? `jq exited with status ${String(exitCode)}` : text;
}

function parseOutputs(stdout: string): unknown[] {
  // `-c` prints one value per line, and JSON escapes every newline inside a
  // string, so a line is always exactly one value.
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
}

const BUDGET_EXCEEDED: JqRunResult = {
  ok: false,
  code: "jq_budget_exceeded",
  message:
    "the filter ran out of its step budget; it probably never terminates " +
    "(e.g. `repeat`, `recurse` or `range` without a bound)",
};

/** The whole array did not fit: say which programs do not need it to. */
const OUT_OF_MEMORY: JqRunResult = {
  ok: false,
  code: "jq_out_of_memory",
  message:
    "the program needed more than the 64 MiB jq may use, which holds roughly 6 MB of " +
    "items at once. A program that starts with `.[] | ...` (and uses none of `input`, " +
    "`halt`, `debug`, `stderr`) is run over the items a piece at a time and has no such " +
    "limit, so project or filter that way and count or sort the small result yourself. " +
    "One that needs the whole array (`length`, `sort_by`, `group_by`, `map(...)`, " +
    "`[.[] | ...]`) has to fit: narrow the call (a shorter date range, fewer sources, " +
    "or fewer fields where the tool can leave some out), or drop `jq` to get the " +
    "unfiltered data",
};

/** One piece did not fit, so one item (or what the program built from it) is too large. */
const PIECE_OUT_OF_MEMORY: JqRunResult = {
  ok: false,
  code: "jq_out_of_memory",
  message:
    "the program needed more than the 64 MiB jq may use while it was run over the " +
    "items a piece at a time, so a single item is larger than jq can hold (roughly 6 MB) " +
    "or the program builds something that large from one. Leave the large field out " +
    "before jq sees it where the tool has an argument for that (`fields` on `hc_records`), " +
    "or drop `jq` to get the unfiltered data",
};

const CRASHED: JqRunResult = { ok: false, code: "jq_error", message: "jq stopped unexpectedly" };

/** Why jq threw rather than returned, from the fuel left and the error. */
function classifyThrow(error: unknown, fuelLeft: number, outOfMemory: JqRunResult): JqRunResult {
  if (fuelLeft < 0) return BUDGET_EXCEEDED;
  // A bare `abort()` is how jq reacts to malloc failing (`memory_exhausted`),
  // which at the memory ceiling is the only way it fails. An assertion
  // failure reads "Aborted(Assertion failed: ...)" and is not this.
  return error instanceof Error && error.message.startsWith("Aborted()") ? outOfMemory : CRASHED;
}

/** One run of `program` over `inputJson`, on an instance whose fuel is already set. */
function runOnce(
  loaded: Loaded,
  program: string,
  inputJson: string,
  outOfMemory: JqRunResult,
): JqRunResult {
  try {
    // `--` ends option parsing: a program that begins with `-` is a program.
    const result = loaded.handle.raw(inputJson, program, ["-c", "--"]);
    return result.exitCode === 0
      ? { ok: true, outputs: parseOutputs(result.stdout) }
      : { ok: false, code: "jq_error", message: cleanMessage(result.stderr, result.exitCode) };
  } catch (error) {
    return classifyThrow(error, loaded.fuel.value, outOfMemory);
  }
}

/**
Run `program` over `inputJson` (already-serialised JSON) and collect every
output. Never throws for anything the program does; throws only if the engine
itself cannot be loaded.
*/
export async function runJq(program: string, inputJson: string): Promise<JqRunResult> {
  const loaded = await instantiate(jqWasm);
  loaded.fuel.value = fuelFor(inputJson.length);
  return runOnce(loaded, program, inputJson, OUT_OF_MEMORY);
}

/**
JSON characters of items one piece carries, at most (a single larger item is
a piece of its own). 2 MiB parses to about 20 MiB, a third of the ceiling,
which leaves the program room to build things from an item; a piece costs
one more call on the same instance, well under a millisecond of overhead.
*/
export const PIECE_CHARS = 2 * 1024 * 1024;

/** `.[]` (or `.[]?`), then a pipe that is not the `|=` operator. */
const PER_ITEM_PREFIX = /^\s*\.\[\s*\]\??\s*\|(?!=)/u;

/**
Names that let the rest of a program see or stop something beyond its own
item: `input`/`inputs` (and `input_line_number`) read the input stream,
`halt`/`halt_error` end the whole run with what was emitted so far, and
`debug`/`stderr` write to the stream a later error's message is read from.
Matched as bare substrings, comments and string literals included: a false
match only sends a program the whole-array way, which is always correct.
*/
const NOT_PER_ITEM = /input|halt|debug|stderr/u;

/**
True when `program` gives the same answer run over the items a piece at a
time as over all of them at once: it starts `.[] |`, and nothing after that
can see or stop anything beyond the item it was handed.

`|` binds loosest in jq's grammar (looser than `,`, than an `as` binding,
than `def`, `reduce` or `label`), so everything after that first pipe is one
filter applied to each item in turn, and a jq filter keeps no state between
the inputs it is applied to. Everything else -- `length`, `sort_by(...)`,
`group_by(...)`, `map(...)`, `[.[] | ...]`, `first(.[] | ...)`,
`limit(3; .[])`, `.[] as $x | ...` (where `.` is still the array),
`def f: ...; .[] | f`, a program with a leading comment -- answers false.
*/
export function streamsPerItem(program: string): boolean {
  const prefix = PER_ITEM_PREFIX.exec(program);
  return prefix !== null && !NOT_PER_ITEM.test(program.slice(prefix[0].length));
}

/** `items` as consecutive JSON arrays of about `pieceChars` each; one empty array for none. */
function* pieces(items: readonly unknown[], pieceChars: number): Generator<string> {
  let parts: string[] = [];
  let size = 0;
  for (const item of items) {
    // `null` is what `JSON.stringify` writes for an array element with no JSON form.
    const text = (JSON.stringify(item) as string | undefined) ?? "null";
    if (parts.length > 0 && size + text.length > pieceChars) {
      yield `[${parts.join(",")}]`;
      parts = [];
      size = 0;
    }
    parts.push(text);
    size += text.length;
  }
  // Always at least one piece: an empty array still compiles the program, so a
  // syntax error is reported whether or not there was anything to run it on.
  yield `[${parts.join(",")}]`;
}

/**
Run `program` over `items` and collect every output: what every tool's `jq`
argument goes through.

A program that {@link streamsPerItem} is run over the items in pieces, in
order, on one instance, and the outputs are concatenated; any other program
is run once over the whole array. Items that fit in one piece are one run
over the whole array either way, so nothing about a small answer changes.

In pieces, what stays exactly as it is in one run:

 - Errors. jq stops at the first error and a failed run returns no outputs,
   so the first piece that fails is the answer: the same message, about the
   same item, and nothing after it is run.
 - Fuel. One budget for the call, not one per piece: the same 100 million
   units plus 100 per byte, counted over the JSON handed over so far, less
   what the pieces before this one burned. The 2^31 - 1 ceiling of the wasm's
   counter then bounds one piece and not the call: parsing alone is ~8 units
   a byte, so a single clamped budget would run out near 250 MB of items
   and call an honest projection a runaway. A program that loops for ever
   still stops inside the piece it loops in, on what is left of the budget.

`pieceChars` is for tests; callers leave it alone.
*/
export async function runJqOverItems(
  program: string,
  items: readonly unknown[],
  pieceChars: number = PIECE_CHARS,
): Promise<JqRunResult> {
  if (!streamsPerItem(program)) return runJq(program, JSON.stringify(items));
  const loaded = await instantiate(jqWasm);
  const outputs: unknown[] = [];
  let chars = 0;
  let burned = 0;
  for (const piece of pieces(items, pieceChars)) {
    chars += piece.length;
    const granted = Math.min(FUEL_MAX, FUEL_BASE + FUEL_PER_INPUT_BYTE * chars - burned);
    loaded.fuel.value = granted;
    const run = runOnce(loaded, program, piece, PIECE_OUT_OF_MEMORY);
    // A failed run is left on the instance's heap, and the instance is dropped with it.
    if (!run.ok) return run;
    burned += granted - loaded.fuel.value;
    for (const output of run.outputs) outputs.push(output);
  }
  return { ok: true, outputs };
}
