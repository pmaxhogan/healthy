/**
 * The diff. Pure, exhaustive, and the only place that decides what happens to an
 * appointment.
 *
 * Three sources disagree on every run and the plan reconciles them:
 *
 *   - the **candidates**, built from what the organisation returned this run (plus
 *     whatever the cache still remembers about an appointment that has vanished)
 *   - the **rows** of `calendar_events`, which say what this app last wrote
 *   - the **Google events** carrying `extendedProperties.private.healthy = "1"`,
 *     which say what is actually on the calendar now
 *
 * Deliberate asymmetries, each of which is a bug if inverted:
 *
 *   - An appointment that has vanished and never had a row is **skipped**, not
 *     ghosted. A ghost for something that was never on the calendar would invent
 *     history.
 *   - A row whose Google event is gone was deleted by the owner by hand. It is
 *     re-created only if the appointment is still ahead and the row is not
 *     already a ghost; otherwise the row is ghosted with no Google write, because
 *     re-creating an event the owner deleted is the one thing they clearly did
 *     not want.
 *   - A Google event whose key has no row *and* no candidate is an **orphan**. It
 *     is reported and left alone: it carries this app's marker, so something
 *     wrote it, and guessing at its content would be worse than counting it.
 *   - `suppressGhosting` exists for Epic 4119 -- the organisation admitted it
 *     filtered the patient-facing view. Partial results must never ghost real
 *     appointments, so absent candidates are skipped for that run while inserts
 *     and patches carry on.
 */

import type { CalendarEventRow } from "../db/rows.ts";
import type { EventRecord } from "../google/types.ts";

/**
 * What the plan does with one key.
 *
 * `ghost-row-only` is the case with no Google write: the event is not there to
 * patch, so only `calendar_events` moves.
 */
type PlanAction =
  "insert" | "patch" | "ghost" | "ghost-row-only" | "restore" | "unchanged" | "skip";

/** Which of the two models a write should use. */
type PlanVariant = "active" | "ghost";

/** One appointment as the plan sees it. Built by the caller from the mapping. */
export interface PlanCandidate {
  key: string;
  /** Fingerprint of the active model. */
  fingerprint: string;
  /** Fingerprint of the ghost variant, when one could be built. */
  ghostFingerprint: string | null;
  /** Cancelled or entered-in-error upstream. */
  offSchedule: boolean;
  /** Not in this run's search results at all. */
  absent: boolean;
  /** The appointment starts after the run's clock. */
  upcoming: boolean;
  /**
   * False when no model could be built -- the appointment is gone from the
   * organisation and gone from the cache too, so there is nothing to write.
   */
  hasModel: boolean;
}

export interface PlanEntry {
  key: string;
  action: PlanAction;
  /** The Google event to patch, or null for an insert or a row-only change. */
  googleEventId: string | null;
  /** Which model the caller should render. Meaningless for `skip`/`unchanged`. */
  variant: PlanVariant;
  /** Short, stable reason code. Logged; never anything but these literals. */
  reason: string;
}

interface OrphanEntry {
  key: string;
  googleEventId: string;
}

export interface ChangePlan {
  /** Every key considered, in a stable order. */
  entries: PlanEntry[];
  inserts: PlanEntry[];
  patches: PlanEntry[];
  ghosts: PlanEntry[];
  restores: PlanEntry[];
  unchanged: PlanEntry[];
  skipped: PlanEntry[];
  orphans: OrphanEntry[];
}

export interface PlanOptions {
  /** Epic 4119: the view was filtered, so absence proves nothing this run. */
  suppressGhosting?: boolean;
}

/** The `key` a Google event carries, or null when it is not one of ours. */
export function eventKeyOf(event: EventRecord): string | null {
  const properties = event.extendedProperties?.private;
  if (properties === undefined) return null;
  // The marker is the invariant: without it the event is not ours to touch,
  // whatever else it carries.
  if (properties.healthy !== "1") return null;
  const key = properties.key;
  return key === undefined || key === "" ? null : key;
}

/** The fingerprint Google is holding for an event, when it recorded one. */
function eventFingerprintOf(event: EventRecord): string | null {
  const fingerprint = event.extendedProperties?.private.fp;
  return fingerprint === undefined || fingerprint === "" ? null : fingerprint;
}

function entry(
  key: string,
  action: PlanAction,
  reason: string,
  options: { googleEventId?: string | null; variant?: PlanVariant } = {},
): PlanEntry {
  return {
    key,
    action,
    googleEventId: options.googleEventId ?? null,
    variant: options.variant ?? "active",
    reason,
  };
}

/** The ghost branch: the appointment is cancelled, or gone from the search. */
function decideGhost(
  candidate: PlanCandidate,
  row: CalendarEventRow | undefined,
  event: EventRecord | undefined,
): PlanEntry {
  // Never on the calendar, so there is no history to preserve.
  if (row === undefined) return entry(candidate.key, "skip", "never_written");
  if (event === undefined || !candidate.hasModel) {
    if (row.state === "ghost") return entry(candidate.key, "unchanged", "already_ghost");
    const reason = candidate.hasModel ? "event_gone" : "no_model";
    return entry(candidate.key, "ghost-row-only", reason, { variant: "ghost" });
  }
  if (row.fingerprint === candidate.ghostFingerprint && row.state === "ghost") {
    return entry(candidate.key, "unchanged", "already_ghost", {
      googleEventId: row.google_event_id,
      variant: "ghost",
    });
  }
  return entry(candidate.key, "ghost", candidate.offSchedule ? "cancelled" : "vanished", {
    googleEventId: event.id,
    variant: "ghost",
  });
}

/** The live branch: the appointment is on the schedule. */
function decideActive(
  candidate: PlanCandidate,
  row: CalendarEventRow | undefined,
  event: EventRecord | undefined,
): PlanEntry {
  if (!candidate.hasModel) return entry(candidate.key, "skip", "no_model");
  if (event === undefined) {
    if (row === undefined) return entry(candidate.key, "insert", "new");
    // A ghost is never re-created: it went away once, and the owner has seen
    // that. Reappearing upstream restores it only while the event still exists.
    if (row.state === "ghost") return entry(candidate.key, "unchanged", "ghost_not_recreated");
    return candidate.upcoming
      ? entry(candidate.key, "insert", "recreate_deleted")
      : entry(candidate.key, "ghost-row-only", "past_deleted", { variant: "ghost" });
  }
  if (row === undefined) {
    // The event carries our marker but we have no row: a local data loss, or a
    // restore from a backup. Adopt it rather than inserting a duplicate.
    return entry(candidate.key, "patch", "adopt", { googleEventId: event.id });
  }
  if (row.state === "ghost") {
    return entry(candidate.key, "restore", "reappeared", { googleEventId: event.id });
  }
  const googleFingerprint = eventFingerprintOf(event);
  const settled =
    row.fingerprint === candidate.fingerprint &&
    (googleFingerprint === null || googleFingerprint === candidate.fingerprint);
  return settled
    ? entry(candidate.key, "unchanged", "fingerprint_match", { googleEventId: event.id })
    : entry(candidate.key, "patch", "changed", { googleEventId: event.id });
}

/**
 * Reconcile the three sources into one plan.
 *
 * `rows` and `googleEvents` must already be narrowed to one health system and to the
 * sync window: a row older than the window is absent from every search by
 * definition, and diffing it would ghost a real appointment for being old.
 */
export function planChanges(
  rows: readonly CalendarEventRow[],
  googleEvents: readonly EventRecord[],
  candidates: readonly PlanCandidate[],
  options: PlanOptions = {},
): ChangePlan {
  const rowByKey = new Map(rows.map((row) => [row.event_key, row]));
  const eventByKey = new Map<string, EventRecord>();
  for (const event of googleEvents) {
    const key = eventKeyOf(event);
    // Last write wins on a duplicate key: Google's list is ordered by start
    // time, so the later event is the one the owner is looking at.
    if (key !== null) eventByKey.set(key, event);
  }

  const entries: PlanEntry[] = [];
  const orphans: OrphanEntry[] = [];
  const candidateKeys = new Set<string>();

  for (const candidate of candidates) {
    candidateKeys.add(candidate.key);
    const row = rowByKey.get(candidate.key);
    const event = eventByKey.get(candidate.key);
    const wantsGhost = candidate.offSchedule || candidate.absent;
    if (wantsGhost && candidate.absent && options.suppressGhosting === true) {
      entries.push(entry(candidate.key, "skip", "filtered_view"));
      continue;
    }
    entries.push(
      wantsGhost ? decideGhost(candidate, row, event) : decideActive(candidate, row, event),
    );
  }

  for (const [key, event] of eventByKey) {
    if (candidateKeys.has(key) || rowByKey.has(key)) continue;
    orphans.push({ key, googleEventId: event.id });
  }

  const of = (action: PlanAction): PlanEntry[] => entries.filter((item) => item.action === action);
  return {
    entries,
    // A re-created event is an insert; `ghost-row-only` is a ghost with no
    // Google write. Grouping them here keeps the caller's loop flat.
    inserts: of("insert"),
    patches: of("patch"),
    ghosts: [...of("ghost"), ...of("ghost-row-only")],
    restores: of("restore"),
    unchanged: of("unchanged"),
    skipped: of("skip"),
    orphans,
  };
}
