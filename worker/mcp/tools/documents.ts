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

import { WINDOW_ARGS, toolArgs } from "../args.ts";
import { selectProviders, spec } from "../collect.ts";
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
  provider: z
    .string()
    .min(1)
    .describe("Provider id, or a case-insensitive substring of its display name."),
  id: z.string().min(1).describe("The DocumentReference id, as get_documents reported it."),
});

export function registerDocumentTools(server: McpServer, deps: ToolDeps): void {
  collectionTool(server, deps, {
    name: "get_documents",
    description:
      "Clinical document metadata: type, date, author, description and what " +
      "attachments exist. The text of one document is fetched with " +
      "get_document_text, which costs the organisation a metered request.",
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
      const matches = selectProviders(await deps.providers(), run.rules, [args.provider]);
      const [provider] = matches;
      if (provider === undefined) {
        return toolError("not_found", { detail: "no provider matches that name or id" });
      }
      if (matches.length > 1) {
        return toolError("not_found", {
          detail: "that name matches more than one provider; use the id from list_providers",
        });
      }

      const result = await deps.documentText({ providerId: provider.id, documentId: args.id });
      if (!result.ok) {
        return toolError(FAILURE_CODES[result.reason], { providerIds: [provider.id] });
      }

      return respond({
        tool: "get_document_text",
        rules: run.rules,
        items: [
          {
            resourceType: "DocumentReference",
            kind: "document_text",
            provider: provider.displayName,
            providerId: provider.id,
            id: result.documentId,
            contentType: result.contentType,
            cached: result.cached,
            chars: result.text.length,
            text: result.text,
          },
        ],
        limit: 1,
        providerIds: [provider.id],
        now: run.now,
      });
    },
  );
}
