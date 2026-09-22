import { codeText, pickDate } from "./helpers.ts";

import type { NormalizeCtx, NormalizedSpecimen } from "./types.ts";
import type * as fhir4 from "fhir/r4";

export function normalizeSpecimen(resource: fhir4.Specimen, ctx: NormalizeCtx): NormalizedSpecimen {
  const type = codeText(resource.type);
  const collected = pickDate(
    resource.collection?.collectedDateTime,
    resource.collection?.collectedPeriod?.start,
  );

  return {
    resourceType: "Specimen",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(type && { type }),
    ...(resource.status && { status: resource.status }),
    ...(collected && { collected }),
  };
}
