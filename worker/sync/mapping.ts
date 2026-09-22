/**
 * Appointment -> calendar event. The one pure module in the sync engine.
 *
 * No D1, no fetch, no Env, no clock: every input arrives as an argument, which is
 * what makes the title templates, the arrive-early arithmetic and the fingerprint
 * exhaustively unit-testable in plain Node.
 *
 * Three rules here are load-bearing and easy to break by accident.
 *
 * **The arrive-early offset moves the start, never the truth.** The event starts
 * `offset` minutes before the reported appointment time so the owner's calendar
 * says "leave now"; the real time is preserved in the title as `(appt 11:30 AM)`,
 * and only when an offset actually applies. The default duration is measured from
 * the *real* start, not the shifted one, so a 30-minute visit with a 20-minute
 * offset is a 50-minute event -- which is what the owner's afternoon actually
 * costs.
 *
 * **The footer time is outside the fingerprint.** The description ends with
 * "last checked <local time>", which changes on every run. If that were
 * fingerprinted, every hourly sync would patch every event forever. So the
 * fingerprint covers the body and the footer rides along: nothing is patched
 * until something real changes, and when something does the footer is refreshed
 * with it.
 *
 * **A ghost is derived, not rebuilt.** `ghostModel` takes the active model and
 * prefixes, greys and de-blocks it, and its fingerprint is a hash of the active
 * fingerprint plus the instant the appointment first vanished. That instant is
 * stable, so a ghost settles after one patch instead of churning.
 *
 * Nothing here logs. Every string it produces (organisation name, practitioner,
 * address) is user data that belongs on the calendar and nowhere else.
 */

import { AppError } from "../lib/errors.ts";
import { addMinutes, formatInZone } from "../lib/time.ts";

import { sha256Hex } from "./hash.ts";

import type { ProviderConfig } from "../db/schemas.ts";
import type { NormalizedAddress, NormalizedAppointmentView } from "../fhir/normalize/types.ts";
import type { CalendarEventModel } from "../google/types.ts";

/** Minutes an appointment is assumed to last when the Encounter has no end. */
export const DEFAULT_DURATION_MIN = 30;

/**
 * Encounter statuses that mean the appointment is no longer on the schedule.
 *
 * `entered-in-error` sits alongside `cancelled` on purpose: the owner saw the
 * appointment, so it is ghosted rather than silently dropped.
 */
const OFF_SCHEDULE_STATUSES: ReadonlySet<string> = new Set(["cancelled", "entered-in-error"]);

/** The fixed tail of every description. Quoted in tests; do not reword lightly. */
const FOOTER_PREFIX = "Synced by Healthy · last checked ";
const FOOTER_SUFFIX = " · do not edit";
const GHOST_TITLE_PREFIX = "Cancelled: ";
const VANISHED_PREFIX = "No longer on the provider's schedule as of ";

/**
 * Characters a title template uses to join two values.
 *
 * Only these two, and deliberately not a hyphen, comma or dash: those appear
 * inside real values ("Follow-up Visit", "COVID-19 Test") and splitting on them
 * would mangle the very data the title exists to show.
 */
const SPLIT_SEPARATORS: ReadonlySet<string> = new Set(["·", "|"]);

/**
 * Characters that may be trimmed from either end of a title or a segment.
 *
 * Wider than `SPLIT_SEPARATORS`, because a template written with a hyphen or a
 * dash still leaves one stranded when the value after it renders empty -- and at
 * the *edge* of a segment there is no value left to mangle.
 */
const TRIM_CHARS: ReadonlySet<string> = new Set([
  " ",
  "\t",
  "\n",
  "·",
  "|",
  "-",
  "–",
  "—",
  ",",
  ";",
  ":",
]);

/** Runs of whitespace. A bare `\s+` cannot backtrack, unlike an alternation. */
const WHITESPACE_RUN = /\s+/gu;
const TEMPLATE_TOKEN = /\{(\w+)\}/gu;

/** Title used when a template rendered to nothing at all. */
const FALLBACK_TITLE = "Appointment";

/** The global settings the mapping reads. A projection, not the whole table. */
export interface MappingSettings {
  /** IANA zone every rendered time is expressed in. Never defaulted in source. */
  timezone: string;
  defaultTitleTemplate: string;
  defaultColorId: string | null;
  ghostColorId: string;
  defaultArrivalOffsetMin: number;
}

/** The provider fields the mapping reads, with its stored per-provider config. */
interface MappingProvider {
  id: string;
  displayName: string;
  portalUrl: string | null;
  /** `providers.config_json`, already parsed. Snake_case, as stored. */
  config: ProviderConfig;
}

export interface MappingInput {
  provider: MappingProvider;
  settings: MappingSettings;
  /** ISO instant the run started, rendered into the footer. */
  nowIso: string;
}

export interface CalendarMapping {
  model: CalendarEventModel;
  /** The Encounter status the model was built from. */
  status: string;
  /** True when the status means the appointment is off the schedule. */
  offSchedule: boolean;
  /** The real appointment time, before the arrive-early offset. */
  reportedStart: string;
  /** Minutes the event start was moved earlier. 0 when no offset applies. */
  arrivalOffsetMin: number;
  /**
   * The visit's contact-serial number, when the source published one.
   *
   * Epic puts the same number on the Encounter that the patient portal reports,
   * which makes it the one exact way to recognise that a portal visit and a FHIR
   * Encounter are the same appointment. `worker/sync/portal-sync.ts` is the only
   * reader; everything else about the mapping is indifferent to it.
   */
  csn?: string;
}

export interface GhostOptions {
  /** `settings.ghost_color_id`. Grey, in Google's palette. */
  ghostColorId: string;
  timezone: string;
  /**
   * ISO instant the appointment *first* disappeared upstream -- the
   * `calendar_events.ghosted_at` stamp, not the current run's clock. A moving
   * value here would re-patch every ghost on every run.
   */
  ghostedAtIso: string;
}

/** `<providerId>:<encounterId>`: the primary key and the Google marker alike. */
export function eventKey(providerId: string, encounterId: string): string {
  return `${providerId}:${encounterId}`;
}

/** Split an event key back into its halves. Null when it is not one of ours. */
export function parseEventKey(key: string): { providerId: string; encounterId: string } | null {
  const index = key.indexOf(":");
  return index <= 0 || index === key.length - 1
    ? null
    : { providerId: key.slice(0, index), encounterId: key.slice(index + 1) };
}

/**
 * Minutes to arrive early for this appointment.
 *
 * Precedence, most specific first: a per-visit-type override on the provider, the
 * provider's own default, then the global default. Visit types are matched
 * case-insensitively because Epic's `Encounter.type[0].text` capitalisation
 * varies between organisations and between versions of the same one.
 */
export function arrivalOffsetFor(
  visitType: string | undefined,
  config: ProviderConfig,
  fallbackMin: number,
): number {
  if (visitType !== undefined) {
    const wanted = visitType.trim().toLowerCase();
    for (const [type, minutes] of Object.entries(config.arrival_offsets_by_visit_type)) {
      if (type.trim().toLowerCase() === wanted) return minutes;
    }
  }
  return config.arrival_offset_min ?? fallbackMin;
}

/** Address lines, city, state and postcode as one comma-separated string. */
function addressText(address: NormalizedAddress | undefined): string | undefined {
  if (address === undefined) return undefined;
  const parts = [...(address.lines ?? []), address.city, address.state, address.postalCode];
  const text = parts.filter((part) => part !== undefined && part.trim() !== "").join(", ");
  return text === "" ? undefined : text;
}

/**
 * The Google `location` string.
 *
 * A telehealth visit has no address worth navigating to, so it says so and
 * carries the portal link instead -- that is the thing the owner has to click.
 */
function locationText(
  view: NormalizedAppointmentView,
  portalUrl: string | null,
): string | undefined {
  if (view.telehealth) {
    return portalUrl === null ? "Video visit" : `Video visit · ${portalUrl}`;
  }
  const parts = [view.location?.name, addressText(view.location?.address)].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? undefined : parts.join(", ");
}

/**
 * Render a title template.
 *
 * A `Map` lookup rather than `values[name]`: an attacker-controlled key cannot
 * reach `Object.prototype` this way, and the `security/detect-object-injection`
 * rule is right to object to the indexed form.
 */
export function renderTitle(template: string, values: ReadonlyMap<string, string>): string {
  const rendered = template.replaceAll(TEMPLATE_TOKEN, (_match, name: string) =>
    (values.get(name) ?? "").trim(),
  );
  return tidyTitle(rendered);
}

/** Strip separator characters and whitespace from both ends. Linear; no regex. */
function trimEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_CHARS.has(value.charAt(start))) start += 1;
  while (end > start && TRIM_CHARS.has(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

/**
 * Collapse what an empty placeholder left behind.
 *
 * `{visitType} · {practitioner}` with no practitioner renders as
 * "Office Visit · ", and a title that ends in a separator looks like a bug. The
 * string is split on its separators, empty segments are dropped along with the
 * separator that introduced them, and what is left is rejoined -- so two adjacent
 * empty values collapse to nothing rather than to a row of dots.
 */
function tidyTitle(rendered: string): string {
  const collapsed = rendered.replaceAll(WHITESPACE_RUN, " ");
  let out = "";
  let separator = "";
  let segment = "";
  const flush = (): void => {
    const text = trimEdges(segment);
    if (text === "") return;
    out = out === "" ? text : `${out} ${separator} ${text}`;
  };
  for (const char of collapsed) {
    if (!SPLIT_SEPARATORS.has(char)) {
      segment += char;
      continue;
    }
    flush();
    // Only remember the separator when something precedes it: a leading one is
    // dropped along with the empty segment in front of it.
    if (out !== "") separator = char;
    segment = "";
  }
  flush();
  return out === "" ? FALLBACK_TITLE : out;
}

/** `11:30 AM` in the owner's zone. What `{apptTime}` and the title suffix use. */
export function formatApptTime(iso: string, timezone: string): string {
  return formatInZone(iso, timezone, { hour: "numeric", minute: "2-digit" });
}

/** A date and time for a human: the description footer and the vanished note. */
function formatStamp(iso: string, timezone: string): string {
  return formatInZone(iso, timezone);
}

function footerLine(nowIso: string, timezone: string): string {
  return `${FOOTER_PREFIX}${formatStamp(nowIso, timezone)}${FOOTER_SUFFIX}`;
}

/** Drop empty entries and join what is left, so a missing field leaves no gap. */
function joinLines(lines: readonly (string | undefined)[]): string {
  return lines.filter((line): line is string => line !== undefined && line !== "").join("\n");
}

function joinSections(sections: readonly string[]): string {
  return sections.filter((section) => section !== "").join("\n\n");
}

/** Join present values on one line, so a missing half leaves no dangling dash. */
function joinInline(parts: readonly (string | undefined)[], separator: string): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(separator);
}

/**
 * The description, minus the footer.
 *
 * Kept separate because this -- and not the whole description -- is what the
 * fingerprint covers. See the module comment.
 */
function descriptionBody(view: NormalizedAppointmentView, provider: MappingProvider): string {
  const where = joinLines([
    view.org ?? provider.displayName,
    view.department,
    view.location?.name,
    joinInline([addressText(view.location?.address), view.location?.phone], " · "),
  ]);
  const who = joinLines([
    joinInline([view.practitioner, view.specialty], " — "),
    joinInline([view.visitType, view.status], " · "),
  ]);
  return joinSections([where, who, provider.portalUrl ?? ""]);
}

/** Everything the fingerprint covers, in a fixed order. */
function fingerprintPayload(model: Omit<CalendarEventModel, "fingerprint">, body: string): string {
  return JSON.stringify([
    model.key,
    model.title,
    model.start,
    model.end,
    model.timeZone,
    model.location ?? null,
    model.colorId ?? null,
    model.transparent,
    body,
  ]);
}

/**
 * Build the calendar event for one appointment.
 *
 * Throws `bad_request` when the Encounter has no start: an appointment with no
 * time cannot become a timed calendar event, and the sync filters those out
 * before it gets here. Returning a sentinel instead would push the same check
 * onto every caller.
 */
export async function buildCalendarModel(
  view: NormalizedAppointmentView,
  input: MappingInput,
): Promise<CalendarMapping> {
  const reportedStart = view.start;
  if (reportedStart === undefined || reportedStart === "") {
    throw new AppError("bad_request", "appointment has no start time", {
      encounterId: view.encounterId,
    });
  }
  const { provider, settings } = input;
  const timezone = settings.timezone;
  const apptTime = formatApptTime(reportedStart, timezone);

  const offsetMin = arrivalOffsetFor(
    view.visitType,
    provider.config,
    settings.defaultArrivalOffsetMin,
  );
  const start = offsetMin > 0 ? addMinutes(reportedStart, -offsetMin) : reportedStart;
  const end = resolveEnd(reportedStart, view.end, start);

  const template = provider.config.title_template ?? settings.defaultTitleTemplate;
  const baseTitle = renderTitle(
    template,
    new Map([
      ["visitType", view.visitType ?? ""],
      ["practitioner", view.practitioner ?? ""],
      ["specialty", view.specialty ?? ""],
      ["orgShort", provider.config.org_short ?? view.org ?? provider.displayName],
      ["org", view.org ?? provider.displayName],
      ["department", view.department ?? ""],
      ["apptTime", apptTime],
    ]),
  );
  // The suffix earns its place only when the event no longer starts at the
  // appointment time. Adding it unconditionally would duplicate what the start
  // already says.
  const title = offsetMin > 0 ? `${baseTitle} (appt ${apptTime})` : baseTitle;

  const location = locationText(view, provider.portalUrl);
  const colorId = provider.config.color_id ?? settings.defaultColorId ?? undefined;
  const body = descriptionBody(view, provider);

  const draft: Omit<CalendarEventModel, "fingerprint"> = {
    key: eventKey(provider.id, view.encounterId),
    provider: provider.id,
    title,
    description: joinSections([body, footerLine(input.nowIso, timezone)]),
    ...(location !== undefined && { location }),
    start,
    end,
    timeZone: timezone,
    ...(colorId !== undefined && { colorId }),
    transparent: false,
  };

  return {
    model: { ...draft, fingerprint: await sha256Hex(fingerprintPayload(draft, body)) },
    status: view.status,
    offSchedule: OFF_SCHEDULE_STATUSES.has(view.status),
    reportedStart,
    arrivalOffsetMin: offsetMin,
    ...(view.csn !== undefined && { csn: view.csn }),
  };
}

/**
 * The event end.
 *
 * Default duration is measured from the *reported* start, so an arrive-early
 * offset lengthens the event rather than shifting it. An upstream end that
 * somehow lands at or before the (possibly shifted) start is replaced the same
 * way: Google rejects a non-positive duration outright.
 */
function resolveEnd(reportedStart: string, upstreamEnd: string | undefined, start: string): string {
  const fallback = addMinutes(reportedStart, DEFAULT_DURATION_MIN);
  if (upstreamEnd === undefined || upstreamEnd === "") return fallback;
  return Date.parse(upstreamEnd) > Date.parse(start) ? upstreamEnd : fallback;
}

/**
 * The ghost variant of an active model.
 *
 * Never a delete: a cancelled appointment stays in the owner's history, greyed
 * out, transparent so it stops blocking time, with the original details intact
 * and a line saying when it went away.
 */
export async function ghostModel(
  model: CalendarEventModel,
  options: GhostOptions,
): Promise<CalendarEventModel> {
  const title = model.title.startsWith(GHOST_TITLE_PREFIX)
    ? model.title
    : `${GHOST_TITLE_PREFIX}${model.title}`;
  const vanished = `${VANISHED_PREFIX}${formatStamp(options.ghostedAtIso, options.timezone)}.`;
  return {
    ...model,
    title,
    description: joinSections([model.description, vanished]),
    colorId: options.ghostColorId,
    transparent: true,
    // Derived from the active fingerprint plus a stable instant, so a ghost
    // needs exactly one patch however many runs see it.
    fingerprint: await sha256Hex(`ghost:${model.fingerprint}:${options.ghostedAtIso}`),
  };
}
