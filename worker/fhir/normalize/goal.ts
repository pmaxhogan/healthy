import { codeText, dedupeStrings } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedGoal } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["targets"], raw: [["target"]] },
];

function targetText(target: fhir4.GoalTarget): string | undefined {
  return codeText(target.measure) ?? target.detailString;
}

export function normalizeGoal(resource: fhir4.Goal, ctx: NormalizeCtx): NormalizedGoal {
  const description = codeText(resource.description);
  const achievementStatus = codeText(resource.achievementStatus);
  const targets = dedupeStrings((resource.target ?? []).map((target) => targetText(target)));

  return {
    resourceType: "Goal",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(description && { description }),
    lifecycleStatus: resource.lifecycleStatus,
    ...(achievementStatus && { achievementStatus }),
    ...(resource.startDate && { startDate: resource.startDate }),
    targets,
  };
}
