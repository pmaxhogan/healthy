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
import { convertDocument, decodeBase64Utf8, isConvertible } from "./document-text.ts";

import type { DocumentTextResult } from "./deps.ts";
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

interface Attachment {
  contentType: string;
  /** Inline base64, when the organisation supplied it. */
  data?: string | undefined;
  /** The `Binary` id, when it did not. */
  binaryId?: string | undefined;
}

/** `Binary/<id>` out of a relative reference or an absolute URL. */
function binaryIdOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = /(?:^|\/)Binary\/([^/?#]+)/u.exec(url);
  return match?.[1];
}

/** The first attachment that could plausibly become text. */
function pickAttachment(document: fhir4.DocumentReference): Attachment | null {
  for (const content of document.content) {
    const { attachment } = content;
    const contentType = attachment.contentType ?? "";
    if (!isConvertible(contentType)) continue;
    const binaryId = binaryIdOf(attachment.url);
    if (binaryId === undefined && attachment.data === undefined) continue;
    return {
      contentType,
      ...(attachment.data !== undefined && { data: attachment.data }),
      ...(binaryId !== undefined && { binaryId }),
    };
  }
  return null;
}

function isDocumentReference(value: unknown): value is fhir4.DocumentReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { resourceType?: unknown }).resourceType === "DocumentReference" &&
    Array.isArray((value as { content?: unknown }).content)
  );
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
 * Never throws: every failure is one of the four `DocumentTextResult` reasons, so
 * the tool layer maps a stable code and the audit row records it without anyone
 * having to interpret an upstream message.
 */
export async function documentText(
  deps: BinaryTextDeps,
  healthSystemId: string,
  documentId: string,
): Promise<DocumentTextResult> {
  const cachedDocument = await deps.repos.fhirCache.get(
    healthSystemId,
    "DocumentReference",
    documentId,
  );
  if (cachedDocument === null || !isDocumentReference(cachedDocument.resource)) {
    return { ok: false, reason: "not_found" };
  }

  const attachment = pickAttachment(cachedDocument.resource);
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
