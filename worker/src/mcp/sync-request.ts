/**
Deciding whether an MCP client may have the sync it asked for.

`sync_health_systems` is the one tool on this server that acts, and what it
causes is not free: an ordinary sync searches a health system's FHIR API and
reads its patient portal, a full refresh re-reads every resource type, and
the caller is a language model that can call a tool on a loop without
meaning to. So every request is judged here, per health system, before
anything is started, and the judgement is a pure function of facts the tool
gathered: this module reads nothing and starts nothing, which is what lets a
unit test walk every branch of it.

The order is deliberate. First what cannot work at all (`skipped`: nothing
to sync, or only the owner can fix it), then what the upstream asked for (a
rate-limit backoff), then a run already in flight, then data that is already
fresh, and only then the caller's own history. A request refused for an
earlier reason has not spent its cooldown.

What it never allows, by construction, is a patient-portal sign-in. The
portal kind is offered only for an account that is signed in already, and the
job the tool queues runs with no sign-in wait (`worker/src/sync/runner.ts`), so a
session that turns out to be dead is reported and left for the hourly sync,
which re-establishes it under its own limits, or for the owner.
*/

import { DAY_SECONDS, utcDayNumber } from "../lib/time.ts";

import type { HealthSystemInfo } from "./deps.ts";
import type { McpSyncKind, McpSyncRequestEntry, McpSyncRequestLimits } from "../db/rows.ts";

/** The three kinds of sync a caller can ask for, cheapest first. */
export const SYNC_KINDS = ["ordinary", "full", "portal"] as const satisfies readonly McpSyncKind[];

/** What one kind of sync is held to, per health system. */
interface SyncKindLimits extends McpSyncRequestLimits {
  /**
  How recently a sync of this kind may have finished, by any trigger, for a
  new one to be refused as pointless.
  */
  freshSeconds: number;
}

/**
The numbers. Each kind is also run on a schedule (hourly, every four hours,
and hourly again for the portal pass), so these bound how far an assistant
can add to that, not how fresh the data can be.

 - `ordinary`: at most once every 15 minutes and 12 times a UTC day, and not
   within 5 minutes of the last one that finished.
 - `full`: every resource type, so at most once every 4 hours and 3 times a
   UTC day, and not within 30 minutes of the last full refresh.
 - `portal`: a scrape of the owner's own portal session, so at most once
   every 30 minutes and 8 times a UTC day, and not within 10 minutes of the
   portal's last good answer.
*/
export const SYNC_LIMITS: Readonly<Record<McpSyncKind, SyncKindLimits>> = {
  ordinary: { cooldownSeconds: 15 * 60, dailyLimit: 12, freshSeconds: 5 * 60 },
  full: { cooldownSeconds: 4 * 60 * 60, dailyLimit: 3, freshSeconds: 30 * 60 },
  portal: { cooldownSeconds: 30 * 60, dailyLimit: 8, freshSeconds: 10 * 60 },
};

/** One kind's limits. A switch, so the lookup is by a known key and no other. */
export function syncLimits(kind: McpSyncKind): SyncKindLimits {
  switch (kind) {
    case "full": {
      return SYNC_LIMITS.full;
    }
    case "portal": {
      return SYNC_LIMITS.portal;
    }
    default: {
      return SYNC_LIMITS.ordinary;
    }
  }
}

/**
How one health system's request ended.

 - `started`: queued; the result arrives later, in `get_sync_status`.
 - `would_start`: a dry run found nothing in the way.
 - `already_running`: a run that covers it is in flight; nothing was added.
 - `refused`: a guardrail said no; `nextAllowedAt` says when to ask again.
 - `skipped`: there is nothing this tool can sync here; `code` says why.
 - `failed`: the request was allowed but could not be queued.
*/
export type SyncOutcome =
  "started" | "would_start" | "already_running" | "refused" | "skipped" | "failed";

/** Why. Stable: a caller may branch on these. */
export type SyncCode =
  | "started"
  | "dry_run"
  // already_running
  | "full_refresh_in_flight"
  | "run_in_flight"
  | "portal_sign_in_in_flight"
  // refused
  | "backed_off"
  | "recently_synced"
  | "cooldown"
  | "daily_limit"
  // skipped
  | "disabled"
  | "not_connected"
  | "needs_reauth"
  | "portal_not_configured"
  | "portal_no_credentials"
  | "portal_needs_reauth"
  | "portal_not_signed_in"
  // failed
  | "start_failed";

/** Everything the decision reads about the world, gathered once per call. */
export interface SyncFacts {
  /** Unix seconds. */
  now: number;
  /** Unix seconds an active rate-limit backoff runs to, or null. */
  backoffUntil: number | null;
  /** A sync run is open, or a calendar sync asked for here is queued. */
  runInFlight: boolean;
  /** Health system ids with a full refresh queued or running. */
  fullRefreshInFlight: ReadonlySet<string>;
  /** Health system ids with a portal sign-in in progress. */
  portalSignInInFlight: ReadonlySet<string>;
  /** This kind's request history, by health system id. */
  history: ReadonlyMap<string, McpSyncRequestEntry>;
}

/** The verdict on one health system, before anything is claimed or started. */
export interface SyncDecision {
  /** `ready` means nothing is in the way; the tool then claims and starts. */
  outcome: "ready" | "already_running" | "refused" | "skipped";
  code: SyncCode;
  /** Unix seconds the same request may be made again, when that is knowable. */
  nextAllowedAt: number | null;
}

const FHIR_SYNCABLE: ReadonlySet<string> = new Set(["connected", "error"]);

/** Whether the scheduled sync would attempt this health system's FHIR side. */
function fhirSyncable(healthSystem: HealthSystemInfo): boolean {
  return healthSystem.enabled && FHIR_SYNCABLE.has(healthSystem.status);
}

/** Why the FHIR side cannot be synced, as the sync's own target rule sees it. */
function fhirSkipCode(healthSystem: HealthSystemInfo): SyncCode {
  if (healthSystem.status === "needs_reauth") return "needs_reauth";
  return FHIR_SYNCABLE.has(healthSystem.status) ? "disabled" : "not_connected";
}

/**
Why the portal pass cannot run for this health system, or null when it can.

The first two are the check the admin API makes before it queues a portal
sync (no stored login, nothing to do). The last two go further than it does:
an account that needs re-authorising, was locked out or has never signed in
can only be brought back by a sign-in, and that is the owner's to start.
*/
export function portalSkipCode(healthSystem: HealthSystemInfo): SyncCode | null {
  const { portal } = healthSystem;
  if (portal === null) return "portal_not_configured";
  if (!portal.hasCredentials) return "portal_no_credentials";
  if (portal.state === "needs_reauth") return "portal_needs_reauth";
  return portal.state === "active" ? null : "portal_not_signed_in";
}

/** Why there is nothing to sync here, or null when there is. */
function skipCode(kind: McpSyncKind, healthSystem: HealthSystemInfo): SyncCode | null {
  if (kind === "portal") return portalSkipCode(healthSystem);
  if (fhirSyncable(healthSystem)) return null;
  // The ordinary sync also reads a signed-in portal, which is the whole of the
  // sync for a health system that has no FHIR connection.
  return kind === "ordinary" && portalSkipCode(healthSystem) === null
    ? null
    : fhirSkipCode(healthSystem);
}

/** When a sync of this kind last finished here, by any trigger. Unix seconds. */
export function lastCompletedAt(kind: McpSyncKind, healthSystem: HealthSystemInfo): number | null {
  if (kind === "full") return healthSystem.lastFullRefreshAt;
  const portalAt = healthSystem.portal?.lastOkAt ?? null;
  if (kind === "portal") return portalAt;
  return fhirSyncable(healthSystem) ? healthSystem.lastSyncAt : portalAt;
}

/** The run in flight that already covers this request, if any. */
function inFlightCode(
  kind: McpSyncKind,
  healthSystem: HealthSystemInfo,
  facts: SyncFacts,
): SyncCode | null {
  if (kind !== "portal" && facts.fullRefreshInFlight.has(healthSystem.id)) {
    return "full_refresh_in_flight";
  }
  if (kind !== "full" && facts.portalSignInInFlight.has(healthSystem.id)) {
    return "portal_sign_in_in_flight";
  }
  return facts.runInFlight ? "run_in_flight" : null;
}

/**
When the caller's own history next allows this request, and which limit is
in the way. Null when neither is.
*/
function historyLimit(
  kind: McpSyncKind,
  entry: McpSyncRequestEntry | undefined,
  now: number,
): { code: SyncCode; nextAllowedAt: number } | null {
  if (entry === undefined) return null;
  const limits = syncLimits(kind);
  const today = utcDayNumber(now);
  const cooledAt = entry.requestedAt + limits.cooldownSeconds;
  const cooldown = cooledAt > now ? { code: "cooldown" as const, nextAllowedAt: cooledAt } : null;
  if (entry.day !== today || entry.dayCount < limits.dailyLimit) return cooldown;
  const daily = { code: "daily_limit" as const, nextAllowedAt: (today + 1) * DAY_SECONDS };
  // The later of the two wins: a caller told to come back when the day turns
  // and then refused for a cooldown that runs past it was told the wrong thing.
  return cooldown !== null && cooldown.nextAllowedAt > daily.nextAllowedAt ? cooldown : daily;
}

/** Judge one health system's request. Reads `facts`, changes nothing. */
export function decideSync(
  kind: McpSyncKind,
  healthSystem: HealthSystemInfo,
  facts: SyncFacts,
): SyncDecision {
  const skip = skipCode(kind, healthSystem);
  if (skip !== null) return { outcome: "skipped", code: skip, nextAllowedAt: null };

  // Every kind runs through the sync engine, which stands down while a health
  // system is rate limiting this app; asking it would only be a no-op.
  if (facts.backoffUntil !== null) {
    return { outcome: "refused", code: "backed_off", nextAllowedAt: facts.backoffUntil };
  }

  const running = inFlightCode(kind, healthSystem, facts);
  if (running !== null) return { outcome: "already_running", code: running, nextAllowedAt: null };

  const completedAt = lastCompletedAt(kind, healthSystem);
  const freshUntil = completedAt === null ? 0 : completedAt + syncLimits(kind).freshSeconds;
  if (freshUntil > facts.now) {
    return { outcome: "refused", code: "recently_synced", nextAllowedAt: freshUntil };
  }

  const limit = historyLimit(kind, facts.history.get(healthSystem.id), facts.now);
  return limit === null
    ? { outcome: "ready", code: "started", nextAllowedAt: null }
    : { outcome: "refused", ...limit };
}

/** How many requests of this kind were let through today, for the answer. */
export function requestsToday(entry: McpSyncRequestEntry | undefined, now: number): number {
  return entry?.day === utcDayNumber(now) ? entry.dayCount : 0;
}
