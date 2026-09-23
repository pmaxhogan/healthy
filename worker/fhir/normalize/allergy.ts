import { codeText, dedupeStrings, period, pickDate } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedAllergy,
  NormalizedAllergyReaction,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["reactions"], raw: [["reaction"]] },
  {
    normalized: ["onset"],
    raw: [["onsetDateTime"], ["onsetPeriod", "start"], ["onsetString"]],
  },
];

function normalizedReaction(reaction: fhir4.AllergyIntoleranceReaction): NormalizedAllergyReaction {
  return {
    manifestation: dedupeStrings(reaction.manifestation.map((cc) => codeText(cc))),
    ...(reaction.severity && { severity: reaction.severity }),
  };
}

export function normalizeAllergy(
  resource: fhir4.AllergyIntolerance,
  ctx: NormalizeCtx,
): NormalizedAllergy {
  const substance = codeText(resource.code);
  const clinicalStatus = codeText(resource.clinicalStatus);
  const onset = pickDate(
    resource.onsetDateTime,
    period(resource.onsetPeriod)?.start,
    resource.onsetString,
  );

  return {
    resourceType: "AllergyIntolerance",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(substance && { substance }),
    reactions: (resource.reaction ?? []).map((reaction) => normalizedReaction(reaction)),
    ...(resource.criticality && { criticality: resource.criticality }),
    ...(clinicalStatus && { clinicalStatus }),
    ...(onset && { onset }),
  };
}
