import { codeText, pickDate } from "./helpers.ts";

import type { NormalizeCtx, NormalizedImmunization } from "./types.ts";
import type * as fhir4 from "fhir/r4";

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
    provider: ctx.provider,
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
