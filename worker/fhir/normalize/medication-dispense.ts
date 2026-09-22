import { codeText, dedupeStrings, quantity } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedMedicationDispense } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["medication"], raw: [["medicationCodeableConcept"], ["medicationReference"]] },
  { normalized: ["dosageText"], raw: [["dosageInstruction", "[]", "text"]] },
];

export function normalizeMedicationDispense(
  resource: fhir4.MedicationDispense,
  ctx: NormalizeCtx,
): NormalizedMedicationDispense {
  const medication =
    codeText(resource.medicationCodeableConcept) ?? ctx.refs.display(resource.medicationReference);
  const dosageText = dedupeStrings((resource.dosageInstruction ?? []).map((d) => d.text));
  const dispenseQuantity = quantity(resource.quantity);
  const daysSupply = quantity(resource.daysSupply);

  return {
    resourceType: "MedicationDispense",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(medication && { medication }),
    status: resource.status,
    ...(dispenseQuantity && { quantity: dispenseQuantity }),
    ...(daysSupply && { daysSupply }),
    ...(resource.whenHandedOver && { whenHandedOver: resource.whenHandedOver }),
    dosageText,
  };
}
