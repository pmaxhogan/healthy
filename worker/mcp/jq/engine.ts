/**
 * The jq engine behind every tool's optional `jq` argument.
 *
 * Real jq (1.8.x, via the jq-wasm Emscripten build), not a look-alike: a model
 * that has written jq for years gets exactly the semantics it expects. Workers
 * forbid `eval`, `new Function` and compiling wasm from bytes at run time; this
 * uses none of them -- the wasm is a module the bundler compiles at deploy time,
 * and the glue is plain JavaScript. See `scripts/build-jq-wasm.mjs` for how the
 * vendored wasm is derived and why the glue is vendored with it.
 *
 * Engine choice, measured (Node 26, synthetic lab items, see docs/mcp.md):
 *
 *  - jq-wasm (chosen): 1.04 MB wasm / 361 KB gzipped after metering; a fresh
 *    instance is ~0.5-1 ms; a call is ~1 ms at 4 KB of input, ~8 ms at 470 KB
 *    and ~40-60 ms at 2.3 MB. The fuel metering costs ~10-15%.
 *  - jaq (Rust) to wasm: no wasm32 target or wasm-pack on the build machine,
 *    and a close-but-not-exact jq dialect besides.
 *  - A pure-JS interpreter (jqjs and friends): nothing can interrupt a
 *    synchronous JavaScript loop inside a Worker, so a runaway filter would run
 *    until the CPU limit killed the whole request. That fails the cost-bound
 *    requirement outright.
 *
 * Cost bounds, all on the caller's PROGRAM, never on the data:
 *
 *  - Fuel. The vendored wasm decrements a counter at every function entry and
 *    every loop iteration and traps at zero. The budget is {@link fuelFor}:
 *    100 million units plus 100 per byte of input, at most 2^31 - 1 (a few
 *    seconds of CPU: ~4 s in Node, ~6-7 s in workerd). Parsing the input costs ~7-15 units per byte and a
 *    `group_by` over it ~16, so an honest filter uses a small fraction of it.
 *  - Memory. The wasm's linear memory stops at 64 MiB. jq's parsed form of a
 *    document is ~6x its JSON text, so that holds ~10 MB of input -- more than
 *    any single tool response this server produces for one record, and far
 *    more than a model's context. Past it the call fails `jq_out_of_memory`;
 *    it never truncates. Dropping `jq`, or narrowing with `from`/`to` or
 *    `health_systems`, returns the data unfiltered.
 *  - A fresh instance per call, thrown away afterwards: an aborted or
 *    out-of-fuel jq leaves its heap mid-operation, and a new instance from the
 *    already-compiled module costs under a millisecond.
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
 * The slice of the WebAssembly JS API used here, typed structurally.
 *
 * This file is also compiled by the plain-Node test project, whose libs declare
 * no `WebAssembly` namespace (it lives in the DOM lib and in workerd's generated
 * types), so the few members it needs are named here and read off the global.
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

const OUT_OF_MEMORY: JqRunResult = {
  ok: false,
  code: "jq_out_of_memory",
  message:
    "the filter needed more than the 64 MiB jq may use; narrow the input " +
    "(from/to, health_systems) or drop `jq` to get the unfiltered data",
};

const CRASHED: JqRunResult = { ok: false, code: "jq_error", message: "jq stopped unexpectedly" };

/** Why jq threw rather than returned, from the fuel left and the error. */
function classifyThrow(error: unknown, fuelLeft: number): JqRunResult {
  if (fuelLeft < 0) return BUDGET_EXCEEDED;
  // A bare `abort()` is how jq reacts to malloc failing (`memory_exhausted`),
  // which at the memory ceiling is the only way it fails. An assertion
  // failure reads "Aborted(Assertion failed: ...)" and is not this.
  return error instanceof Error && error.message.startsWith("Aborted()") ? OUT_OF_MEMORY : CRASHED;
}

/**
 * Run `program` over `inputJson` (already-serialised JSON) and collect every
 * output. Never throws for anything the program does; throws only if the engine
 * itself cannot be loaded.
 */
export async function runJq(program: string, inputJson: string): Promise<JqRunResult> {
  const { handle, fuel } = await instantiate(jqWasm);
  fuel.value = fuelFor(inputJson.length);
  try {
    // `--` ends option parsing: a program that begins with `-` is a program.
    const result = handle.raw(inputJson, program, ["-c", "--"]);
    return result.exitCode === 0
      ? { ok: true, outputs: parseOutputs(result.stdout) }
      : { ok: false, code: "jq_error", message: cleanMessage(result.stderr, result.exitCode) };
  } catch (error) {
    return classifyThrow(error, fuel.value);
  }
}
