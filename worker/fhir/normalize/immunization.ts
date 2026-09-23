import { codeText, pickDate } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedImmunization } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["vaccine"], raw: [["vaccineCode"]] },
  { normalized: ["occurrence"], raw: [["occurrenceDateTime"], ["occurrenceString"]] },
  { normalized: ["lot"], raw: [["lotNumber"]] },
  {
    normalized: ["doseNumber"],
    raw: [
      ["protocolApplied", "[]", "doseNumberPositiveInt"],
      ["protocolApplied", "[]", "doseNumberString"],
    ],
  },
];

function doseNumber(protocolApplied?: fhir4.ImmunizationProtocolApplied[]): string | undefined {
  const first = protocolApplied?.[0];
  if (!first) {
    return undefined;
  }
  return first.doseNumberPositiveInt === undefined
    ? first.doseNumberString
    : String(first.doseNumberPositiveInt);
}

export function normalizeImmunization(
  resource: fhir4.Immunization,
  ctx: NormalizeCtx,
): NormalizedImmunization {
  const vaccine = codeText(resource.vaccineCode);
  const occurrence = pickDate(resource.occurrenceDateTime, resource.occurrenceString);
  const site = codeText(resource.site);
  const route = codeText(resource.route);
  const dose = doseNumber(resource.protocolApplied);

  return {
    resourceType: "Immunization",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(vaccine && { vaccine }),
    ...(occurrence && { occurrence }),
    status: resource.status,
    ...(resource.lotNumber && { lot: resource.lotNumber }),
    ...(site && { site }),
    ...(route && { route }),
    ...(dose && { doseNumber: dose }),
  };
}
