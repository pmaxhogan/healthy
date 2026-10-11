// Synchronous reference resolution for the normalize layer. The normalizers
// are pure functions with no I/O, so every Practitioner/Location/Organization
// a resource points at must already be in hand -- the caller resolves the
// FHIR cache (or a bundle's `entry[]`) ahead of time and hands normalization
// a resolver backed by a plain in-memory map.
import { humanName } from "./helpers.ts";

import type * as fhir4 from "fhir/r4";

/** Resolves FHIR references without ever touching the network or a cache. */
export interface RefResolver {
  /** A human-readable label for the referenced resource, if one can be found. */
  display(ref?: fhir4.Reference): string | undefined;
  /** The referenced resource itself, if it was included in the resolver's pool. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- part of the locked spec's RefResolver shape: callers pick T explicitly (e.g. `refs.get<fhir4.Practitioner>(ref)`) since it can't be inferred from a plain Reference.
  get<T extends fhir4.Resource>(ref?: fhir4.Reference): T | undefined;
}

/**
 * `reference` may be a relative local ref ("Practitioner/123"), an absolute
 * URL (an Epic FHIR base plus the same path), or carry a version history
 * segment. All three should key to the same "ResourceType/id" pair.
 */
function referenceKey(ref: fhir4.Reference | undefined): string | undefined {
  const reference = ref?.reference;
  if (!reference) {
    return undefined;
  }
  const withoutHistory = reference.split("/_history/", 1)[0] ?? reference;
  const segments = withoutHistory.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const id = segments.at(-1);
  const resourceType = segments.at(-2);
  return !id || !resourceType ? undefined : `${resourceType}/${id}`;
}

/** A best-effort human label for a resolved resource, by resource type. */
function nameFromResource(resource: fhir4.Resource): string | undefined {
  switch (resource.resourceType) {
    case "Practitioner":
    case "Patient": {
      return humanName((resource as fhir4.Practitioner | fhir4.Patient).name);
    }
    case "Organization": {
      return (resource as fhir4.Organization).name;
    }
    case "Location": {
      return (resource as fhir4.Location).name;
    }
    default: {
      return undefined;
    }
  }
}

/** Builds a {@link RefResolver} keyed by `ResourceType/id` over a fixed pool. */
export function mapResolver(resources: readonly fhir4.Resource[]): RefResolver {
  const byKey = new Map<string, fhir4.Resource>();
  for (const resource of resources) {
    if (resource.id) {
      byKey.set(`${resource.resourceType}/${resource.id}`, resource);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- implements RefResolver.get<T>, see the interface comment above.
  function get<T extends fhir4.Resource>(ref?: fhir4.Reference): T | undefined {
    const key = referenceKey(ref);
    return key ? (byKey.get(key) as T | undefined) : undefined;
  }

  function display(ref?: fhir4.Reference): string | undefined {
    const resolved = get(ref);
    const fromResource = resolved ? nameFromResource(resolved) : undefined;
    return fromResource ?? ref?.display;
  }

  return { display, get };
}
