/**
 * How a tool gets onto the server.
 *
 * Two functions, and every tool uses one of them:
 *
 *  - `readTool` registers a hand-written body. It is the one that stamps the
 *    read-only annotations, so no tool can be registered without them.
 *  - `collectionTool` registers the common shape: pick health systems, read the cache,
 *    normalize, window, filter, respond. Nineteen of the tools are nothing but a
 *    description and a `CollectSpec`, and writing each of them out longhand would
 *    be nineteen chances to forget the policy call.
 *
 * The annotations are not decoration. `readOnlyHint` is what lets a client run a
 * tool without a confirmation prompt, and this server has no tool that writes
 * anything, so they are a constant rather than a per-tool choice.
 */

import { withAudit } from "../audit.ts";
import { collect, effectiveLimit, selectHealthSystems } from "../collect.ts";
import { respond } from "../respond.ts";

import type { SharedArgs, WindowArgs } from "../args.ts";
import type { ToolBody } from "../audit.ts";
import type { CollectSpec } from "../collect.ts";
import type { ToolDeps } from "../deps.ts";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/**
 * Every tool on this server, always.
 *
 * `openWorldHint: false` is the honest answer: with the single exception of
 * `get_document_text`, a tool reads the local cache and cannot reach outside it.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface ReadToolOptions<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
}

/** Register one tool with a hand-written body. */
export function readTool<S extends z.ZodType>(
  server: McpServer,
  deps: ToolDeps,
  options: ReadToolOptions<S>,
  body: ToolBody<z.output<S>>,
): void {
  server.registerTool(
    options.name,
    {
      description: options.description,
      inputSchema: options.schema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    // `ToolCallback` is a conditional type over the schema, and TypeScript cannot
    // resolve it while the schema is still a type parameter, so a concrete callback
    // is never assignable to it from inside a generic function. The assertion is
    // safe in the direction that matters: `body` is typed `ToolBody<z.output<S>>`
    // at every call site, which is exactly the argument type the SDK will parse
    // `inputSchema` into before calling it.
    withAudit(deps, options.name, body) as ToolCallback<S>,
  );
}

export interface CollectionToolOptions<
  S extends z.ZodType<SharedArgs & WindowArgs>,
> extends ReadToolOptions<S> {
  /** Which resource types to read, and how, given the caller's arguments. */
  specs: (args: z.output<S>) => CollectSpec[];
  /**
   * Extra notes to put in the answer's `warnings`, e.g. "this window defaults to
   * upcoming only". Stable strings, never anything from the record.
   */
  notes?: (args: z.output<S>) => string[];
}

/**
 * Register a tool that is "read these resource types and hand them back".
 *
 * The body is identical for all of them, which is the point: the policy call
 * lives in `respond`, `respond` is called here, and a new tool cannot be added in
 * a way that skips it without visibly not using this function.
 */
export function collectionTool<S extends z.ZodType<SharedArgs & WindowArgs>>(
  server: McpServer,
  deps: ToolDeps,
  options: CollectionToolOptions<S>,
): void {
  readTool(server, deps, options, async (args, run) => {
    // Assignable by the constraint on S; named so the window and the shared
    // arguments can be read without the concrete schema type in hand.
    const shared: SharedArgs = args;
    const window: WindowArgs = args;

    const healthSystems = selectHealthSystems(
      await deps.healthSystems(),
      run.rules,
      shared.healthSystems,
    );
    const collected = await collect(deps, healthSystems, {
      specs: options.specs(args),
      from: window.from,
      to: window.to,
      raw: shared.raw,
    });

    return respond({
      tool: options.name,
      rules: run.rules,
      items: collected.items,
      ...(shared.raw === true && { rawItems: collected.rawItems }),
      sources: collected.sources,
      limit: effectiveLimit(shared.limit),
      jq: shared.jq,
      healthSystemIds: collected.healthSystemIds,
      warnings: options.notes?.(args),
      coverage: collected.coverage,
      now: run.now,
    });
  });
}
