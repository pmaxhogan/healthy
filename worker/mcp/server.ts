/**
 * The MCP server, hosted in a SQLite-backed Durable Object.
 *
 * `McpAgent` owns the Streamable HTTP transport, the session lifecycle and CORS;
 * this class owns only what is specific to this record: the server name a client
 * displays, and the tool registrations.
 *
 * The class NAME is load-bearing. `wrangler.jsonc` migration tag v1 declares
 * `new_sqlite_classes: ["HealthyMcp"]`, and renaming a Durable Object class after
 * it has been deployed means a new migration and an orphaned namespace -- so the
 * wave-1 stub was already called this, and it stays called this.
 *
 * The env type is an intersection, and it has to be. `McpAgent`'s first type
 * parameter is constrained to the generated `Cloudflare.Env`, which the
 * hand-written `worker/env.ts` Env does not satisfy (it widens `DEV_MODE` to
 * `string` and leaves `HEALTHY_MCP` unparameterised). Neither is assignable to the
 * other -- `DurableObjectNamespace<T>` is invariant in `T` -- so the intersection
 * is what satisfies the constraint while still giving `makeToolDeps` the secrets
 * half of the interface, which wrangler cannot generate because it is not in
 * wrangler.jsonc.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// agents 0.24.0 marks McpAgent feature-frozen in favour of `createMcpHandler`, a
// stateless SDK-v2 factory. It is used anyway, deliberately: the locked spec is a
// SQLite-backed Durable Object session (migration tag v1, `new_sqlite_classes:
// ["HealthyMcp"]`), and the stateless handler has no Durable Object at all -- so
// migrating is not a drop-in change but a new deployment shape, and it would have
// to be done before the first deploy or not at all. Revisit when the spec does;
// until then the deprecation notice is noise on every lint run.
// eslint-disable-next-line sonarjs/deprecation -- see above: McpAgent is the locked architecture for this Worker.
import { McpAgent } from "agents/mcp";

import { makeToolDeps } from "./deps-d1.ts";
import { registerTools } from "./tools/index.ts";

import type { Env } from "../env.ts";

/** What a client shows the user. Not a product name to be themed later. */
const MCP_SERVER_NAME = "Healthy";

/**
 * Advertised to clients on initialize.
 *
 * A hand-maintained constant rather than the package version: `package.json` is
 * bumped for SPA and tooling changes that say nothing about the tool surface, and
 * a client caching by version wants to hear about the tool surface.
 */
const MCP_SERVER_VERSION = "1.0.0";

/**
 * Props carried on the grant and in every access token.
 *
 * A type alias, not an interface: `McpAgent`'s `Props` parameter is constrained to
 * `Record<string, unknown>`, which an interface does not satisfy (it gets no
 * implicit index signature).
 *
 * `grantedAt` is what the consent page records. `clientId` and `grantId` are
 * stamped in by the token-exchange callback in `worker/mcp/oauth-config.ts`, where
 * the grant id first exists -- they are here so every audit row can say which
 * client and which grant a call came from.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be a type alias: `McpAgent`'s Props parameter is constrained to `Record<string, unknown>`, and an interface gets no implicit index signature, so an interface here does not satisfy the constraint.
export type HealthyProps = {
  grantedAt: string;
  clientId?: string;
  grantId?: string;
};

/** The generated bindings plus the hand-written secrets. See the note above. */
type McpEnv = Cloudflare.Env & Env;

// eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation -- see the import: McpAgent is the locked architecture for this Worker.
export class HealthyMcp extends McpAgent<McpEnv, unknown, HealthyProps> {
  override server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  override async init(): Promise<void> {
    registerTools(
      this.server,
      makeToolDeps({
        env: this.env,
        caller: {
          clientId: this.props?.clientId ?? null,
          grantId: this.props?.grantId ?? null,
        },
      }),
    );
    // `init` is async by contract; there is nothing to await, and returning a
    // rejected promise here would fail the session rather than one tool call.
    await Promise.resolve();
  }
}
