import { codeText, pickDate } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedSpecimen } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  {
    normalized: ["collected"],
    raw: [
      ["collection", "collectedDateTime"],
      ["collection", "collectedPeriod", "start"],
    ],
    rendered: true,
  },
];

export function normalizeSpecimen(resource: fhir4.Specimen, ctx: NormalizeCtx): NormalizedSpecimen {
  const type = codeText(resource.type);
  const collected = pickDate(
    resource.collection?.collectedDateTime,
    resource.collection?.collectedPeriod?.start,
  );

  return {
    resourceType: "Specimen",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(type && { type }),
    ...(resource.status && { status: resource.status }),
    ...(collected && { collected }),
  };
}
