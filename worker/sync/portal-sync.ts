/**
 * The patient-portal pass: upcoming visits onto the calendar, without waiting for
 * FHIR to admit they exist.
 *
 * It runs at the end of the hourly calendar run, per provider whose portal
 * account is `active`, and it writes through exactly the same mapping, diff and
 * event writer the FHIR pass uses. What is different is only where the
 * appointments came from and what is known about them.
 *
 * ### Why this pass exists at all
 *
 * Epic's patient-facing FHIR view does not reliably return a scheduled
 * appointment before it happens -- the owner's next two visits were absent from
 * it -- while the portal has known about them since they were booked. So the
 * portal is the source for *upcoming* visits and FHIR stays the source for
 * everything else, including history and every clinical resource the MCP serves.
 *
 * ### The four rules that keep one appointment from becoming two events
 *
 * **A portal visit the FHIR pass already mapped is skipped.** Matched by the
 * Encounter's own CSN where there is one, and otherwise by a start time within
 * `DEDUPE_WINDOW_SECONDS`. Counted as `portalSkipped`, so "why is the portal
 * reporting three visits and writing one event" has an answer on the Runs page.
 *
 * **A FHIR Encounter that turns up later adopts the portal's row and its event.**
 * That is `adoptPortalRows`, called from the FHIR pass before its diff: the row is
 * renamed from `<providerId>:csn:<csn>` to `<providerId>:<encounterId>` and the
 * existing calendar entry is patched in place. Without it the portal event would
 * be ghosted (it is no longer "upcoming") and a duplicate inserted beside it.
 *
 * **A visit that vanishes while it is still in the future is a cancellation; one
 * that vanishes after its start time is just over.** `LoadUpcoming` only ever
 * returns what is ahead, so every visit eventually disappears from it. Ghosting on
 * absence alone would grey out every appointment the owner ever attended, the hour
 * after they attended it. So a past row is left exactly as it is, and only a
 * future one that stopped being returned is ghosted.
 *
 * **A canceled or no-show visit is ghosted with its own details.** Those are still
 * *in* the payload, so unlike a vanished one there is a model to render: the event
 * is patched to the grey, transparent, "Cancelled:" variant rather than merely
 * having its row marked. A vanished future visit has no model left -- nothing
 * caches portal payloads -- so it gets the row-only ghost the diff already has for
 * that case, and the calendar entry is left alone rather than rewritten from
 * guesses.
 *
 * Log lines carry provider ids, counts and stable codes. Never a visit, a
 * practitioner, a CSN, a code or a byte of portal markup -- the CSN is an upstream
 * identifier and is treated exactly like an Encounter id (see
 * `worker/db/repos/calendar-events.ts`'s `logSafeKey`).
 */

import { buildEventBody } from "../google/calendar.ts";
import { isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";
import { fromIso, toIso } from "../lib/time.ts";
import { MAX_PARSED_VISITS } from "../providers/mychart/index.ts";

import { resolveReconnectAlert } from "./alerts.ts";
import { buildCalendarModel, ghostModel } from "./mapping.ts";
import { planChanges } from "./plan.ts";
import { SIGN_IN_BUSY_CODE, acquirePortalSignIn, releasePortalSignIn } from "./portal-gate.ts";
import {
  DEDUPE_WINDOW_SECONDS,
  csnOfEncounterId,
  isOffSchedule,
  portalKeyPrefix,
  portalVisitView,
} from "./portal-mapping.ts";
import {
  OTP_WAIT_SECONDS,
  attemptsLeft,
  failSignIn,
  openPortalSession,
  portalDeps,
  signInAndWait,
} from "./portal-signin.ts";

import type { SyncDeps } from "./deps.ts";
import type { CalendarMapping, MappingSettings } from "./mapping.ts";
import type { PlanCandidate, PlanEntry } from "./plan.ts";
import type { PortalSession } from "./portal-signin.ts";
import type { RunState } from "./run.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { CalendarEventRow, ProviderRow } from "../db/rows.ts";
import type { CalendarClient } from "../google/calendar.ts";
import type { CalendarEventModel, EventRecord } from "../google/types.ts";
import type { PortalVisit } from "../providers/mychart/index.ts";

/** Portal rows per provider the diff will consider. Far above any real schedule. */
const MAX_PORTAL_ROWS = 500;

/**
 * What the FHIR pass saw for one provider, as the dedupe needs it.
 *
 * Collected during the FHIR pass rather than read back from `calendar_events`,
 * because the strongest signal -- the Encounter's CSN -- is not stored: the row
 * holds only the event key and the shifted start.
 */
export interface FhirSighting {
  /** CSNs the Encounters published. The exact match when both sides have one. */
  csns: Set<string>;
  /** Shifted starts of the events the FHIR pass mapped, as unix seconds. */
  starts: number[];
}

/** Everything the portal pass needs. Built by `calendar-sync.ts`, which has it all. */
export interface PortalPassInput {
  ctx: Ctx;
  repos: Repos;
  calendar: CalendarClient;
  calendarId: string;
  timezone: string;
  /** ISO instant the run started, rendered into the description footer. */
  nowIso: string;
  /** Unix second the sync window opens. Rows older than this are not diffed. */
  windowStartSeconds: number;
  /** Every `healthy=1` event on the target calendar, across every provider. */
  googleEvents: readonly EventRecord[];
  settings: MappingSettings;
  state: RunState;
  deps: SyncDeps;
  /** What the FHIR pass mapped this run, per provider id. */
  fhirSeen: ReadonlyMap<string, FhirSighting>;
  /** Narrow the pass to these providers. The manual button's argument. */
  providerIds?: readonly string[] | undefined;
  /**
   * How long to wait for an emailed code when a session has to be re-established.
   *
   * The default is the full wait, which is right under cron: a scheduled
   * invocation has the wall clock and the visits are wanted in this run. Zero means
   * "do not attempt a sign-in at all", which is what the Durable Object passes --
   * it establishes the session in its own alarm loop first, precisely so that no
   * single invocation sleeps for minutes. See `portal-runner.ts`.
   */
  signInWaitSeconds?: number | undefined;
}

/** One visit, with the event it would produce and whether it is a duplicate. */
interface PortalCandidateBuild {
  visit: PortalVisit;
  mapping: CalendarMapping;
  /** True when the FHIR pass already covers this appointment. */
  duplicate: boolean;
}

/**
 * Sync every active portal account's upcoming visits.
 *
 * Per-provider isolation, like the FHIR pass: a portal that will not let us in
 * costs one code on `portalErrors` and nothing else. Never throws.
 */
export async function runPortalPass(input: PortalPassInput): Promise<void> {
  const { ctx, repos } = input;
  const accounts = await repos.portalAccounts.listActive();
  const wanted = input.providerIds;
  const selected =
    wanted === undefined ? accounts : accounts.filter((row) => wanted.includes(row.provider_id));
  if (selected.length === 0) {
    ctx.log.debug("portal.no_accounts", { active: accounts.length });
    return;
  }

  for (const account of selected) {
    const providerId = account.provider_id;
    try {
      await syncPortalProvider(input, providerId);
    } catch (error) {
      const code = isAppError(error) ? error.code : "internal";
      input.state.summary.portalErrors.push(code);
      ctx.log.error("portal.provider_failed", { providerId, ...errorFields(error) });
    }
  }
}

/** One provider: session, visits, diff, writes. */
async function syncPortalProvider(input: PortalPassInput, providerId: string): Promise<void> {
  const { ctx, repos } = input;
  const session = await ensureSession(input, providerId);
  if (session === null) return;

  const visits = await session.client.loadUpcoming(input.timezone);
  // The jar as it is now: `LoadUpcoming` refreshes the session cookie, and
  // dropping that refresh is how a working session expires a day early.
  await repos.portalAccounts.saveCookieJar(providerId, session.client.jar.serialise());
  input.state.summary.portalVisits += visits.length;
  ctx.log.info("portal.upcoming", { providerId, visits: visits.length });
  // The parse stops at `MAX_PARSED_VISITS` (see `visits.ts`), so a malicious or
  // broken payload cannot drive an unbounded number of calendar inserts into the
  // owner's primary calendar. Reported as a warning code rather than swallowed,
  // because "your schedule was truncated" is something the Runs page has to say.
  // A real schedule that happens to be exactly at the cap reads as truncated too,
  // which is the right way round to be wrong about it.
  if (visits.length >= MAX_PARSED_VISITS) {
    ctx.log.warn("portal.visits_truncated", { providerId, visits: visits.length });
    input.state.warningCodes.add("portal_visits_truncated");
    input.state.summary.warnings += 1;
  }

  const provider = await repos.providers.get(providerId);
  if (provider === null) return;

  const builds = await buildPortalCandidates(input, provider, visits);
  const stored = await repos.calendarEvents.list({
    providerId,
    source: "portal",
    limit: MAX_PORTAL_ROWS,
  });
  // Narrowed to the window before the diff sees them, exactly as the FHIR pass
  // narrows its own: a row older than the window would be ghosted for being old.
  const rows = stored.filter(
    (row) => row.start_at === null || row.start_at >= input.windowStartSeconds,
  );

  const { candidates, models, ghosts, touched } = await portalPlanInputs(input, builds, rows);
  // Portal keys only, not every key this provider owns: the FHIR pass's events
  // have no candidate here, and handing them to the diff would report each one as
  // an orphan. `:csn:` is what makes the two halves distinguishable by key alone.
  const portalPrefix = portalKeyPrefix(providerId);
  const events = input.googleEvents.filter((event) =>
    (keyOf(event) ?? "").startsWith(portalPrefix),
  );
  const plan = planChanges(rows, events, candidates);
  ctx.log.info("portal.plan", {
    providerId,
    inserts: plan.inserts.length,
    patches: plan.patches.length,
    ghosts: plan.ghosts.length,
    restores: plan.restores.length,
    unchanged: plan.unchanged.length,
    skipped: plan.skipped.length,
  });

  input.state.unchanged += plan.unchanged.length;
  for (const entry of plan.entries) {
    await applyPortalEntry(input, providerId, entry, models, ghosts, rows);
  }
  // Past visits the portal has stopped returning: not a change, but the rows were
  // looked at and `last_seen_at` has to say so.
  if (touched.length > 0) await repos.calendarEvents.touch(touched);

  // The portal answered, so whatever the reconnect card was warning about is over.
  await repos.portalAccounts.markActive(providerId);
  await resolveReconnectAlert(ctx, { providerId, portal: true }, input.deps);
}

/** The `key` marker on a Google event, or null when it carries none. */
function keyOf(event: EventRecord): string | null {
  const properties = event.extendedProperties?.private;
  if (properties?.healthy !== "1") return null;
  const key = properties.key;
  return key === undefined || key === "" ? null : key;
}

/**
 * A live session for this provider, signing in once if the stored one is dead.
 *
 * Null means the pass cannot continue for this provider, and the reason has
 * already been recorded on the account (and on `portalErrors`). Exactly one
 * automatic sign-in attempt per run, and only while the daily budget allows one:
 * the account's own counter is what stops an hourly cron from walking into a
 * lockout, and running out opens the reconnect card rather than retrying.
 */
async function ensureSession(
  input: PortalPassInput,
  providerId: string,
): Promise<PortalSession | null> {
  const { ctx } = input;
  const deps = portalDeps(input.deps);
  const opened = await openPortalSession(ctx, providerId, deps);
  if (await opened.session.client.isSessionAlive()) return opened.session;

  ctx.log.info("portal.session_dead", { providerId });
  const waitSeconds = input.signInWaitSeconds ?? OTP_WAIT_SECONDS;
  if (waitSeconds <= 0) {
    // The caller has said it will not wait for a code here. Not a failure of the
    // account -- the session simply has to be re-established somewhere that can
    // wait -- so nothing is marked and no card is opened.
    input.state.summary.portalErrors.push("portal_session_expired");
    return null;
  }

  const left = await attemptsLeft(ctx, providerId);
  if (left <= 0) {
    ctx.log.warn("portal.attempts_exhausted", { providerId });
    const outcome = await failSignIn(ctx, providerId, "portal_attempts_exhausted", deps);
    input.state.summary.portalErrors.push(outcome.code ?? "portal_attempts_exhausted");
    return null;
  }

  // The same gate the admin button takes, so the two drivers cannot overlap: two
  // sign-ins can each pass the attempt check above before either increments it,
  // and the second `SendCode` invalidates the code the first is waiting for. See
  // `portal-gate.ts`.
  if (!(await acquirePortalSignIn(ctx, providerId, "cron"))) {
    ctx.log.info("portal.signin_busy", { providerId });
    input.state.summary.portalErrors.push(SIGN_IN_BUSY_CODE);
    return null;
  }
  let outcome;
  try {
    outcome = await signInAndWait(ctx, providerId, deps, waitSeconds);
  } finally {
    await releasePortalSignIn(ctx, providerId);
  }
  if (outcome.phase !== "signed_in") {
    input.state.summary.portalErrors.push(outcome.code ?? "internal");
    return null;
  }
  // Re-opened, deliberately: the sign-in sealed a new jar and the client that ran
  // it is not this one. Carrying on with the stale client would send the request
  // that just succeeded in signing in without the cookie it earned.
  const reopened = await openPortalSession(ctx, providerId, deps);
  return reopened.session;
}

/** Map every visit, and decide which ones the FHIR pass has already covered. */
async function buildPortalCandidates(
  input: PortalPassInput,
  provider: ProviderRow,
  visits: readonly PortalVisit[],
): Promise<PortalCandidateBuild[]> {
  const seen = input.fhirSeen.get(provider.id);
  // Rows the FHIR pass wrote, whenever it wrote them: the Encounter for a visit
  // may have been mapped in an earlier run and not returned in this one.
  const fhirRows = await input.repos.calendarEvents.list({
    providerId: provider.id,
    source: "fhir",
    limit: MAX_PORTAL_ROWS,
  });
  const starts = [
    ...(seen?.starts ?? []),
    ...fhirRows
      .map((row) => row.start_at)
      .filter((start): start is number => start !== null && start >= input.windowStartSeconds),
  ];

  const config = await input.repos.providers.getConfig(provider.id);
  const builds: PortalCandidateBuild[] = [];
  for (const visit of visits) {
    const mapping = await buildCalendarModel(portalVisitView(provider.id, visit), {
      provider: {
        id: provider.id,
        displayName: provider.display_name,
        portalUrl: provider.portal_url,
        config,
      },
      settings: input.settings,
      nowIso: input.nowIso,
    });
    const start = fromIso(mapping.model.start);
    const duplicate =
      (seen?.csns.has(visit.csn) ?? false) ||
      starts.some((other) => Math.abs(other - start) <= DEDUPE_WINDOW_SECONDS);
    builds.push({ visit, mapping, duplicate });
  }

  const skipped = builds.filter((build) => build.duplicate).length;
  input.state.summary.portalSkipped += skipped;
  if (skipped > 0) input.ctx.log.info("portal.deduped", { providerId: provider.id, skipped });
  return builds;
}

/** The candidates, the two model maps, and the rows that only need a timestamp. */
async function portalPlanInputs(
  input: PortalPassInput,
  builds: readonly PortalCandidateBuild[],
  rows: readonly CalendarEventRow[],
): Promise<{
  candidates: PlanCandidate[];
  models: Map<string, CalendarEventModel>;
  ghosts: Map<string, CalendarEventModel>;
  touched: string[];
}> {
  const models = new Map<string, CalendarEventModel>();
  const ghosts = new Map<string, CalendarEventModel>();
  const candidates: PlanCandidate[] = [];
  const rowByKey = new Map(rows.map((row) => [row.event_key, row]));
  const now = input.ctx.now();

  for (const build of builds) {
    const key = build.mapping.model.key;
    const row = rowByKey.get(key);
    // A duplicate with no row of its own is simply not calendared. A duplicate
    // that *does* have a row is one the FHIR pass failed to adopt, so the portal's
    // copy is the stray one and is ghosted -- with its own details, since there is
    // a model for it.
    if (row === undefined && build.duplicate) continue;
    const offSchedule = build.duplicate || isOffSchedule(build.visit.status);
    candidates.push(
      await portalCandidate(input, {
        key,
        mapping: build.mapping,
        row,
        offSchedule,
        absent: false,
        models,
        ghosts,
      }),
    );
  }

  const present = new Set(candidates.map((candidate) => candidate.key));
  const touched: string[] = [];
  for (const row of rows) {
    if (present.has(row.event_key)) continue;
    // See the module comment: the portal only ever reports what is ahead, so a row
    // whose visit has already started is over rather than cancelled.
    if (row.start_at !== null && row.start_at <= now) {
      touched.push(row.event_key);
      continue;
    }
    candidates.push({
      key: row.event_key,
      fingerprint: "",
      ghostFingerprint: null,
      offSchedule: true,
      absent: true,
      upcoming: true,
      // Nothing caches portal payloads, so the details this event was built from
      // are gone: the row is ghosted and the calendar entry left as it is.
      hasModel: false,
    });
  }
  return { candidates, models, ghosts, touched };
}

/** One mapped visit as a plan candidate, filling the model maps as it goes. */
async function portalCandidate(
  input: PortalPassInput,
  args: {
    key: string;
    mapping: CalendarMapping;
    row: CalendarEventRow | undefined;
    offSchedule: boolean;
    absent: boolean;
    models: Map<string, CalendarEventModel>;
    ghosts: Map<string, CalendarEventModel>;
  },
): Promise<PlanCandidate> {
  args.models.set(args.key, args.mapping.model);
  let ghostFingerprint: string | null = null;
  if (args.offSchedule || args.absent) {
    // When it FIRST went away, so the ghost's own description -- and therefore its
    // fingerprint -- stops moving after the run that ghosted it.
    const ghostedAt = args.row?.ghosted_at ?? input.ctx.now();
    const ghost = await ghostModel(args.mapping.model, {
      ghostColorId: input.settings.ghostColorId,
      timezone: input.timezone,
      ghostedAtIso: toIso(ghostedAt),
    });
    args.ghosts.set(args.key, ghost);
    ghostFingerprint = ghost.fingerprint;
  }
  return {
    key: args.key,
    fingerprint: args.mapping.model.fingerprint,
    ghostFingerprint,
    offSchedule: args.offSchedule,
    absent: args.absent,
    upcoming: fromIso(args.mapping.reportedStart) > input.ctx.now(),
    hasModel: true,
  };
}

/** Carry out one planned change. The portal half of `calendar-sync.ts`'s writer. */
async function applyPortalEntry(
  input: PortalPassInput,
  providerId: string,
  entry: PlanEntry,
  models: ReadonlyMap<string, CalendarEventModel>,
  ghosts: ReadonlyMap<string, CalendarEventModel>,
  rows: readonly CalendarEventRow[],
): Promise<void> {
  const { state } = input;
  switch (entry.action) {
    case "insert": {
      const model = models.get(entry.key);
      if (model === undefined) return;
      const created = await input.calendar.insertEvent(input.calendarId, buildEventBody(model));
      await persistPortalRow(input, providerId, entry.key, created.id, model);
      state.summary.eventsInserted += 1;
      return;
    }
    case "patch":
    case "restore": {
      await patchPortal(input, providerId, entry, models);
      return;
    }
    case "ghost": {
      const ghost = ghosts.get(entry.key);
      if (ghost === undefined || entry.googleEventId === null) return;
      const patched = await input.calendar.patchEvent(
        input.calendarId,
        entry.googleEventId,
        buildEventBody(ghost),
      );
      await input.repos.calendarEvents.markGhost(entry.key, {
        // A null patch means the owner deleted the event by hand. The row still
        // becomes a ghost, but the stored fingerprint must keep describing
        // whatever is actually on the calendar -- which is now nothing.
        fingerprint: patched === null ? null : ghost.fingerprint,
        ghostedAt: ghostedAtFor(entry.key, rows, input.ctx.now()),
      });
      state.summary.eventsGhosted += 1;
      return;
    }
    case "ghost-row-only": {
      await input.repos.calendarEvents.markGhost(entry.key, {
        fingerprint: null,
        ghostedAt: ghostedAtFor(entry.key, rows, input.ctx.now()),
      });
      state.summary.eventsGhosted += 1;
      return;
    }
    default: {
      if (entry.action === "unchanged") await input.repos.calendarEvents.touch([entry.key]);
      return;
    }
  }
}

async function patchPortal(
  input: PortalPassInput,
  providerId: string,
  entry: PlanEntry,
  models: ReadonlyMap<string, CalendarEventModel>,
): Promise<void> {
  const model = models.get(entry.key);
  if (model === undefined || entry.googleEventId === null) return;
  const restore = entry.action === "restore";
  const patched = await input.calendar.patchEvent(
    input.calendarId,
    entry.googleEventId,
    buildEventBody(model),
  );
  if (patched === null) {
    // It went away between the listing and the patch; inserting is what the plan
    // would have decided had it known.
    const created = await input.calendar.insertEvent(input.calendarId, buildEventBody(model));
    await persistPortalRow(input, providerId, entry.key, created.id, model, restore);
    input.state.summary.eventsInserted += 1;
    return;
  }
  await persistPortalRow(input, providerId, entry.key, patched.id, model, restore);
  if (restore) input.state.summary.eventsRestored += 1;
  else input.state.summary.eventsPatched += 1;
}

function ghostedAtFor(key: string, rows: readonly CalendarEventRow[], now: number): number {
  return rows.find((row) => row.event_key === key)?.ghosted_at ?? now;
}

async function persistPortalRow(
  input: PortalPassInput,
  providerId: string,
  key: string,
  googleEventId: string,
  model: CalendarEventModel,
  restore = false,
): Promise<void> {
  const encounterId = key.slice(providerId.length + 1);
  await input.repos.calendarEvents.upsert({
    eventKey: key,
    providerId,
    encounterId,
    calendarId: input.calendarId,
    googleEventId,
    fingerprint: model.fingerprint,
    startAt: fromIso(model.start),
    source: "portal",
    portalCsn: csnOfEncounterId(encounterId),
    restore,
  });
}

/** What `adoptPortalRows` was given and what it hands back. */
export interface AdoptPortalInput {
  ctx: Ctx;
  repos: Repos;
  providerId: string;
  /** This run's FHIR mappings, by event key. */
  mappings: ReadonlyMap<string, CalendarMapping>;
  rows: readonly CalendarEventRow[];
  events: readonly EventRecord[];
}

/**
 * Hand the portal's rows and events over to the FHIR pass where they describe the
 * same appointment.
 *
 * Called from the FHIR pass *before* its diff runs, and the ordering is the whole
 * point. By the time an Encounter appears for a visit the portal already
 * calendared, the portal's own row is usually past its start time and therefore
 * (by this module's rules) untouched -- so the FHIR pass would see no row for its
 * key, insert a second event, and leave the owner with two of everything. Renaming
 * the row first turns the situation into an ordinary one: the diff finds a row and
 * an event whose fingerprint no longer matches, patches it, and the appointment
 * keeps the calendar entry it has had all along.
 *
 * Returns the rows and events with the rename applied, so the caller diffs against
 * what is now true rather than re-reading. Never throws: a failed adoption is a
 * duplicate event, which is bad, but a failed *sync* is worse.
 */
export async function adoptPortalRows(input: AdoptPortalInput): Promise<{
  rows: CalendarEventRow[];
  events: EventRecord[];
  adopted: number;
}> {
  const portalRows = input.rows.filter((row) => row.source === "portal");
  if (portalRows.length === 0 || input.mappings.size === 0) {
    return { rows: [...input.rows], events: [...input.events], adopted: 0 };
  }

  const renames = new Map<string, { toKey: string; encounterId: string }>();
  const claimed = new Set<string>();
  for (const [key, mapping] of input.mappings) {
    if (input.rows.some((row) => row.event_key === key)) continue;
    const match = portalRows.find((row) => !claimed.has(row.event_key) && sameVisit(row, mapping));
    if (match === undefined) continue;
    claimed.add(match.event_key);
    renames.set(match.event_key, {
      toKey: key,
      encounterId: key.slice(input.providerId.length + 1),
    });
  }
  if (renames.size === 0) {
    return { rows: [...input.rows], events: [...input.events], adopted: 0 };
  }

  let adopted = 0;
  for (const [fromKey, rename] of renames) {
    try {
      const moved = await input.repos.calendarEvents.rekey(fromKey, rename.toKey, {
        encounterId: rename.encounterId,
        source: "fhir",
      });
      if (moved) adopted += 1;
      else renames.delete(fromKey);
    } catch (error) {
      renames.delete(fromKey);
      input.ctx.log.warn("portal.adopt_failed", {
        providerId: input.providerId,
        ...errorFields(error),
      });
    }
  }
  input.ctx.log.info("portal.adopted", { providerId: input.providerId, adopted });

  return {
    rows: input.rows.map((row) => {
      const rename = renames.get(row.event_key);
      return rename === undefined
        ? row
        : {
            ...row,
            event_key: rename.toKey,
            encounter_id: rename.encounterId,
            source: "fhir" as const,
            portal_csn: null,
            // Cleared by `rekey` too: what is on the calendar came from the
            // portal's fields, so the FHIR fingerprint cannot match it and the
            // diff has to see a change.
            fingerprint: "",
          };
    }),
    // The marker on the calendar entry still says the portal key. The patch this
    // adoption sets up rewrites it; until then the diff has to be able to find it
    // under its new name, so the in-memory copy is rewritten here.
    events: input.events.map((event) => rekeyEvent(event, renames)),
    adopted,
  };
}

/** True when a portal row and a FHIR mapping are two sightings of one visit. */
function sameVisit(row: CalendarEventRow, mapping: CalendarMapping): boolean {
  // The CSN first: it is the portal's own identifier for the visit, and Epic
  // publishes the same number on the Encounter, so a match is not a guess.
  if (row.portal_csn !== null && mapping.csn !== undefined) return row.portal_csn === mapping.csn;
  if (row.start_at === null) return false;
  const apart = Math.abs(row.start_at - fromIso(mapping.model.start));
  return apart <= DEDUPE_WINDOW_SECONDS;
}

/** A copy of one event carrying its new key, or the event itself. */
function rekeyEvent(
  event: EventRecord,
  renames: ReadonlyMap<string, { toKey: string }>,
): EventRecord {
  const properties = event.extendedProperties?.private;
  if (properties === undefined) return event;
  const rename = renames.get(properties.key ?? "");
  if (rename === undefined) return event;
  return {
    ...event,
    extendedProperties: { private: { ...properties, key: rename.toKey } },
  };
}
