// Epic content URLs are relative Binary references ("Binary/<id>"), meant to
// be resolved lazily on MCP demand (worker/mcp/tools/get_document_text) rather
// than fetched here -- normalization only carries the pointer through.

import { codeText, dedupeStrings } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedDocumentAttachment,
  NormalizedDocumentReference,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["attachments"], raw: [["content"]] },
  {
    normalized: ["attachments", "[]", "contentType"],
    raw: [["content", "[]", "attachment", "contentType"]],
  },
  { normalized: ["attachments", "[]", "url"], raw: [["content", "[]", "attachment", "url"]] },
  { normalized: ["attachments", "[]", "title"], raw: [["content", "[]", "attachment", "title"]] },
];

function toAttachment(
  content: fhir4.DocumentReferenceContent,
): NormalizedDocumentAttachment | undefined {
  const { attachment } = content;
  if (!attachment.contentType && !attachment.url && !attachment.title) {
    return undefined;
  }
  return {
    ...(attachment.contentType && { contentType: attachment.contentType }),
    ...(attachment.url && { url: attachment.url }),
    ...(attachment.title && { title: attachment.title }),
  };
}

export function normalizeDocumentReference(
  resource: fhir4.DocumentReference,
  ctx: NormalizeCtx,
): NormalizedDocumentReference {
  const type = codeText(resource.type);
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const author = dedupeStrings((resource.author ?? []).map((ref) => ctx.refs.display(ref)));
  const attachments: NormalizedDocumentAttachment[] = [];
  for (const content of resource.content) {
    const attachment = toAttachment(content);
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return {
    resourceType: "DocumentReference",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(type && { type }),
    category,
    ...(resource.date && { date: resource.date }),
    status: resource.status,
    ...(resource.description && { description: resource.description }),
    author,
    attachments,
  };
}
