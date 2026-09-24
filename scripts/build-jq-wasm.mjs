#!/usr/bin/env node
// Builds the jq engine the MCP `jq` argument runs on: worker/mcp/jq/vendor/.
//
// Usage:
//   node scripts/build-jq-wasm.mjs           # regenerate the vendored files
//   node scripts/build-jq-wasm.mjs --check   # fail if they are not what this script would write
//
// Input is the exactly-pinned `jq-wasm` devDependency: real jq (1.8.x) compiled
// with Emscripten, plus its JavaScript glue. Two things are done to the wasm
// before it is checked in, and they are the whole reason this script exists:
//
//  1. Fuel. Binaryen's `log-execution` pass puts a call at the top of every
//     function and every loop body. That call is then replaced by an internal
//     function that decrements a mutable i32 global, exported as `fuel`, and
//     executes `unreachable` once it goes negative. Every loop in jq -- its
//     bytecode interpreter, its builtins written in C, oniguruma's regex engine
//     -- therefore burns fuel, so a filter that never terminates (`[repeat(1)]`,
//     `def f: f; f`, `last(range(1e12))`) traps inside the one call that ran it
//     instead of spinning until the Worker's CPU limit kills the whole request.
//     The host sets `fuel` before each call (worker/mcp/jq/engine.ts). The global
//     starts at i32 max so the module's own start-up code can run.
//  2. A memory ceiling. The linear memory's maximum is lowered from the 256 MB
//     Emscripten was built with to MAX_PAGES. `memory.grow` past it fails,
//     malloc returns NULL, jq aborts, and the abort surfaces as an exception in
//     that call -- rather than the isolate (whose limit is 128 MB, shared with
//     everything else in it) being killed for exceeding its memory.
//
// The glue is vendored alongside, verbatim, because it and the wasm are one unit:
// Emscripten minifies the import names (`a.a` ... `a.E`), so a wasm from one
// jq-wasm release and glue from another do not link. The package's own `workerd`
// entry cannot be used either -- it statically imports the unmetered wasm, which
// would then ship next to this one as dead weight.
//
// test/unit/mcp/jq-vendor.test.ts fails when the pinned jq-wasm and the vendored
// copy disagree, so a dependency bump cannot silently leave them mismatched.
//
// knip.json lists `jq-wasm` under ignoreDependencies (only this script reads it,
// by path) and `vendor/jq.d.wasm.ts` under ignore (TypeScript reaches it through
// `allowArbitraryExtensions`, which knip does not follow).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import binaryen from "binaryen";

/** 1024 pages of 64 KiB: 64 MiB. The reasoning is in worker/mcp/jq/engine.ts. */
const MAX_PAGES = 1024;
const FUEL_GLOBAL = "fuel";
const HOOK = "log_execution";
const I32_MAX = 0x7f_ff_ff_ff;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "worker", "mcp", "jq", "vendor");
// Resolved through the package (its exports map publishes package.json) rather
// than a hard-coded node_modules path, so the dependency is visible to tooling.
const packageDir = path.dirname(createRequire(import.meta.url).resolve("jq-wasm/package.json"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function unsignedLeb(value) {
  const bytes = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return bytes;
}

function readLeb(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  let byte;
  do {
    byte = bytes[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: value >>> 0, next: offset };
}

/** Rewrite the (single) memory's maximum in section 5 of a wasm binary. */
function setMemoryMax(wasm, maxPages) {
  let offset = 8; // magic + version
  while (offset < wasm.length) {
    const sectionStart = offset;
    const id = wasm[offset];
    const size = readLeb(wasm, offset + 1);
    const body = size.next;
    const end = body + size.value;
    if (id === 5) {
      const count = readLeb(wasm, body);
      if (count.value !== 1) throw new Error("expected exactly one memory");
      const flags = wasm[count.next];
      if ((flags & 1) === 0) throw new Error("expected the memory to declare a maximum");
      const initial = readLeb(wasm, count.next + 1);
      const oldMax = readLeb(wasm, initial.next);
      if (maxPages < initial.value) throw new Error("ceiling is below the initial memory");
      const newBody = Buffer.from([
        ...unsignedLeb(1),
        flags,
        ...unsignedLeb(initial.value),
        ...unsignedLeb(maxPages),
        ...wasm.subarray(oldMax.next, end),
      ]);
      return Buffer.concat([
        wasm.subarray(0, sectionStart),
        Buffer.from([5, ...unsignedLeb(newBody.length)]),
        newBody,
        wasm.subarray(end),
      ]);
    }
    offset = end;
  }
  throw new Error("no memory section");
}

function meter(source) {
  const module = binaryen.readBinary(source);
  const F = binaryen.Features;
  // What Emscripten emitted, stated explicitly: binaryen's `All` would let it
  // write newer encodings (compact imports and the like) that workerd rejects.
  module.setFeatures(
    F.MVP |
      F.MutableGlobals |
      F.SignExt |
      F.BulkMemory |
      F.BulkMemoryOpt |
      F.NontrappingFPToInt |
      F.Multivalue |
      F.ReferenceTypes,
  );
  module.runPasses(["log-execution"]);
  module.removeFunction(HOOK);
  module.addGlobal(FUEL_GLOBAL, binaryen.i32, true, module.i32.const(I32_MAX));
  module.addGlobalExport(FUEL_GLOBAL, FUEL_GLOBAL);
  // fuel -= 1; if (fuel < 0) unreachable;
  const decremented = module.i32.sub(
    module.global.get(FUEL_GLOBAL, binaryen.i32),
    module.i32.const(1),
  );
  const exhausted = module.i32.lt_s(
    module.global.get(FUEL_GLOBAL, binaryen.i32),
    module.i32.const(0),
  );
  const body = module.block(null, [
    module.global.set(FUEL_GLOBAL, decremented),
    module.if(exhausted, module.unreachable()),
  ]);
  module.addFunction(HOOK, binaryen.createType([binaryen.i32]), binaryen.none, [], body);
  // Inline the counter into every call site: a call per loop iteration costs
  // several times what the decrement does.
  binaryen.setOptimizeLevel(2);
  binaryen.setShrinkLevel(1);
  binaryen.setAlwaysInlineMaxSize(40);
  module.runPasses(["inlining", "vacuum"]);
  if (!module.validate()) throw new Error("binaryen produced an invalid module");
  const out = Buffer.from(module.emitBinary());
  module.dispose();
  return setMemoryMax(out, MAX_PAGES);
}

async function glueChunk() {
  // The workerd entry is a thin shim over one shared chunk; the chunk is the glue.
  const edge = await readFile(path.join(packageDir, "dist", "edge.mjs"), "utf8");
  const match = /from "\.\/(chunk-[\w-]+\.mjs)"/u.exec(edge);
  if (match === null) throw new Error("could not find the glue chunk in jq-wasm's edge entry");
  return readFile(path.join(packageDir, "dist", match[1]), "utf8");
}

async function build() {
  const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const source = await readFile(path.join(packageDir, "dist", "build", "jq.wasm"));
  const wasm = meter(source);
  // Sanity: it compiles, and it still has the shape the glue expects.
  const compiled = new WebAssembly.Module(wasm);
  const exports = new Set(WebAssembly.Module.exports(compiled).map((entry) => entry.name));
  if (!exports.has(FUEL_GLOBAL)) throw new Error("the fuel global is not exported");
  if (WebAssembly.Module.imports(compiled).some((entry) => entry.name === HOOK)) {
    throw new Error("the log_execution import survived");
  }

  const glue =
    `// Vendored verbatim from jq-wasm@${pkg.version} (MIT, (c) Owen Ou) by\n` +
    `// scripts/build-jq-wasm.mjs. Do not edit: regenerate it. See LICENSE.md here.\n` +
    (await glueChunk());
  const manifest = {
    jqWasmVersion: pkg.version,
    binaryenVersion: JSON.parse(
      await readFile(path.join(root, "node_modules", "binaryen", "package.json"), "utf8"),
    ).version,
    maxPages: MAX_PAGES,
    sourceWasmSha256: sha256(source),
    wasmSha256: sha256(wasm),
    glueSha256: sha256(glue),
  };
  return { wasm, glue, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

const built = await build();
const files = [
  ["jq.wasm", built.wasm],
  ["jq-glue.mjs", built.glue],
  ["manifest.json", built.manifest],
];

if (process.argv.includes("--check")) {
  let stale = false;
  for (const [name, content] of files) {
    const target = path.join(outDir, name);
    const current = existsSync(target) ? await readFile(target) : Buffer.alloc(0);
    if (sha256(current) === sha256(content)) continue;
    console.error(`stale: worker/mcp/jq/vendor/${name}`);
    stale = true;
  }
  if (stale) process.exit(1);
  console.log("worker/mcp/jq/vendor is up to date");
} else {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of files) await writeFile(path.join(outDir, name), content);
  console.log(`wrote worker/mcp/jq/vendor (${String(built.wasm.length)} byte wasm)`);
}
