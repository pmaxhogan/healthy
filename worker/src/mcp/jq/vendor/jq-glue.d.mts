// Hand-written types for the vendored jq-wasm glue (jq-glue.mjs), covering only
// what worker/mcp/jq/engine.ts uses. The shapes follow jq-wasm's own index.d.ts,
// with the WebAssembly types replaced by structural ones: the plain-Node test
// project compiles these too, and its libs declare no `WebAssembly` namespace.

/** A compiled, not-yet-instantiated `WebAssembly.Module`. */
export type CompiledWasm = object;

export interface JqResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface JqHandle {
  raw(input: string, query: string, flags?: string[]): JqResult;
}

export interface JqLoadOptions {
  instantiateWasm?: (
    imports: object,
    onSuccess: (instance: object, module: CompiledWasm) => void,
  ) => void | Promise<void>;
}

type Builder = (reject: (reason: unknown) => void) => JqLoadOptions;

export interface Platform {
  defaultBuilder: Builder;
  fromURL: (url: string | URL) => Builder;
}

export function makeLoadJq(platform: Platform): (options?: JqLoadOptions) => Promise<JqHandle>;
