import { address, phone } from "./helpers.ts";

import type { NormalizeCtx, NormalizedLocation } from "./types.ts";
import type * as fhir4 from "fhir/r4";

export function normalizeLocation(resource: fhir4.Location, ctx: NormalizeCtx): NormalizedLocation {
  const locationAddress = address(resource.address);
  const locationPhone = phone(resource.telecom);

  return {
    resourceType: "Location",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(resource.name && { name: resource.name }),
    ...(locationAddress && { address: locationAddress }),
    ...(locationPhone && { phone: locationPhone }),
    ...(resource.status && { status: resource.status }),
  };
}
