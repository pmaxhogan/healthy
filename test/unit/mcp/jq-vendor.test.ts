// The vendored jq engine (worker/mcp/jq/vendor/) against the pinned jq-wasm
// devDependency it was built from.
//
// The metered wasm and the glue are one unit -- Emscripten minifies the wasm's
// import names, so a wasm and glue from different jq-wasm releases do not link --
// and both are derived from whatever jq-wasm is installed. A dependency bump that
// is not followed by `node scripts/build-jq-wasm.mjs` fails here, rather than as
// a jq that silently stays on the old version, or one that cannot load.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fromRoot = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const vendor = (name: string) => fromRoot(`worker/mcp/jq/vendor/${name}`);
const pkg = (name: string) => fromRoot(`node_modules/jq-wasm/${name}`);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

interface Manifest {
  jqWasmVersion: string;
  maxPages: number;
  sourceWasmSha256: string;
  wasmSha256: string;
  glueSha256: string;
}

/**
 * The bit of the WebAssembly JS API this test reads, typed structurally: the
 * plain-Node project's libs declare no `WebAssembly` namespace.
 */
interface ModuleDescriptor {
  name: string;
  kind: string;
}
interface WasmReflection {
  Module: {
    new (bytes: Uint8Array): object;
    exports(module: object): ModuleDescriptor[];
    imports(module: object): ModuleDescriptor[];
  };
}
const wasm = Reflect.get(globalThis, "WebAssembly") as WasmReflection;

const manifest = readJson(vendor("manifest.json")) as Manifest;

describe("the vendored jq engine", () => {
  it("was built from the jq-wasm version that is pinned and installed", () => {
    const installed = readJson(pkg("package.json")) as { version: string };
    const declared = readJson(fromRoot("package.json")) as {
      devDependencies: Record<string, string>;
    };

    expect(installed.version).toBe(manifest.jqWasmVersion);
    // Exact, not a range: see the note in scripts/build-jq-wasm.mjs.
    expect(declared.devDependencies["jq-wasm"]).toBe(manifest.jqWasmVersion);
    expect(sha256(pkg("dist/build/jq.wasm"))).toBe(manifest.sourceWasmSha256);
  });

  it("is exactly what the build script wrote", () => {
    expect(sha256(vendor("jq.wasm"))).toBe(manifest.wasmSha256);
    expect(sha256(vendor("jq-glue.mjs"))).toBe(manifest.glueSha256);
  });

  it("exports the fuel counter and no longer imports the execution hook", () => {
    const module = new wasm.Module(readFileSync(vendor("jq.wasm")));
    const exports = wasm.Module.exports(module).map((entry) => `${entry.name}:${entry.kind}`);
    const imports = wasm.Module.imports(module).map((entry) => entry.name);

    expect(exports).toContain("fuel:global");
    expect(imports).not.toContain("log_execution");
    expect(manifest.maxPages).toBe(1024);
  });
});
