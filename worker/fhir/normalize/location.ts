import { address, phone } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedLocation } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [{ normalized: ["phone"], raw: [["telecom"]] }];

export function normalizeLocation(resource: fhir4.Location, ctx: NormalizeCtx): NormalizedLocation {
  const locationAddress = address(resource.address);
  const locationPhone = phone(resource.telecom);

  return {
    resourceType: "Location",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(resource.name && { name: resource.name }),
    ...(locationAddress && { address: locationAddress }),
    ...(locationPhone && { phone: locationPhone }),
    ...(resource.status && { status: resource.status }),
  };
}
