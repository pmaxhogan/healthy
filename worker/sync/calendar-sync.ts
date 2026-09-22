/**
 * The hourly appointment sync.
 *
 * One pass, per provider, isolated: `Encounter?patient=…&date=ge…` -> resolve the
 * references -> map to calendar events -> diff against `calendar_events` and
 * Google -> insert, patch, ghost or restore. A provider that fails is recorded on
 * the run summary and the run carries on with the next one, because one
 * organisation's outage must not cost the owner the other's appointments.
 *
 * The parts that are subtle rather than merely long:
 *
 * **The window is the ghosting boundary.** The search asks for
 * `date >= today - window_past_days` in the owner's zone, so an appointment older
 * than that is absent from every run by construction. Diffing it would ghost a
 * real, finished visit for the crime of being old, so rows are narrowed to the
 * window before the diff sees them -- and Google is listed 30 days wider so an
 * event just outside the window is still recognised rather than orphaned.
 *
 * **Google is listed once, then partitioned.** `listSyncedEvents` returns every
 * event carrying `healthy=1`, across every provider. Each provider's slice is
 * taken by the `providerId:` prefix on the event key; without that, provider A
 * would see B's events as orphans.
 *
 * **A vanished appointment is rebuilt from the cache.** Ghosting needs the
 * original title, address and practitioner, and the organisation has stopped
 * returning them. Every run therefore writes the Encounters it saw into
 * `fhir_cache`, and the ghost is built from that copy. When even the cache has
 * forgotten, the row is marked ghost with no Google write and the event is left as
 * it is -- better a stale event than one whose details we invented.
 *
 * **Epic 4119 suppresses ghosting for that provider.** The organisation has
 * admitted the patient-facing view filtered results, so absence proves nothing:
 * inserts and patches proceed, ghosts wait for a run that saw everything.
 *
 * **Any 429 stops the whole run.** `sync_backoff_until` is set to
 * `now + max(Retry-After, 2h)` and the remaining providers are not attempted --
 * hammering a second organisation while the first is throttling us is how an app
 * gets its access reviewed.
 *
 * **The patient-portal pass runs last, and is a separate module.** The portal
 * knows about an upcoming visit before Epic's patient-facing FHIR view admits it
 * exists, so `portal-sync.ts` calendars those and this pass stays the source for
 * everything else. Two seams connect them, both of which exist to stop one
 * appointment becoming two events: this pass hands `runPortalPass` the CSNs and
 * start times it mapped, so the portal can skip what is already calendared; and it
 * calls `adoptPortalRows` before its own diff, so an Encounter arriving for a visit
 * the portal calendared weeks ago takes over that row and its calendar entry rather
 * than inserting a duplicate beside it.
 *
 * **A row follows its event when the target calendar changes.** An event id is
 * only valid on the calendar it was created on, and the Google listing above is
 * always against the *current* target -- so a row still pointing at the old one
 * is invisible to this run until `followCalendarMoves` moves it, before the diff
 * ever sees it.
 *
 * Nothing here logs a title, a name, an address, a URL or a resource body. Ids of
 * our own rows, counts, resource type names, HTTP statuses and Epic codes only.
 */

import { makeRepos } from "../db/index.ts";
import { clearSyncBackoff, getAllSettings, getTimezone, setSyncBackoff } from "../db/settings.ts";
import {
  appointmentViewFromEncounter,
  mapResolver,
  normalizeResource,
} from "../fhir/normalize/index.ts";
import { appointmentEncounterSearch, encounterStatusFilter } from "../fhir/search-registry.ts";
import { buildEventBody } from "../google/calendar.ts";
import { isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";
import { DAY_SECONDS, dateInZone, fromIso, startOfDayInZone, toIso } from "../lib/time.ts";

import { resolveReconnectAlert } from "./alerts.ts";
import { backoffUntilSeconds, rateLimitOf } from "./backoff.ts";
import { getCapabilityIndex } from "./discovery.ts";
import { getGoogleCalendarFor } from "./google-tokens.ts";
import { sha256Hex } from "./hash.ts";
import { buildCalendarModel, ghostModel } from "./mapping.ts";
import { eventKeyOf, planChanges } from "./plan.ts";
import { portalKeyPrefix } from "./portal-mapping.ts";
import { adoptPortalRows, runPortalPass } from "./portal-sync.ts";
import { collectEncounterReferences, resolveReferences } from "./references.ts";
import { emptySummary, record } from "./run.ts";
import { syncTargets } from "./targets.ts";
import { getFhirClientFor } from "./tokens.ts";

import type { SyncDeps } from "./deps.ts";
import type { CalendarMapping, MappingSettings } from "./mapping.ts";
import type { PlanCandidate, PlanEntry } from "./plan.ts";
import type { FhirSighting, PortalPassInput } from "./portal-sync.ts";
import type { RunState } from "./run.ts";
import type { SyncTarget } from "./targets.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { CalendarEventRow } from "../db/rows.ts";
import type { Settings } from "../db/schemas.ts";
import type { NormalizedAppointmentView } from "../fhir/normalize/index.ts";
import type { Encounter, Resource, SearchWarning } from "../fhir/types.ts";
import type { CalendarClient } from "../google/calendar.ts";
import type { CalendarEventModel, EventRecord } from "../google/types.ts";
import type { RunKind, RunSummary } from "@shared/types.ts";

/** Epic's "the patient-facing view filtered these results" code. */
const FILTERED_VIEW_CODE = "4119";

/** How long a synced Encounter stays in `fhir_cache`. Matches the daily refresh. */
const ENCOUNTER_TTL_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Extra days of Google events to list beyond the FHIR window.
 *
 * An event whose start is a day either side of the window boundary must still be
 * recognised as ours, or it is reported as an orphan every run.
 */
const GOOGLE_WINDOW_MARGIN_DAYS = 30;

/** Rows to consider per provider. Far above any realistic appointment history. */
const MAX_ROWS = 2000;

export interface CalendarSyncOptions {
  /** Narrow the run to these providers. The admin "sync now" button's argument. */
  providerIds?: string[];
  /** The `run_log.kind` to record. "calendar" for cron, "manual" for a button. */
  trigger?: RunKind;
  /** Ignore (and clear) an active backoff. Only ever set by a human action. */
  force?: boolean;
  /**
   * Run only the patient-portal pass, skipping every FHIR search.
   *
   * What `POST /api/providers/:id/portal/sync` asks for, through the Durable
   * Object in `portal-runner.ts`. It is the same run row, the same Google listing
   * and the same writer -- only the upstream that is not consulted differs -- so
   * the Runs page reports it exactly like any other manual run.
   */
  portalOnly?: boolean;
  /**
   * How long the portal pass may wait for an emailed verification code.
   *
   * Left alone under cron, which has the wall clock for the full wait and wants
   * the visits in this run. The Durable Object passes 0: it has already
   * established the session in its own alarm loop, one ten-second step per
   * invocation, precisely so that no invocation sleeps for minutes -- and a 0 here
   * guarantees that a session that died between its check and this pass cannot
   * start the whole wait over inside one alarm.
   */
  signInWaitSeconds?: number;
  /** Test seams; production omits it. See `deps.ts`. */
  deps?: SyncDeps;
}

/**
 * Sync every eligible provider's appointments to the calendar.
 *
 * Writes one `run_log` row and resolves with its summary. Does not throw: a
 * caller in a request handler is expected to `ectx.waitUntil(...)` this.
 */
export async function runCalendarSync(
  ctx: Ctx,
  options: CalendarSyncOptions = {},
): Promise<RunSummary> {
  const deps = options.deps ?? {};
  const repos = makeRepos(ctx);
  const settings = await getAllSettings(ctx);

  const backoffUntil = settings.sync_backoff_until;
  if (backoffUntil !== null && backoffUntil > ctx.now()) {
    if (options.force !== true) {
      // No run row: a skipped run did nothing, and a row per skipped hour would
      // bury the runs that did something.
      ctx.log.info("sync.backoff.skip", { secondsRemaining: backoffUntil - ctx.now() });
      return { ...emptySummary(), backedOff: true };
    }
    // A human pressed the button. The backoff exists to stop *automated*
    // hammering, not to lock the owner out of their own app.
    await clearSyncBackoff(ctx);
    ctx.log.info("sync.backoff.cleared");
  }

  const outcome = await record(ctx, options.trigger ?? "calendar", async (state) => {
    await syncAllProviders(ctx, repos, settings, state, options, deps);
  });
  return outcome.summary;
}

/** Shared per-run context, so the per-provider functions take one argument. */
interface RunContext {
  ctx: Ctx;
  repos: Repos;
  calendar: CalendarClient;
  calendarId: string;
  timezone: string;
  nowIso: string;
  /** Unix second the FHIR window opens. Rows older than this are not diffed. */
  windowStartSeconds: number;
  /** `YYYY-MM-DD` in the owner's zone, for the FHIR `date=ge` parameter. */
  windowStartDate: string;
  googleEvents: EventRecord[];
  settings: MappingSettings;
  state: RunState;
  deps: SyncDeps;
  /**
   * What the FHIR pass mapped, per provider, for the portal pass to dedupe
   * against.
   *
   * Filled in as each provider is synced and read once at the end. It carries the
   * Encounters' CSNs, which `calendar_events` does not store and which are the one
   * exact way to tell that a portal visit and an Encounter are the same
   * appointment.
   */
  fhirSeen: Map<string, FhirSighting>;
}

async function syncAllProviders(
  ctx: Ctx,
  repos: Repos,
  settings: Settings,
  state: RunState,
  options: CalendarSyncOptions,
  deps: SyncDeps,
): Promise<void> {
  const targets = await syncTargets(repos, options.providerIds);
  state.summary.providers = targets.length;
  if (targets.length === 0) {
    ctx.log.info("sync.no_targets");
    return;
  }

  // Resolved before the provider loop: without a calendar there is nothing to do
  // with any appointment, and failing N times identically is just noise.
  let calendar: CalendarClient;
  try {
    calendar = await getGoogleCalendarFor(ctx, deps);
  } catch (error) {
    ctx.log.error("sync.google_unavailable", errorFields(error));
    state.summary.errors.push({ providerId: "google", code: codeOf(error) });
    return;
  }

  const timezone = await getTimezone(ctx);
  const nowIso = toIso(ctx.now());
  const windowStartIso = toIso(
    fromIso(startOfDayInZone(nowIso, timezone)) - settings.window_past_days * DAY_SECONDS,
  );
  const calendarId = settings.calendar_id;

  let googleEvents: EventRecord[];
  try {
    googleEvents = await calendar.listSyncedEvents({
      calendarId,
      timeMin: toIso(fromIso(windowStartIso) - GOOGLE_WINDOW_MARGIN_DAYS * DAY_SECONDS),
    });
  } catch (error) {
    ctx.log.error("sync.google_list_failed", errorFields(error));
    state.summary.errors.push({ providerId: "google", code: codeOf(error) });
    return;
  }

  const run: RunContext = {
    ctx,
    repos,
    calendar,
    calendarId,
    timezone,
    nowIso,
    windowStartSeconds: fromIso(windowStartIso),
    windowStartDate: dateInZone(windowStartIso, timezone),
    googleEvents,
    settings: {
      timezone,
      defaultTitleTemplate: settings.default_title_template,
      defaultColorId: settings.default_color_id,
      ghostColorId: settings.ghost_color_id,
      defaultArrivalOffsetMin: settings.default_arrival_offset_min,
    },
    state,
    deps,
    fhirSeen: new Map(),
  };

  // Empty for a portal-only run: the Google listing and the run row above are
  // shared, and only the FHIR searches are skipped.
  const fhirTargets = options.portalOnly === true ? [] : targets;
  for (const target of fhirTargets) {
    try {
      await syncProvider(run, target);
      await repos.connections.recordSync(target.connection.id, "calendar");
    } catch (error) {
      const limit = rateLimitOf(error);
      state.summary.errors.push({ providerId: target.provider.id, code: codeOf(error) });
      ctx.log.error("sync.provider_failed", {
        providerId: target.provider.id,
        ...errorFields(error),
      });
      if (limit === null) continue;
      // See the module comment: a 429 anywhere stops everything.
      await setSyncBackoff(ctx, backoffUntilSeconds(ctx.now(), limit.retryAfterMs));
      state.summary.backedOff = true;
      ctx.log.warn("sync.backoff.set", {
        status: limit.status,
        retryAfterMs: limit.retryAfterMs ?? null,
      });
      return;
    }
  }

  // Last, and after every provider: the portal pass needs to know what the FHIR
  // pass mapped before it decides which of its visits are already calendared.
  await runPortalPass(portalInput(run, options));
}

/** The portal pass's input, from the run context that already holds all of it. */
function portalInput(run: RunContext, options: CalendarSyncOptions): PortalPassInput {
  return {
    ctx: run.ctx,
    repos: run.repos,
    calendar: run.calendar,
    calendarId: run.calendarId,
    timezone: run.timezone,
    nowIso: run.nowIso,
    windowStartSeconds: run.windowStartSeconds,
    googleEvents: run.googleEvents,
    settings: run.settings,
    state: run.state,
    deps: run.deps,
    fhirSeen: run.fhirSeen,
    ...(options.providerIds !== undefined && { providerIds: options.providerIds }),
    ...(options.signInWaitSeconds !== undefined && {
      signInWaitSeconds: options.signInWaitSeconds,
    }),
  };
}

/** One provider, from search to calendar writes. */
async function syncProvider(run: RunContext, target: SyncTarget): Promise<void> {
  const { ctx, repos } = run;
  const providerId = target.provider.id;
  const session = await getFhirClientFor(ctx, providerId, run.deps);

  // `status` is sent only where the organisation advertises it; the client-side
  // pass in `statusFilter.apply` runs either way, because Epic's support for the
  // parameter varies by version and it is sometimes quietly ignored.
  const capabilities = await getCapabilityIndex(
    ctx,
    repos,
    target.provider,
    session.adapter,
    await session.getAccessToken(),
  );
  const statusFilter = encounterStatusFilter(capabilities);
  const search = appointmentEncounterSearch(session.patientId, run.windowStartDate);
  const result = await session.client.search<Encounter>("Encounter", {
    ...search.params,
    ...statusFilter.params,
  });

  const filtered = countWarnings(run, result.warnings);
  // `period.start` is mandatory: an appointment with no time cannot be a timed
  // calendar event, and Epic does emit Encounters without one.
  const encounters = statusFilter
    .apply(result.resources)
    .filter((encounter) => (encounter.period?.start ?? "") !== "");
  run.state.summary.encountersSeen += encounters.length;

  const references = collectEncounterReferences(encounters);
  const resolved = await resolveReferences(ctx, repos, providerId, references, session.client);
  run.state.summary.resourcesCached += resolved.resources.length;

  const mappings = await mapAppointments(run, target, encounters, resolved.resources);
  recordSightings(run, providerId, mappings);
  await cacheEncounters(run, providerId, encounters);

  const windowed = await windowRows(run, providerId);
  const followedEvents = await followCalendarMoves(run, providerId, windowed);
  const listed = [
    ...run.googleEvents.filter((event) => (eventKeyOf(event) ?? "").startsWith(`${providerId}:`)),
    ...followedEvents,
  ];

  // Before the diff, deliberately: a portal row for an appointment this run has an
  // Encounter for is renamed to the Encounter's key, so what follows patches the
  // event the portal already created instead of inserting a second one.
  const adopted = await adoptPortalRows({
    ctx,
    repos,
    providerId,
    mappings,
    rows: windowed,
    events: listed,
  });
  // Portal-sourced rows and events are the portal pass's to diff, and this pass
  // must not: it has no Encounter for one (that is the premise of the feature, not
  // a visit that vanished), so it would read every one of them as absent, ghost the
  // row with no Google write, and watch the portal pass restore it an instant
  // later -- a patch per portal visit per hour, for ever. Anything the adoption
  // just renamed carries a FHIR key and so survives both filters, which is the
  // point of doing this after it rather than before.
  const rows = adopted.rows.filter((row) => row.source !== "portal");
  const portalPrefix = portalKeyPrefix(providerId);
  const providerEvents = adopted.events.filter(
    (event) => !(eventKeyOf(event) ?? "").startsWith(portalPrefix),
  );

  const { candidates, models, ghosts } = await buildCandidates(run, target, mappings, rows);
  const plan = planChanges(rows, providerEvents, candidates, { suppressGhosting: filtered });
  ctx.log.info("sync.plan", {
    providerId,
    inserts: plan.inserts.length,
    patches: plan.patches.length,
    ghosts: plan.ghosts.length,
    restores: plan.restores.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
    orphans: plan.orphans.length,
  });
  if (plan.orphans.length > 0) {
    // Ours by marker, unknown by key. Counted and left alone: guessing at its
    // content would be worse than reporting it.
    ctx.log.warn("sync.orphans", { providerId, count: plan.orphans.length });
  }

  run.state.unchanged += plan.unchanged.length;
  for (const entry of plan.entries) {
    await applyEntry(run, providerId, entry, models, ghosts, rows);
  }
  await repos.connections.markConnected(target.connection.id);
  // A whole sync completed against this organisation, so whatever the alert was
  // warning about is over. This -- not only a successful token refresh -- is what
  // makes the Trello card's "this completes itself when the sync sees the new
  // connection" true: after the owner reconnects, the stored token is fresh for an
  // hour, so the next run succeeds *without* refreshing and would otherwise leave
  // the card open. One SELECT when nothing is open.
  await resolveReconnectAlert(ctx, { providerId }, run.deps);
}

/**
 * Remember what this provider's appointments look like, for the portal pass.
 *
 * The shifted start rather than the reported one, because that is what
 * `calendar_events.start_at` holds and what the portal's own mapping produces: the
 * two sides are then comparable without either having to undo an arrive-early
 * offset it cannot see.
 */
function recordSightings(
  run: RunContext,
  providerId: string,
  mappings: ReadonlyMap<string, CalendarMapping>,
): void {
  const csns = new Set<string>();
  const starts: number[] = [];
  for (const mapping of mappings.values()) {
    if (mapping.csn !== undefined) csns.add(mapping.csn);
    starts.push(fromIso(mapping.model.start));
  }
  run.fhirSeen.set(providerId, { csns, starts });
}

/** Tally warnings on the run and report whether the view was filtered. */
function countWarnings(run: RunContext, warnings: readonly SearchWarning[]): boolean {
  run.state.summary.warnings += warnings.length;
  let filtered = false;
  for (const warning of warnings) {
    if (warning.epicCode !== null) run.state.warningCodes.add(warning.epicCode);
    if (warning.epicCode === FILTERED_VIEW_CODE) filtered = true;
  }
  if (filtered) run.state.summary.filteredView = true;
  return filtered;
}

/** Normalize and map every Encounter the search returned. */
async function mapAppointments(
  run: RunContext,
  target: SyncTarget,
  encounters: readonly Encounter[],
  references: readonly Resource[],
): Promise<Map<string, CalendarMapping>> {
  const resolver = mapResolver([...encounters, ...references]);
  const normalizeCtx = { provider: target.provider.id, refs: resolver };
  const out = new Map<string, CalendarMapping>();
  for (const encounter of encounters) {
    const view = appointmentView(encounter, normalizeCtx);
    if (view === null) continue;
    const mapping = await buildCalendarModel(view, mappingInput(run, target));
    out.set(mapping.model.key, mapping);
  }
  return out;
}

/** The mapping's inputs for one provider. Built per call; it is three fields. */
function mappingInput(
  run: RunContext,
  target: SyncTarget,
): Parameters<typeof buildCalendarModel>[1] {
  return {
    provider: {
      id: target.provider.id,
      displayName: target.provider.display_name,
      portalUrl: target.provider.portal_url,
      config: target.config,
    },
    settings: run.settings,
    nowIso: run.nowIso,
  };
}

/** Normalize one Encounter into the calendar-facing view, or null if it is not one. */
function appointmentView(
  encounter: Encounter,
  normalizeCtx: { provider: string; refs: ReturnType<typeof mapResolver> },
): NormalizedAppointmentView | null {
  const normalized = normalizeResource(encounter, normalizeCtx);
  // `in` rather than a `resourceType` comparison: the generic fallback shape has
  // `resourceType: string`, so comparing the tag does not narrow the union.
  return "practitioners" in normalized
    ? appointmentViewFromEncounter(normalized, normalizeCtx)
    : null;
}

/** Write the Encounters this run saw into the cache, for the MCP and for ghosting. */
async function cacheEncounters(
  run: RunContext,
  providerId: string,
  encounters: readonly Encounter[],
): Promise<void> {
  if (encounters.length === 0) return;
  const report = await run.repos.fhirCache.upsertMany(
    providerId,
    encounters.map((encounter) => ({
      ...encounter,
      resourceType: "Encounter",
      id: encounter.id ?? "",
    })),
    ENCOUNTER_TTL_MS,
  );
  run.state.summary.resourcesCached += report.written + report.unchanged;
}

/**
 * The provider's rows that the diff may consider.
 *
 * Narrowed to the window, plus rows with no start at all -- those were written
 * from an Encounter whose period was unusable, and dropping them would leave a
 * row nothing ever reconciles.
 */
async function windowRows(run: RunContext, providerId: string): Promise<CalendarEventRow[]> {
  const rows = await run.repos.calendarEvents.list({ providerId, limit: MAX_ROWS });
  return rows.filter((row) => row.start_at === null || row.start_at >= run.windowStartSeconds);
}

/**
 * Follow a row's event onto the current target calendar when the owner has
 * moved the target since the row was written.
 *
 * `run.googleEvents` is listed once per run, from `run.calendarId`, before any
 * provider is touched -- so a row whose `calendar_id` is stale is invisible to
 * `eventByKey` no matter what the plan does with it: its event id was never
 * valid anywhere but the calendar it was created on. Left alone, the plan sees
 * "no matching event" and does the same thing it does for one the owner deleted
 * by hand -- re-insert an upcoming appointment, or quietly ghost a past one with
 * no Google write -- which duplicates every tracked appointment onto the new
 * calendar and strands the original, still looking live, on the old one.
 *
 * Calling Google's `events.move` here, before the diff runs, turns a stale row
 * back into an ordinary one: the moved event (same id, same
 * `extendedProperties`, now on `run.calendarId`) is folded into this
 * provider's event set below, so the rest of this run treats it exactly as if
 * it had always lived there. A row whose event has *also* vanished from the old
 * calendar (`moveEvent` -> `null`) is left untouched -- that is genuinely the
 * owner deleting it, and the plan's existing handling for a missing event is
 * the right answer.
 */
async function followCalendarMoves(
  run: RunContext,
  providerId: string,
  rows: readonly CalendarEventRow[],
): Promise<EventRecord[]> {
  const stale = rows.filter((row) => row.calendar_id !== run.calendarId);
  if (stale.length === 0) return [];

  const moved: EventRecord[] = [];
  let gone = 0;
  for (const row of stale) {
    const event = await run.calendar.moveEvent(
      row.calendar_id,
      row.google_event_id,
      run.calendarId,
    );
    if (event === null) {
      gone += 1;
      continue;
    }
    await run.repos.calendarEvents.moveCalendar(row.event_key, run.calendarId);
    moved.push(event);
  }
  run.ctx.log.info("sync.calendar_move", { providerId, moved: moved.length, gone });
  return moved;
}

/** The active and ghost models for every key the plan will consider. */
interface CandidateSet {
  candidates: PlanCandidate[];
  models: Map<string, CalendarEventModel>;
  ghosts: Map<string, CalendarEventModel>;
}

async function buildCandidates(
  run: RunContext,
  target: SyncTarget,
  mappings: ReadonlyMap<string, CalendarMapping>,
  rows: readonly CalendarEventRow[],
): Promise<CandidateSet> {
  const models = new Map<string, CalendarEventModel>();
  const ghosts = new Map<string, CalendarEventModel>();
  const candidates: PlanCandidate[] = [];
  const rowByKey = new Map(rows.map((row) => [row.event_key, row]));

  for (const [key, mapping] of mappings) {
    candidates.push(
      await candidateFor(run, key, mapping, rowByKey.get(key), false, models, ghosts),
    );
  }

  // Rows this run did not see upstream. Only rows: a Google event with neither a
  // row nor a live appointment is an orphan for the plan to report, and turning it
  // into a candidate here would quietly reclassify it as "vanished" instead.
  const absent = new Set<string>();
  for (const row of rows) if (!mappings.has(row.event_key)) absent.add(row.event_key);

  for (const key of absent) {
    const mapping = await mappingFromCache(run, target, key);
    candidates.push(await candidateFor(run, key, mapping, rowByKey.get(key), true, models, ghosts));
  }
  return { candidates, models, ghosts };
}

/** Turn one mapping (or the absence of one) into a plan candidate. */
async function candidateFor(
  run: RunContext,
  key: string,
  mapping: CalendarMapping | null,
  row: CalendarEventRow | undefined,
  absent: boolean,
  models: Map<string, CalendarEventModel>,
  ghosts: Map<string, CalendarEventModel>,
): Promise<PlanCandidate> {
  if (mapping === null) {
    return {
      key,
      fingerprint: "",
      ghostFingerprint: null,
      offSchedule: true,
      absent,
      upcoming: false,
      hasModel: false,
    };
  }
  models.set(key, mapping.model);
  const wantsGhost = absent || mapping.offSchedule;
  let ghostFingerprint: string | null = null;
  if (wantsGhost) {
    // The stamp the ghost quotes: when it FIRST disappeared, so the description
    // and therefore the fingerprint stop moving after the first ghosting run.
    const ghostedAt = row?.ghosted_at ?? run.ctx.now();
    const ghost = await ghostModel(mapping.model, {
      ghostColorId: run.settings.ghostColorId,
      timezone: run.timezone,
      ghostedAtIso: toIso(ghostedAt),
    });
    ghosts.set(key, ghost);
    ghostFingerprint = ghost.fingerprint;
  }
  return {
    key,
    fingerprint: mapping.model.fingerprint,
    ghostFingerprint,
    offSchedule: mapping.offSchedule,
    absent,
    upcoming: fromIso(mapping.reportedStart) > run.ctx.now(),
    hasModel: true,
  };
}

/**
 * Rebuild a vanished appointment from `fhir_cache`.
 *
 * This is why every run writes its Encounters back: the organisation has stopped
 * returning the appointment, and the ghost still has to carry its original title
 * and address. References come from the cache too, with no upstream reads -- a
 * cancelled appointment is not worth spending the read budget on.
 */
async function mappingFromCache(
  run: RunContext,
  target: SyncTarget,
  key: string,
): Promise<CalendarMapping | null> {
  const encounterId = key.slice(target.provider.id.length + 1);
  if (encounterId === "") return null;
  const cached = await run.repos.fhirCache.get(target.provider.id, "Encounter", encounterId);
  if (cached === null) return null;
  const encounter = cached.resource as Encounter;
  if ((encounter.period?.start ?? "") === "") return null;

  const references = collectEncounterReferences([encounter]);
  const pool: Resource[] = [encounter];
  for (const reference of references) {
    const row = await run.repos.fhirCache.get(
      target.provider.id,
      reference.resourceType,
      reference.id,
    );
    if (row !== null) pool.push(row.resource as Resource);
  }
  const view = appointmentView(encounter, {
    provider: target.provider.id,
    refs: mapResolver(pool),
  });
  if (view === null) return null;
  try {
    return await buildCalendarModel(view, mappingInput(run, target));
  } catch (error) {
    run.ctx.log.warn("sync.ghost.remap_failed", {
      providerId: target.provider.id,
      ...errorFields(error),
    });
    return null;
  }
}

/** Carry out one planned change. */
async function applyEntry(
  run: RunContext,
  providerId: string,
  entry: PlanEntry,
  models: ReadonlyMap<string, CalendarEventModel>,
  ghosts: ReadonlyMap<string, CalendarEventModel>,
  rows: readonly CalendarEventRow[],
): Promise<void> {
  switch (entry.action) {
    case "insert": {
      await writeInsert(run, providerId, entry, models);
      return;
    }
    case "patch":
    case "restore": {
      await writePatch(run, providerId, entry, models);
      return;
    }
    case "ghost": {
      await writeGhostPatch(run, entry, ghosts, rows);
      return;
    }
    case "ghost-row-only": {
      await writeGhostRow(run, providerId, entry, rows);
      return;
    }
    default: {
      // "unchanged" and "skip": nothing to write. `touch` below keeps
      // `last_seen_at` honest for a row the diff did look at.
      if (entry.action === "unchanged") await run.repos.calendarEvents.touch([entry.key]);
      return;
    }
  }
}

async function writeInsert(
  run: RunContext,
  providerId: string,
  entry: PlanEntry,
  models: ReadonlyMap<string, CalendarEventModel>,
): Promise<void> {
  const model = models.get(entry.key);
  if (model === undefined) return;
  const created = await run.calendar.insertEvent(run.calendarId, buildEventBody(model));
  await persistRow(run, providerId, entry.key, created.id, model);
  run.state.summary.eventsInserted += 1;
}

async function writePatch(
  run: RunContext,
  providerId: string,
  entry: PlanEntry,
  models: ReadonlyMap<string, CalendarEventModel>,
): Promise<void> {
  const model = models.get(entry.key);
  if (model === undefined || entry.googleEventId === null) return;
  const patched = await run.calendar.patchEvent(
    run.calendarId,
    entry.googleEventId,
    buildEventBody(model),
  );
  // Only a restore may move the row out of `ghost`; see `upsert` in the repo.
  const restore = entry.action === "restore";
  if (patched === null) {
    // The event went away between the list and the patch. Re-inserting is the
    // same decision the plan would have made had it known.
    const created = await run.calendar.insertEvent(run.calendarId, buildEventBody(model));
    await persistRow(run, providerId, entry.key, created.id, model, restore);
    run.state.summary.eventsInserted += 1;
    return;
  }
  await persistRow(run, providerId, entry.key, patched.id, model, restore);
  if (restore) run.state.summary.eventsRestored += 1;
  else run.state.summary.eventsPatched += 1;
}

async function writeGhostPatch(
  run: RunContext,
  entry: PlanEntry,
  ghosts: ReadonlyMap<string, CalendarEventModel>,
  rows: readonly CalendarEventRow[],
): Promise<void> {
  const ghost = ghosts.get(entry.key);
  if (ghost === undefined || entry.googleEventId === null) return;
  const patched = await run.calendar.patchEvent(
    run.calendarId,
    entry.googleEventId,
    buildEventBody(ghost),
  );
  // A null patch means the owner deleted it. The row still becomes a ghost: the
  // appointment really is gone, and re-creating a deleted event is never wanted.
  await run.repos.calendarEvents.markGhost(entry.key, {
    fingerprint: patched === null ? null : ghost.fingerprint,
    ghostedAt: ghostedAtFor(entry.key, rows, run.ctx.now()),
  });
  run.state.summary.eventsGhosted += 1;
}

async function writeGhostRow(
  run: RunContext,
  providerId: string,
  entry: PlanEntry,
  rows: readonly CalendarEventRow[],
): Promise<void> {
  // `entry.key` is `<providerId>:<encounterId>` -- the encounter half is Epic's
  // own resource id and must not reach Workers Logs (see `calendar-events.ts`'s
  // `logSafeKey`, which this mirrors; SECURITY.md, "No PHI in logs"). `providerId`
  // is already in scope here, so only the digest needs computing.
  const keyDigest = await sha256Hex(entry.key);
  run.ctx.log.info("sync.ghost.row_only", {
    providerId,
    eventKeyHash: keyDigest.slice(0, 12),
    reasonCode: entry.reason,
  });
  await run.repos.calendarEvents.markGhost(entry.key, {
    // No Google write happened, so the stored fingerprint must keep describing
    // whatever is actually on the calendar.
    fingerprint: null,
    ghostedAt: ghostedAtFor(entry.key, rows, run.ctx.now()),
  });
  run.state.summary.eventsGhosted += 1;
}

function ghostedAtFor(key: string, rows: readonly CalendarEventRow[], now: number): number {
  return rows.find((row) => row.event_key === key)?.ghosted_at ?? now;
}

async function persistRow(
  run: RunContext,
  providerId: string,
  key: string,
  googleEventId: string,
  model: CalendarEventModel,
  restore = false,
): Promise<void> {
  await run.repos.calendarEvents.upsert({
    eventKey: key,
    providerId,
    encounterId: key.slice(providerId.length + 1),
    calendarId: run.calendarId,
    googleEventId,
    fingerprint: model.fingerprint,
    startAt: fromIso(model.start),
    restore,
  });
}

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : "internal";
}
