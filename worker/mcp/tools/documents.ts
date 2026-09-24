/**
 * `get_documents` and `get_document_text`.
 *
 * Split in two because the second one costs something. Document metadata is
 * refreshed on the daily schedule like everything else, but the body of a
 * clinical note lives in a `Binary` that Epic meters: an organisation returns
 * error 4135 once the day's document quota is spent. So the note is fetched on
 * demand, once, and the decoded text is cached for thirty days -- and the cap is
 * reported as `document_cap_reached` rather than as a generic upstream failure, so
 * a caller knows to try tomorrow rather than to retry now.
 *
 * `get_document_text` is the only tool on this server that can reach a health
 * system during a request. Everything else reads the cache.
 */

import { z } from "zod";

import { JQ_ARGS, WINDOW_ARGS, toolArgs } from "../args.ts";
import { selectHealthSystems, spec } from "../collect.ts";
import { respond, toolError } from "../respond.ts";

import { collectionTool, readTool } from "./register.ts";

import type { DocumentTextFailure, ToolDeps } from "../deps.ts";
import type { ToolErrorCode } from "../respond.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Why the fetch failed, as a stable tool error code. */
const FAILURE_CODES: Record<DocumentTextFailure, ToolErrorCode> = {
  cap_reached: "document_cap_reached",
  not_found: "not_found",
  unsupported: "unsupported_document",
  upstream: "upstream_error",
};

const DOCUMENT_TEXT_ARGS = z.strictObject({
  healthSystem: z
    .string()
    .min(1)
    .describe("Health system id, or a case-insensitive substring of its display name."),
  id: z.string().min(1).describe("The DocumentReference id, as get_documents reported it."),
  ...JQ_ARGS,
});

export function registerDocumentTools(server: McpServer, deps: ToolDeps): void {
  collectionTool(server, deps, {
    name: "get_documents",
    description:
      "Clinical document metadata: type, date, author, description and what " +
      "attachments exist. The text of one document is fetched with " +
      "get_document_text, which costs the organisation a metered request. To keep " +
      'only what you need, pass `jq`, e.g. `.[] | select(.date >= "2026-01-01") | {id, type, date}`.',
    schema: toolArgs(WINDOW_ARGS),
    specs: () => [spec("DocumentReference", { dateOf: (item) => item.date })],
  });

  readTool(
    server,
    deps,
    {
      name: "get_document_text",
      description:
        "The plain text of one clinical document, decoded from its attachment. " +
        "Cached for thirty days after the first read. Organisations cap how many " +
        "documents may be fetched per day; when that cap is spent this answers " +
        "document_cap_reached.",
      schema: DOCUMENT_TEXT_ARGS,
    },
    async (args, run) => {
      const matches = selectHealthSystems(await deps.healthSystems(), run.rules, [
        args.healthSystem,
      ]);
      const [healthSystem] = matches;
      if (healthSystem === undefined) {
        return toolError("not_found", { detail: "no health system matches that name or id" });
      }
      if (matches.length > 1) {
        return toolError("not_found", {
          detail:
            "that name matches more than one health system; use the id from list_health_systems",
        });
      }

      const result = await deps.documentText({
        healthSystemId: healthSystem.id,
        documentId: args.id,
      });
      if (!result.ok) {
        return toolError(FAILURE_CODES[result.reason], { healthSystemIds: [healthSystem.id] });
      }

      return respond({
        tool: "get_document_text",
        rules: run.rules,
        items: [
          {
            resourceType: "DocumentReference",
            kind: "document_text",
            healthSystem: healthSystem.displayName,
            healthSystemId: healthSystem.id,
            id: result.documentId,
            contentType: result.contentType,
            cached: result.cached,
            chars: result.text.length,
            text: result.text,
          },
        ],
        jq: args.jq,
        healthSystemIds: [healthSystem.id],
        now: run.now,
      });
    },
  );
}
