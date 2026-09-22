import { codeText, dedupeStrings } from "./helpers.ts";

import type { NormalizeCtx, NormalizedCoverage } from "./types.ts";
import type * as fhir4 from "fhir/r4";

export function normalizeCoverage(resource: fhir4.Coverage, ctx: NormalizeCtx): NormalizedCoverage {
  const payor = dedupeStrings(resource.payor.map((ref) => ctx.refs.display(ref)));
  const type = codeText(resource.type);

  return {
    resourceType: "Coverage",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    payor,
    ...(type && { type }),
    ...(resource.subscriberId && { subscriberId: resource.subscriberId }),
    status: resource.status,
    sensitive: ["subscriberId"],
  };
}
