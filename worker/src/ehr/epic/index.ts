/**
 * The Epic health system adapter: the shared SMART machinery (`../smart.ts`) plus
 * what Epic does its own way.
 *
 * Epic-specific behaviour this encodes:
 *
 *  - `aud` is mandatory on the authorize request and must equal the registered
 *    FHIR base as a string; a mismatch fails silently. The shared code never
 *    normalises it, which is the property Epic depends on.
 *  - Scopes the app is not registered for are dropped silently, so the effective
 *    grant is the intersection of what was asked for and what was registered.
 *    `scopesFor` therefore asks for everything and the caller reads `scope` off
 *    the token response to learn what it really got.
 *  - Epic requires HTTP Basic for the refresh grant, which is why an unknown
 *    `token_endpoint_auth_methods_supported` is read as Basic.
 */

import { createSmartAdapter, patientReadScopes } from "../smart.ts";

import type { AdapterDeps, EhrAdapter } from "../adapter.ts";

export { indexCapabilities, parseSmartConfiguration, toTokenSet } from "../smart.ts";

export function createEpicAdapter(deps: AdapterDeps): EhrAdapter {
  return createSmartAdapter(
    {
      vendor: "epic",
      // Epic silently drops anything the app is not registered for, so asking
      // for a type the org lacks is harmless.
      scopesFor: (resourceTypes) => patientReadScopes(resourceTypes),
    },
    deps,
  );
}
