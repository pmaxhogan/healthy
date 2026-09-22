import { codeText, dedupeStrings, pickDate } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedServiceRequest } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["occurrence"], raw: [["occurrenceDateTime"], ["occurrencePeriod", "start"]] },
  { normalized: ["reasons"], raw: [["reasonCode"]] },
];

export function normalizeServiceRequest(
  resource: fhir4.ServiceRequest,
  ctx: NormalizeCtx,
): NormalizedServiceRequest {
  const code = codeText(resource.code);
  const occurrence = pickDate(resource.occurrenceDateTime, resource.occurrencePeriod?.start);
  const requester = ctx.refs.display(resource.requester);
  const reasons = dedupeStrings((resource.reasonCode ?? []).map((reason) => codeText(reason)));

  return {
    resourceType: "ServiceRequest",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    status: resource.status,
    intent: resource.intent,
    ...(occurrence && { occurrence }),
    ...(requester && { requester }),
    reasons,
  };
}
