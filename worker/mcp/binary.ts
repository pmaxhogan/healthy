/**
 * Fetching a clinical document body.
 *
 * The only request-time path in the MCP that talks to a health system, and the
 * only module that imports the sync engine. Both facts are deliberate: the
 * dependency is isolated here so no tool can reach an organisation by accident,
 * and so a change to the sync engine's contract fails to compile in exactly one
 * place.
 *
 * Why documents are special. Epic meters `DocumentReference` content: an
 * organisation answers error 4135 once the day's quota is spent, and that quota is
 * shared with everything else this app does. So metadata is refreshed on the daily
 * schedule like every other resource type, the body is fetched only when a caller
 * asks for that specific document, and the decoded text is cached for thirty days
 * under the synthetic resource type `_binary_text`. A second read of the same note
 * costs nothing, and the cap is reported as its own code so a caller knows to try
 * tomorrow rather than to retry now.
 *
 * The text conversion itself is in `document-text.ts`, which is pure.
 */

import { isAppError } from "../lib/errors.ts";
import { getFhirClientFor } from "../sync/index.ts";

import { BINARY_TEXT_TTL_MS, BINARY_TEXT_TYPE } from "./deps.ts";
import {
  attachmentForBinary,
  binaryIdFromUrl,
  convertDocument,
  decodeBase64Utf8,
  isDocumentReference,
  parseDocumentTextId,
  pickAttachment,
} from "./document-text.ts";

import type { DocumentTextResult } from "./deps.ts";
import type { DocumentAttachment } from "./document-text.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { FhirClient } from "../ehr/epic/fhir-client.ts";
import type { Logger } from "../lib/log.ts";
import type * as fhir4 from "fhir/r4";

/** Epic's "daily document query cap reached" code. */
const DOCUMENT_CAP_CODE = "4135";

/**
 * The sync engine's contract, named as a type.
 *
 * The assignment below is the whole coupling between the MCP and the sync engine.
 * If that contract changes, this one line is the compile error -- not a diagnostic
 * buried inside a tool.
 */
type FhirClientResolver = (ctx: Ctx, healthSystemId: string) => Promise<{ client: FhirClient }>;

const resolveFhirClient: FhirClientResolver = getFhirClientFor;

export interface BinaryTextDeps {
  repos: Repos;
  log: Logger;
}

/** One cached `DocumentReference`, matched by its real (unblinded) id. */
interface FoundDocument {
  documentId: string;
  document: fhir4.DocumentReference;
}

/**
 * The cached `DocumentReference`(s) of one health system whose attachment points
 * at `binaryId`.
 *
 * A single indexed read -- `fhir_cache_type` covers `(resource_type,
 * health_system_id)`, so this is one lookup, not a table walk -- followed by an
 * in-memory match on each attachment's `url`. When more than one document names
 * the same Binary (unusual, but not forbidden by FHIR), the first match wins;
 * nothing here can tell them apart any better than that.
 */
async function findByBinaryId(
  deps: BinaryTextDeps,
  healthSystemId: string,
  binaryId: string,
): Promise<FoundDocument | null> {
  const rows = await deps.repos.fhirCache.listByType(healthSystemId, "DocumentReference");
  for (const row of rows) {
    if (!isDocumentReference(row.resource)) continue;
    const namesIt = row.resource.content.some(
      (content) => binaryIdFromUrl(content.attachment.url) === binaryId,
    );
    if (namesIt) return { documentId: row.resourceId, document: row.resource };
  }
  return null;
}

/** Points at `get_documents`, for a `not_found` a caller can act on. */
const NOT_FOUND_HINT = "use the `id` get_documents reported, or one of its attachments[].url";

type ResolvedDocument =
  | { ok: true; documentId: string; attachment: DocumentAttachment | null }
  | { ok: false; reason: "not_found"; detail: string };

/**
 * Turn a `get_document_text` id argument into a cached `DocumentReference` and
 * the specific attachment it names.
 *
 *  - A Binary reference (`Binary/<id>`, or a URL ending in one) is looked up by
 *    scanning that health system's cached DocumentReferences for one whose
 *    attachment names it, and `attachmentForBinary` picks that exact attachment
 *    -- never a different one `pickAttachment` might otherwise prefer.
 *  - A `DocumentReference/<id>`-prefixed id is looked up as that DocumentReference,
 *    with no fallback: an explicit prefix says what the caller meant.
 *  - A bare id is tried as a DocumentReference id first, so every existing caller
 *    (which only ever passed one) is unaffected, and only falls back to the
 *    Binary search when that lookup misses.
 */
async function resolveDocument(
  deps: BinaryTextDeps,
  healthSystemId: string,
  rawId: string,
): Promise<ResolvedDocument> {
  const parsed = parseDocumentTextId(rawId);

  if (parsed.kind === "binary") {
    const found = await findByBinaryId(deps, healthSystemId, parsed.id);
    if (found === null) {
      return {
        ok: false,
        reason: "not_found",
        detail: `looked like a Binary reference (Binary/${parsed.id}); no cached document's attachment points at it (${NOT_FOUND_HINT})`,
      };
    }
    return {
      ok: true,
      documentId: found.documentId,
      attachment: attachmentForBinary(found.document, parsed.id),
    };
  }

  const cached = await deps.repos.fhirCache.get(healthSystemId, "DocumentReference", parsed.id);
  if (cached !== null && isDocumentReference(cached.resource)) {
    return { ok: true, documentId: parsed.id, attachment: pickAttachment(cached.resource) };
  }

  if (parsed.kind === "documentReference") {
    return {
      ok: false,
      reason: "not_found",
      detail: `looked like a DocumentReference id; no DocumentReference with that id is cached (${NOT_FOUND_HINT})`,
    };
  }

  // Bare, and not a cached DocumentReference id: the caller may have meant a
  // bare Binary id instead.
  const found = await findByBinaryId(deps, healthSystemId, parsed.id);
  if (found === null) {
    return {
      ok: false,
      reason: "not_found",
      detail: `matched neither a cached DocumentReference id nor a cached document's Binary attachment (${NOT_FOUND_HINT})`,
    };
  }
  return {
    ok: true,
    documentId: found.documentId,
    attachment: attachmentForBinary(found.document, parsed.id),
  };
}

/** True when an error from the FHIR client is Epic's daily document cap. */
function isDocumentCap(error: unknown): boolean {
  if (!isAppError(error)) return false;
  const codes = error.details?.epicCodes;
  return Array.isArray(codes) && codes.includes(DOCUMENT_CAP_CODE);
}

/** The cached plain text for one attachment, if it is still live. */
async function cachedText(
  deps: BinaryTextDeps,
  healthSystemId: string,
  key: string,
): Promise<string | null> {
  const row = await deps.repos.fhirCache.get(healthSystemId, BINARY_TEXT_TYPE, key);
  if (row === null) return null;
  const { text } = row.resource as { text?: unknown };
  return typeof text === "string" ? text : null;
}

/** Read the Binary behind an attachment, mapping every failure to a reason. */
async function fetchBinary(
  deps: BinaryTextDeps,
  healthSystemId: string,
  binaryId: string,
): Promise<{ ok: true; binary: fhir4.Binary } | { ok: false; reason: "cap_reached" | "upstream" }> {
  try {
    const { client } = await resolveFhirClient(deps.repos.ctx, healthSystemId);
    const binary = await client.read<fhir4.Binary>("Binary", binaryId);
    return binary === null ? { ok: false, reason: "upstream" } : { ok: true, binary };
  } catch (error) {
    if (isDocumentCap(error)) {
      deps.log.warn("mcp.document_cap_reached", { healthSystemId });
      return { ok: false, reason: "cap_reached" };
    }
    deps.log.warn("mcp.document_fetch_failed", {
      healthSystemId,
      errorCode: isAppError(error) ? error.code : "unknown",
    });
    return { ok: false, reason: "upstream" };
  }
}

/**
 * Fetch (or recall) the text of one document.
 *
 * `rawId` is what `get_document_text`'s `id` argument was called with -- a
 * DocumentReference id (optionally `DocumentReference/`-prefixed) or a Binary
 * reference (`Binary/<id>`, a bare Binary id, or a URL ending in one); see
 * `parseDocumentTextId`. Whichever form resolves the same document answers with
 * the same `documentId` and hits the same thirty-day cache entry, because both
 * paths end up naming the same attachment's Binary id.
 *
 * Never throws: every failure is one of the four `DocumentTextResult` reasons, so
 * the tool layer maps a stable code and the audit row records it without anyone
 * having to interpret an upstream message.
 */
export async function documentText(
  deps: BinaryTextDeps,
  healthSystemId: string,
  rawId: string,
): Promise<DocumentTextResult> {
  const resolved = await resolveDocument(deps, healthSystemId, rawId);
  if (!resolved.ok) return resolved;
  const { documentId, attachment } = resolved;
  if (attachment === null) return { ok: false, reason: "unsupported" };

  // Keyed by Binary id where there is one, and by document id for an inline
  // attachment: two DocumentReferences can point at the same Binary, and keying
  // on the Binary is what makes the second one free.
  const cacheKey = attachment.binaryId ?? `doc:${documentId}`;
  const fromCache = await cachedText(deps, healthSystemId, cacheKey);
  if (fromCache !== null) {
    return {
      ok: true,
      documentId,
      contentType: attachment.contentType,
      text: fromCache,
      cached: true,
    };
  }

  let encoded = attachment.data;
  let contentType = attachment.contentType;
  if (encoded === undefined) {
    const { binaryId } = attachment;
    if (binaryId === undefined) return { ok: false, reason: "unsupported" };
    const fetched = await fetchBinary(deps, healthSystemId, binaryId);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    if (typeof fetched.binary.data !== "string") return { ok: false, reason: "unsupported" };
    encoded = fetched.binary.data;
    // `Binary.contentType` is required in R4, so it is the authority over whatever
    // the DocumentReference's attachment claimed.
    contentType = fetched.binary.contentType;
  }

  let text: string | null;
  try {
    text = convertDocument(contentType, decodeBase64Utf8(encoded));
  } catch {
    // Malformed base64 is the organisation's problem and no retry fixes it, so it
    // is reported as unsupported rather than as an upstream failure.
    return { ok: false, reason: "unsupported" };
  }
  if (text === null) return { ok: false, reason: "unsupported" };

  await deps.repos.fhirCache.upsertMany(
    healthSystemId,
    [{ resourceType: BINARY_TEXT_TYPE, id: cacheKey, text, contentType, documentId }],
    BINARY_TEXT_TTL_MS,
  );

  return { ok: true, documentId, contentType, text, cached: false };
}
