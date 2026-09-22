// Pure ESM module: slims Epic's "User-access Brands Bundle" (a FHIR R4 Bundle of
// Organization + Endpoint resources) down to a compact, dedupe brand list.
//
// Real-world shape observed from https://open.epic.com/Endpoints/Brands (Sept 2026):
//   - Bundle.entry contains ~97k Organization resources and ~820 Endpoint resources.
//   - "Primary brand" Organizations carry a non-empty `endpoint` array (a real FHIR R4
//     field: Organization.endpoint) referencing an Endpoint resource.
//   - "Location" Organizations have no `endpoint` field; instead they have `partOf`
//     pointing back at a primary brand Organization, plus a real street `address`
//     (city/state) we use for `locations`.
//   - Endpoint.address is the FHIR R4 base URL. Endpoint.managingOrganization.display
//     is often just the *hosting* system (e.g. many small clinics all show "OCHIN"
//     there) rather than the specific brand, so we do NOT use it for `name`; the
//     linked Organization.name is the actual brand name.
//   - Multiple distinct primary-brand Organizations frequently share one Endpoint (an
//     affiliate/shared-instance network), and occasionally two different Endpoint
//     resources carry the identical address string. Both cases are handled by
//     deduping on the normalized `fhirBaseUrl` after building candidate records.
//   - No Organization.alias / Organization.telecom / portal-URL extension exists in
//     the real feed today, so `portalUrl` and `aliases` mostly come out empty/absent
//     for real data; both are still supported for bundles that do carry them (and are
//     exercised by the unit tests with synthetic data).

/**
 * @typedef {Object} SlimBrand
 * @property {string} id
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string} [portalUrl]
 * @property {string} fhirBaseUrl
 * @property {string[]} [locations]
 */

/**
 * Build a lookup of every possible reference key for a bundle entry:
 * its fullUrl (e.g. "urn:uuid:...") and, if the resource has an id,
 * "<ResourceType>/<id>" (the other common FHIR reference form).
 * @param {{fullUrl?: string, resource: any}} entry
 * @returns {string[]}
 */
function referenceKeysFor(entry) {
  const keys = [];
  if (entry.fullUrl) keys.push(entry.fullUrl);
  const resource = entry.resource;
  if (resource && resource.resourceType && resource.id) {
    keys.push(`${resource.resourceType}/${resource.id}`);
  }
  return keys;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * Determine whether an Endpoint resource represents a FHIR R4 endpoint, per the
 * two signals Epic's data actually uses: the address path, and (as a fallback)
 * the endpoint-fhir-version extension.
 * @param {any} endpoint
 * @returns {boolean}
 */
function isR4Endpoint(endpoint) {
  const address = typeof endpoint.address === "string" ? endpoint.address : "";
  if (/\/api\/fhir\/r4(\/|$)/i.test(address)) return true;

  const versionExt = (endpoint.extension || []).find(
    (ext) => ext && typeof ext.url === "string" && /fhir-version/i.test(ext.url),
  );
  return Boolean(
    versionExt &&
    typeof versionExt.valueCode === "string" &&
    versionExt.valueCode.trimStart().startsWith("4"),
  );
}

function normalizeBaseUrl(address) {
  return String(address || "").replace(/\/+$/, "");
}

function formatLocation(address) {
  if (!address) return null;
  const city = typeof address.city === "string" ? address.city.trim() : "";
  const state = typeof address.state === "string" ? address.state.trim() : "";
  if (!city && !state) return null;
  return city && state ? `${city}, ${state}` : city || state;
}

/**
 * Slim an Epic "User-access Brands Bundle" (FHIR R4 Bundle) down to a compact,
 * deduped, sorted array of brand records.
 * @param {any} bundle
 * @returns {SlimBrand[]}
 */
export function slimBrandsBundle(bundle) {
  const entries = Array.isArray(bundle && bundle.entry) ? bundle.entry : [];

  /** @type {Map<string, any>} */
  const byReferenceKey = new Map();
  /** @type {{entry: any, resource: any}[]} */
  const organizationEntries = [];
  /** @type {{entry: any, resource: any}[]} */
  const endpointEntries = [];

  for (const entry of entries) {
    const resource = entry && entry.resource;
    if (!resource) continue;
    for (const key of referenceKeysFor(entry)) {
      byReferenceKey.set(key, resource);
    }
    if (resource.resourceType === "Organization") organizationEntries.push({ entry, resource });
    else if (resource.resourceType === "Endpoint") endpointEntries.push({ entry, resource });
  }

  function resolve(reference) {
    return reference ? byReferenceKey.get(reference) : undefined;
  }

  // Primary-brand organizations are those that reference at least one Endpoint.
  const primaryBrandOrgs = organizationEntries.filter(
    ({ resource }) => Array.isArray(resource.endpoint) && resource.endpoint.length > 0,
  );

  // Build a set of reference keys for each primary-brand org so location
  // organizations (which point back via `partOf`) can be matched to it.
  const orgKeysByOrgId = new Map(); // org.id -> array of keys identifying this org
  for (const { entry, resource } of primaryBrandOrgs) {
    orgKeysByOrgId.set(resource, referenceKeysFor(entry));
  }

  // Index location organizations by the org they belong to (partOf), so we can
  // pull city/state locations for each brand.
  /** @type {Map<any, string[]>} */
  const locationsByOrg = new Map();
  const primaryOrgByKey = new Map();
  for (const { resource } of primaryBrandOrgs) {
    for (const key of orgKeysByOrgId.get(resource)) {
      primaryOrgByKey.set(key, resource);
    }
  }
  for (const { resource } of organizationEntries) {
    const partOfRef = resource.partOf && resource.partOf.reference;
    if (!partOfRef) continue;
    const parentOrg = primaryOrgByKey.get(partOfRef);
    if (!parentOrg) continue;
    const address = Array.isArray(resource.address) ? resource.address[0] : undefined;
    const location = formatLocation(address);
    if (!location) continue;
    const list = locationsByOrg.get(parentOrg) || [];
    if (!list.includes(location)) list.push(location);
    locationsByOrg.set(parentOrg, list);
  }

  /** @type {SlimBrand[]} */
  const candidates = [];

  for (const { resource: org } of primaryBrandOrgs) {
    const endpointRef = org.endpoint[0] && org.endpoint[0].reference;
    const endpoint = resolve(endpointRef);
    if (
      !endpoint ||
      endpoint.resourceType !== "Endpoint" ||
      endpoint.status !== "active" ||
      !isR4Endpoint(endpoint)
    )
      continue;

    const name = org.name || endpoint.name;
    if (!name) continue;

    const fhirBaseUrl = normalizeBaseUrl(endpoint.address);
    if (!fhirBaseUrl) continue;

    const id = org.id || slugify(name) || slugify(fhirBaseUrl);

    const locations = (locationsByOrg.get(org) || []).slice(0, 5);

    const portalUrl = extractPortalUrl(org);

    /** @type {SlimBrand} */
    const candidate = { id, name, fhirBaseUrl };
    if (portalUrl) candidate.portalUrl = portalUrl;
    if (locations.length > 0) candidate.locations = locations;

    candidates.push(candidate);
  }

  // Dedupe by fhirBaseUrl, merging names into aliases and unioning locations.
  /** @type {Map<string, SlimBrand>} */
  const byBaseUrl = new Map();
  for (const candidate of candidates) {
    const existing = byBaseUrl.get(candidate.fhirBaseUrl);
    if (!existing) {
      byBaseUrl.set(candidate.fhirBaseUrl, candidate);
      continue;
    }

    if (candidate.name !== existing.name) {
      const aliases = existing.aliases ? [...existing.aliases] : [];
      if (!aliases.includes(candidate.name)) aliases.push(candidate.name);
      for (const alias of candidate.aliases || []) {
        if (alias !== existing.name && !aliases.includes(alias)) aliases.push(alias);
      }
      if (aliases.length > 0) existing.aliases = aliases;
    }

    if (!existing.portalUrl && candidate.portalUrl) existing.portalUrl = candidate.portalUrl;

    if (candidate.locations && candidate.locations.length > 0) {
      const locations = existing.locations ? [...existing.locations] : [];
      for (const loc of candidate.locations) {
        if (locations.length >= 5) break;
        if (!locations.includes(loc)) locations.push(loc);
      }
      if (locations.length > 0) existing.locations = locations;
    }
  }

  const result = [...byBaseUrl.values()];
  result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return result;
}

/**
 * Best-effort extraction of a public-facing portal URL from an Organization,
 * inspecting both `extension` and `telecom` since Epic's schema for this is not
 * formally documented. Real Epic data does not currently populate either, but
 * this keeps the module forward-compatible and is exercised by unit tests.
 * @param {any} org
 * @returns {string | undefined}
 */
function extractPortalUrl(org) {
  for (const telecom of org.telecom || []) {
    if (telecom && telecom.system === "url" && typeof telecom.value === "string" && telecom.value) {
      return telecom.value;
    }
  }
  for (const ext of org.extension || []) {
    if (
      ext &&
      typeof ext.url === "string" &&
      /portal/i.test(ext.url) &&
      typeof ext.valueUrl === "string"
    ) {
      return ext.valueUrl;
    }
  }
  return;
}

/**
 * Case-insensitive substring search over name/aliases/locations, returning up
 * to the top 20 matches. Name matches rank above alias matches, which rank
 * above location matches; ties keep alphabetical order.
 * @param {SlimBrand[]} list
 * @param {string} query
 * @returns {SlimBrand[]}
 */
export function searchBrands(list, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return [];

  /** @type {{brand: SlimBrand, rank: number}[]} */
  const matches = [];
  for (const brand of list) {
    const name = (brand.name || "").toLowerCase();
    if (name.startsWith(q)) {
      matches.push({ brand, rank: 0 });
      continue;
    }
    if (name.includes(q)) {
      matches.push({ brand, rank: 1 });
      continue;
    }
    if ((brand.aliases || []).some((a) => a.toLowerCase().includes(q))) {
      matches.push({ brand, rank: 2 });
      continue;
    }
    if ((brand.locations || []).some((l) => l.toLowerCase().includes(q))) {
      matches.push({ brand, rank: 3 });
    }
  }

  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.brand.name.localeCompare(b.brand.name, undefined, { sensitivity: "base" }),
  );
  return matches.slice(0, 20).map((m) => m.brand);
}
