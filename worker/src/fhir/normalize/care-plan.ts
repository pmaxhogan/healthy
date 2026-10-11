import { codeText, dedupeStrings, period } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedCarePlan } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["activities"], raw: [["activity"]] },
];

function activityText(activity: fhir4.CarePlanActivity): string | undefined {
  return codeText(activity.detail?.code);
}

export function normalizeCarePlan(resource: fhir4.CarePlan, ctx: NormalizeCtx): NormalizedCarePlan {
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const activities = dedupeStrings((resource.activity ?? []).map((a) => activityText(a)));
  const planPeriod = period(resource.period);

  return {
    resourceType: "CarePlan",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(resource.title && { title: resource.title }),
    status: resource.status,
    intent: resource.intent,
    category,
    ...(planPeriod && { period: planPeriod }),
    activities,
  };
}
