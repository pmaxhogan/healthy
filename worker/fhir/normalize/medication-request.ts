import { codeText, dedupeStrings } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedMedicationRequest } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["medication"], raw: [["medicationCodeableConcept"], ["medicationReference"]] },
  { normalized: ["dosageText"], raw: [["dosageInstruction", "[]", "text"]] },
  { normalized: ["reasons"], raw: [["reasonCode"]] },
];

export function normalizeMedicationRequest(
  resource: fhir4.MedicationRequest,
  ctx: NormalizeCtx,
): NormalizedMedicationRequest {
  const medication =
    codeText(resource.medicationCodeableConcept) ?? ctx.refs.display(resource.medicationReference);
  const dosageText = dedupeStrings((resource.dosageInstruction ?? []).map((d) => d.text));
  const requester = ctx.refs.display(resource.requester);
  const reasons = dedupeStrings((resource.reasonCode ?? []).map((reason) => codeText(reason)));

  return {
    resourceType: "MedicationRequest",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(medication && { medication }),
    status: resource.status,
    intent: resource.intent,
    ...(resource.authoredOn && { authoredOn: resource.authoredOn }),
    dosageText,
    ...(requester && { requester }),
    reasons,
  };
}
