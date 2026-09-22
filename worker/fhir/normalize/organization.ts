import { address, codeText, phone } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedOrganization } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [{ normalized: ["phone"], raw: [["telecom"]] }];

export function normalizeOrganization(
  resource: fhir4.Organization,
  ctx: NormalizeCtx,
): NormalizedOrganization {
  const type = codeText(resource.type?.[0]);
  const orgAddress = address(resource.address);
  const orgPhone = phone(resource.telecom);

  return {
    resourceType: "Organization",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(resource.name && { name: resource.name }),
    ...(type && { type }),
    ...(orgAddress && { address: orgAddress }),
    ...(orgPhone && { phone: orgPhone }),
  };
}
