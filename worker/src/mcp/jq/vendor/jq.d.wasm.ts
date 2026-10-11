// Wrangler's bundler (and the unit project's wasm plugin, see vitest.config.ts)
// turns a `.wasm` import into a compiled, not-yet-instantiated WebAssembly.Module.
// Typed as `object` because the plain-Node test project has no WebAssembly lib.
declare const module: object;
export default module;
