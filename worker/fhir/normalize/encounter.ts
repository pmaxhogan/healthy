// Epic quirks this file works around:
// - Visit type lives in `Encounter.type[0].text` (occasionally only on the
//   first coding's `.display`), never in a dedicated field.
// - The practitioner is `participant[].individual`, a `Reference` whose
//   `.display` Epic sometimes omits even when the Practitioner resource is
//   otherwise available -- hence resolving through `ctx.refs` rather than
//   trusting `.display` alone.
// - The clinic/room is `location[0].location`; `serviceProvider` is the
//   health-system Organization, not the clinic.
// - There is no dedicated "department" field anywhere on Encounter. Epic
//   commonly lists more specific-to-less-specific places in `location[]`
//   (room, then department, then facility), so the second entry -- or an
//   entry whose `physicalType` text says "department" -- is used as a
//   best-effort department name.

import { codeText, dedupeStrings, phone, address, period as periodOf } from "./helpers.ts";

import type { RefResolver } from "./refs.ts";
import type {
  NormalizeCtx,
  NormalizedEncounter,
  NormalizedLocationRef,
  NormalizedPractitionerRef,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

const CSN_TYPE_CODE = "CSN";
// v3 ParticipationType codes Epic uses to mark the primary/attending clinician.
const PRIMARY_PARTICIPANT_CODES = new Set(["PPRF", "ATND"]);
const TELEHEALTH_PATTERN = /video|virtual|tele/iu;

function codingText(coding?: fhir4.Coding): string | undefined {
  return coding?.display ?? coding?.code;
}

function isPrimaryParticipant(participant: fhir4.EncounterParticipant): boolean {
  return (
    participant.type?.some((type) =>
      type.coding?.some((coding) => coding.code && PRIMARY_PARTICIPANT_CODES.has(coding.code)),
    ) ?? false
  );
}

function practitionerSpecialty(
  individual: fhir4.Reference | undefined,
  refs: RefResolver,
): string | undefined {
  const practitioner = refs.get<fhir4.Practitioner>(individual);
  return codeText(practitioner?.qualification?.[0]?.code);
}

function toPractitionerRef(
  participant: fhir4.EncounterParticipant,
  refs: RefResolver,
): NormalizedPractitionerRef | undefined {
  const name = refs.display(participant.individual);
  const role = codeText(participant.type?.[0]);
  const specialty = practitionerSpecialty(participant.individual, refs);
  if (!name && !role && !specialty) {
    return undefined;
  }
  return {
    ...(name && { name }),
    ...(specialty && { specialty }),
    ...(role && { role }),
  };
}

/** Primary/attending participants first, everyone else after, in FHIR order. */
function practitioners(
  participants: fhir4.EncounterParticipant[] | undefined,
  refs: RefResolver,
): NormalizedPractitionerRef[] {
  // `worker/**` targets ES2022 (no DOM/ESNext libs), so `Array#toSorted` is not
  // available here; sorting the array `.filter()` already copied is the
  // ES2022-safe equivalent.
  const withIndividual = (participants ?? []).filter((participant) => participant.individual);
  // `withIndividual` is a fresh array from `.filter()` above, so sorting it in
  // place here (rather than `toSorted`, not in the worker's ES2022 lib target)
  // never mutates the caller's data.
  withIndividual.sort((a, b) => Number(isPrimaryParticipant(b)) - Number(isPrimaryParticipant(a)));
  const result: NormalizedPractitionerRef[] = [];
  for (const participant of withIndividual) {
    const ref = toPractitionerRef(participant, refs);
    if (ref) {
      result.push(ref);
    }
  }
  return result;
}

function resolvedLocation(
  encounterLocation: fhir4.EncounterLocation[] | undefined,
  refs: RefResolver,
): NormalizedLocationRef | undefined {
  const first = encounterLocation?.[0];
  if (!first) {
    return undefined;
  }
  const location = refs.get<fhir4.Location>(first.location);
  const name = location?.name ?? refs.display(first.location);
  const locationAddress = address(location?.address);
  const locationPhone = phone(location?.telecom);
  if (!name && !locationAddress && !locationPhone) {
    return undefined;
  }
  return {
    ...(name && { name }),
    ...(locationAddress && { address: locationAddress }),
    ...(locationPhone && { phone: locationPhone }),
  };
}

function departmentName(
  encounterLocation: fhir4.EncounterLocation[] | undefined,
  refs: RefResolver,
): string | undefined {
  const entries = encounterLocation ?? [];
  const explicitDept = entries.find((entry) =>
    /dept|department/iu.test(codeText(entry.physicalType) ?? ""),
  );
  const chosen = explicitDept ?? (entries.length >= 2 ? entries[1] : undefined);
  if (!chosen) {
    return undefined;
  }
  const location = refs.get<fhir4.Location>(chosen.location);
  return location?.name ?? refs.display(chosen.location);
}

function csn(identifiers: fhir4.Identifier[] | undefined): string | undefined {
  const match = identifiers?.find(
    (identifier) =>
      identifier.type?.text === CSN_TYPE_CODE ||
      identifier.type?.coding?.some((coding) => coding.code === CSN_TYPE_CODE),
  );
  return match?.value;
}

function isTelehealth(
  resource: fhir4.Encounter,
  visitType: string | undefined,
  location: NormalizedLocationRef | undefined,
): boolean {
  if (resource.class.code === "VR") {
    return true;
  }
  return visitType && TELEHEALTH_PATTERN.test(visitType)
    ? true
    : Boolean(location?.name && TELEHEALTH_PATTERN.test(location.name));
}

export function normalizeEncounter(
  resource: fhir4.Encounter,
  ctx: NormalizeCtx,
): NormalizedEncounter {
  const visitType = codeText(resource.type?.[0]);
  const time = periodOf(resource.period);
  const location = resolvedLocation(resource.location, ctx.refs);
  const dept = departmentName(resource.location, ctx.refs);
  const organization = ctx.refs.display(resource.serviceProvider);
  const reasons = dedupeStrings((resource.reasonCode ?? []).map((reason) => codeText(reason)));
  const encounterClass = codingText(resource.class);
  const csnValue = csn(resource.identifier);

  return {
    resourceType: "Encounter",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    status: resource.status,
    ...(encounterClass && { class: encounterClass }),
    ...(visitType && { visitType }),
    ...(time?.start && { start: time.start }),
    ...(time?.end && { end: time.end }),
    practitioners: practitioners(resource.participant, ctx.refs),
    ...(location && { location }),
    ...(organization && { organization }),
    ...(dept && { department: dept }),
    reasons,
    telehealth: isTelehealth(resource, visitType, location),
    identifiers: { ...(csnValue && { csn: csnValue }) },
  };
}
