import { codeText, dedupeStrings, humanName } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedPractitioner } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["qualifications"], raw: [["qualification", "[]", "code"]] },
];

export function normalizePractitioner(
  resource: fhir4.Practitioner,
  ctx: NormalizeCtx,
): NormalizedPractitioner {
  const name = humanName(resource.name);
  const qualifications = dedupeStrings(
    (resource.qualification ?? []).map((qualification) => codeText(qualification.code)),
  );

  return {
    resourceType: "Practitioner",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(name && { name }),
    ...(resource.gender && { gender: resource.gender }),
    qualifications,
  };
}
