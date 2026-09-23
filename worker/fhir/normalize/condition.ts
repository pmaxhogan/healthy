import { codeText, dedupeStrings, period, pickDate } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedCodeableConcept,
  NormalizedCondition,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  {
    normalized: ["onset"],
    raw: [["onsetDateTime"], ["onsetPeriod", "start"], ["onsetString"]],
  },
  { normalized: ["recorded"], raw: [["recordedDate"]] },
  {
    normalized: ["abatement"],
    raw: [["abatementDateTime"], ["abatementPeriod", "start"], ["abatementString"]],
  },
];

function normalizedCode(cc?: fhir4.CodeableConcept): NormalizedCodeableConcept | undefined {
  const text = codeText(cc);
  const coding = cc?.coding?.[0];
  if (!text && !coding?.system && !coding?.code) {
    return undefined;
  }
  return {
    ...(text && { text }),
    ...(coding?.system && { system: coding.system }),
    ...(coding?.code && { code: coding.code }),
  };
}

export function normalizeCondition(
  resource: fhir4.Condition,
  ctx: NormalizeCtx,
): NormalizedCondition {
  const code = normalizedCode(resource.code);
  const clinicalStatus = codeText(resource.clinicalStatus);
  const verificationStatus = codeText(resource.verificationStatus);
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const onset = pickDate(
    resource.onsetDateTime,
    period(resource.onsetPeriod)?.start,
    resource.onsetString,
  );
  const abatement = pickDate(
    resource.abatementDateTime,
    period(resource.abatementPeriod)?.start,
    resource.abatementString,
  );

  return {
    resourceType: "Condition",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    category,
    ...(clinicalStatus && { clinicalStatus }),
    ...(verificationStatus && { verificationStatus }),
    ...(onset && { onset }),
    ...(resource.recordedDate && { recorded: resource.recordedDate }),
    ...(abatement && { abatement }),
  };
}
