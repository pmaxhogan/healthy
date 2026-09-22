// Patient carries the most sensitive data in the record: telecom (phone/email)
// is dropped entirely rather than normalized, and only city/state of the
// address survive -- never street lines or postal code. `birthDate` is kept
// (it drives age-relevant clinical context) but flagged in `sensitive` so the
// MCP policy layer can still strip it per a deny rule.

import { humanName } from "./helpers.ts";

import type { NormalizeCtx, NormalizedPatient } from "./types.ts";
import type * as fhir4 from "fhir/r4";

export function normalizePatient(resource: fhir4.Patient, ctx: NormalizeCtx): NormalizedPatient {
  const name = humanName(resource.name);
  const first = resource.address?.[0];
  const address =
    first?.city || first?.state
      ? { ...(first.city && { city: first.city }), ...(first.state && { state: first.state }) }
      : undefined;

  return {
    resourceType: "Patient",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(name && { name }),
    ...(resource.birthDate && { birthDate: resource.birthDate }),
    ...(resource.gender && { gender: resource.gender }),
    ...(address && { address }),
    sensitive: ["birthDate"],
  };
}
