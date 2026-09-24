/**
 * The admin console's own door onto the tool surface.
 *
 * `GET /api/mcp/tools/schema` and `POST /api/mcp/tools/:name/call`
 * (`worker/api/routes/mcp.ts`) both go through here rather than reimplementing
 * any part of a tool. Both connect a real {@link McpServer} carrying the real
 * `registerTools` registrations to the SDK's own in-memory transport and drive it
 * with the SDK's own `Client` -- exactly the pattern
 * `test/unit/mcp/helpers.ts` and `test/integration/mcp/tools.test.ts` already use
 * to exercise tools without a Durable Object. A call made here is therefore
 * validated by the real zod input schema, filtered by the real exposure policy,
 * and audited by the real `withAudit` wrapper: there is no second code path for
 * any of those three to drift out of sync with.
 *
 * `listMcpTools`'s JSON schema comes from the same place: `client.listTools()`
 * asks the SDK to convert each tool's zod schema to JSON Schema, which is the
 * conversion `worker/api/tool-catalog.ts`'s hand-maintained table cannot offer
 * (see the note at its top). The two tool listings answer different questions --
 * that one is a curated FHIR-resource-type index for policy targets, this one is
 * "what does a call to this tool actually need" -- so this does not replace it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MCP_INSTRUCTIONS } from "./instructions.ts";
import { registerTools } from "./tools/index.ts";

import type { ToolDeps } from "./deps.ts";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Recorded as `clientId` on every audit row a call through this module writes.
 * Never an OAuth client id: nothing here goes through a grant, so the row must
 * say plainly that this was the owner, driving the console, not a linked client.
 */
export const ADMIN_CALLER_CLIENT_ID = "admin-console";

/** `deps.caller` for a call made from the admin console. No grant is involved. */
export function adminCaller(): ToolDeps["caller"] {
  return { clientId: ADMIN_CALLER_CLIENT_ID, grantId: null };
}

/**
 * Stand up one real server, wire it to one real client over an in-memory
 * transport, run `fn`, and tear both down -- whether `fn` throws or not.
 *
 * A fresh pair per call rather than a pooled one: `deps` is built fresh per admin
 * request too (see `worker/mcp/deps-d1.ts`'s per-call cache), and a Durable
 * Object session's whole reason to persist a server -- staying open across many
 * calls from one client -- does not apply to a single admin request.
 */
async function withClient<T>(deps: ToolDeps, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer(
    { name: "Healthy", version: "admin-console" },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "admin-console", version: "admin-console" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
}

/** Every tool this server has registered right now, with its real JSON input schema. */
export async function listMcpTools(deps: ToolDeps): Promise<McpToolSchema[]> {
  return withClient(deps, async (client) => {
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }));
  });
}

/**
 * Call one tool exactly as an MCP client would: same schema validation, same
 * policy, same audit row.
 *
 * `null` means `name` matches nothing this server has registered -- checked
 * against the live list rather than inferred from the SDK's own "tool not found"
 * text, so the route has an authoritative answer instead of a string to parse.
 */
export async function callMcpTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult | null> {
  return withClient(deps, async (client) => {
    const { tools } = await client.listTools();
    return tools.every((tool) => tool.name !== name)
      ? null
      : ((await client.callTool({ name, arguments: args })) as CallToolResult);
  });
}
