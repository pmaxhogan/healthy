/**
 * Alerts -- a connection to renew, a sync that keeps failing, a phone's uploads
 * set aside: the D1 row, the Trello card, and the promise that neither can
 * break a sync.
 *
 * Two guarantees this module exists to make.
 *
 * **Nothing here ever throws into the sync.** A broken Trello token, a missing
 * list id, a 500 from Trello: all of it is caught and logged. An appointment sync
 * that fails because the *alert* about a previous failure failed would be the
 * worst possible failure mode, so every entry point is wrapped.
 *
 * **The row is the truth, the card is a convenience.** The `alerts` table's
 * partial unique index is what stops the hourly sync opening a new card every
 * hour a connection stays broken, so the row is written first and the card only
 * when the row was newly created. If Trello is unconfigured the row still lands
 * and the admin UI still shows the alert. A card that could not be created is
 * tried again by whatever next reports the same condition, and
 * `sweepReconnectAlerts` is what reports a condition nothing else will.
 *
 * ### Two kinds of broken, and one open alert per subject
 *
 * `reconnect` is "the owner has to act now": a refresh token was rejected, a
 * portal sign-in failed and the scheduled sync has stopped trying. It is opened
 * the moment that happens.
 *
 * `sync_failing` is everything else that stops a sync while the connection is
 * still authorised -- a token endpoint answering 500, a search that fails, a
 * page that stops parsing, a calendar that refuses writes. One of those is a
 * blip and says nothing; the same pass failing `FAILING_AFTER_ATTEMPTS` times
 * running, over at least `FAILING_MIN_SPAN_SECONDS`, is a fault the owner should
 * hear about. The streak is counted in `sync_failures`, per subject and per
 * pass, and the alert completes itself when the pass next works.
 *
 * A subject has at most one open alert, of either kind (the index is on the
 * subject alone). A failing sync does not stack on an open reconnect card: the
 * reconnect is the fix, and the card already says so. The other way round, a
 * reconnect *replaces* an open `sync_failing` alert, because a card saying
 * "nothing needs reconnecting" has just stopped being true. Each kind is closed
 * only by its own success signal: a token refresh that works closes a
 * `reconnect` alert and leaves a `sync_failing` one alone, since a good token
 * is exactly the state in which a sync can still be failing.
 *
 * ### Where the line is
 *
 * Not everything that goes wrong is a broken sync, and a card for a state that
 * is fine teaches the owner to ignore cards:
 *
 *  - a resource type the health system does not offer is `unsupported`, and a
 *    document type past the vendor's daily cap is deferred: neither is a failure;
 *  - a refresh in which some resource types fail and most succeed is recorded
 *    per type (`fhir_sync_state`, and so the MCP's `coverage`) and raises
 *    nothing, because one type failing at one vendor every time is a known
 *    nuisance. A refresh counts as failed when it threw, or when more of the
 *    types it attempted failed than succeeded (`full-refresh.ts`);
 *  - one visit's details page or one attachment failing is recorded on that
 *    item, not on the portal;
 *  - `needs_reauth` and `not_connected` are never counted here: the first has
 *    its reconnect card, the second is a choice;
 *  - a run that never happened (a rate-limit backoff) is not an attempt.
 *
 * And on the other side of it, things that are counted though nothing answered
 * with an error:
 *
 *  - a portal whose session has died while the scheduled run is holding back
 *    from signing in on its own (`portal_signin_deferred`, or a sign-in already
 *    in flight) is a portal that did not sync. Each of those waits ends by
 *    itself, but three runs of it is hours without the portal, and the owner
 *    can end it with "Sign in now";
 *  - a call to Google Calendar that fails anywhere in a run counts once, against
 *    Google, and not against the health system whose pass it happened in
 *    (`google-watch.ts`);
 *  - a run that throws before it reaches any subject (unreadable settings, a
 *    database error) counts against the sync itself (`noteRunOutcome`).
 *
 * An attempt is any run, the owner's "Sync now" included, which is why the
 * threshold is a count *and* a span of time.
 *
 * Log lines carry subjects (`health_system:<id>`, `portal:<id>`, `google`) and error
 * codes. Never a health system display name -- that names a real health system -- and
 * never a card body, which contains one.
 */

import { buildParkedCard } from "../alerts/parked.ts";
import { buildReconnectCard } from "../alerts/reconnect.ts";
import { buildSyncFailingCard } from "../alerts/sync-failing.ts";
import { createTrelloAlerts } from "../alerts/trello.ts";
import { makeRepos } from "../db/index.ts";
import {
  GOOGLE_SUBJECT,
  RUN_SUBJECT,
  deviceSubject,
  portalSubject,
  healthSystemSubject,
} from "../db/repos/alerts.ts";
import { errorFields } from "../lib/log.ts";

import { DEFAULT_PUBLIC_ORIGIN, resolveDeps } from "./deps.ts";

import type { SyncDeps } from "./deps.ts";
import type { TrelloAlerts } from "../alerts/trello.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { AlertRow, SyncFailureRow } from "../db/rows.ts";

/**
 * Who an alert is about: the Google account, one health system's FHIR connection,
 * or one health system's patient-portal session.
 *
 * The portal is a separate subject from the FHIR connection for the same health system,
 * and that is load-bearing. They break independently and are fixed differently --
 * one is an OAuth reconnect, the other is a password and an emailed code -- so one
 * subject for both would mean a dead portal session silently closing the card
 * about a dead FHIR grant, or the reverse.
 */
export type AlertSubject = "google" | { healthSystemId: string; portal?: true };

/** The label Trello cards use for the calendar account. Not a health system. */
const GOOGLE_SUBJECT_NAME = "Google";

/**
 * Who a failing sync is about: any of the above, or the run itself when it
 * stopped before reaching one. The run is never something to reconnect, so it
 * is not an `AlertSubject`.
 */
type FailingSubject = AlertSubject | "run";

/** `alerts.subject` for a subject. */
function subjectKey(subject: FailingSubject): string {
  if (subject === "run") return RUN_SUBJECT;
  if (subject === "google") return GOOGLE_SUBJECT;
  return subject.portal === true
    ? portalSubject(subject.healthSystemId)
    : healthSystemSubject(subject.healthSystemId);
}

/**
 * Build the Trello client, or null when the secrets are not all present.
 *
 * All four are required together: a key with no list id cannot create a card, so
 * a partial configuration is the same as none.
 */
function trelloFor(ctx: Ctx, trelloFetch: typeof fetch): TrelloAlerts | null {
  const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_MUST_LIST_ID, TRELLO_DONE_LIST_ID } = ctx.env;
  if (
    TRELLO_KEY === undefined ||
    TRELLO_TOKEN === undefined ||
    TRELLO_MUST_LIST_ID === undefined ||
    TRELLO_DONE_LIST_ID === undefined
  ) {
    ctx.log.info("alert.trello.unconfigured");
    return null;
  }
  return createTrelloAlerts({
    key: TRELLO_KEY,
    token: TRELLO_TOKEN,
    mustListId: TRELLO_MUST_LIST_ID,
    doneListId: TRELLO_DONE_LIST_ID,
    fetchImpl: trelloFetch,
    logger: ctx.log,
    now: () => new Date(ctx.now() * 1000),
  });
}

/**
 * The link the card tells the owner to open.
 *
 * Epic reconnects are per-connection, so the path carries the connection id.
 * Google has exactly one account, so it goes straight to the start of the
 * consent flow. A portal reconnect is neither, and goes to the Health systems page.
 * The origin is this app's own public domain, which is not personal data;
 * `deps.origin` overrides it for a local run or a test.
 */
function reconnectUrl(origin: string, subject: AlertSubject, connectionId: string | null): string {
  if (subject === "google") return `${origin}/oauth/google/start`;
  // A portal session is not an OAuth grant: there is no consent screen to send the
  // owner to, only the Health systems page, where they re-enter the password and press
  // "Sign in now". The path carries no health system id, because a URL that names one is
  // one lookup away from naming a health system and this one ends up in Trello.
  if (subject.portal === true) return `${origin}/health-systems`;
  return connectionId === null
    ? `${origin}/oauth/epic/start?healthSystem=${encodeURIComponent(subject.healthSystemId)}`
    : `${origin}/oauth/reconnect/${connectionId}`;
}

/**
 * Portal sign-in failures the stored password has nothing to do with.
 *
 * For these the fix is "Sign in now" and nothing else, and the card says so
 * (`portal_signin` in `reconnect.ts`). Any other code keeps the card that asks
 * for the password again, which is the safe reading of a code nobody listed.
 */
const PORTAL_RETRY_CODES: ReadonlySet<string> = new Set([
  "portal_2fa_required",
  "portal_2fa_rejected",
  "portal_unreachable",
  "portal_parse_failed",
  "portal_discovery_failed",
  "portal_handoff_failed",
  "portal_attempts_exhausted",
  "portal_signin_needs_owner",
  "upstream_unavailable",
  "upstream_error",
  "internal",
]);

/** Which flavour of card a subject wants. */
function kindOf(
  subject: AlertSubject,
  reason: string,
): "google" | "epic" | "portal" | "portal_signin" {
  if (subject === "google") return "google";
  if (subject.portal !== true) return "epic";
  return PORTAL_RETRY_CODES.has(reason) ? "portal_signin" : "portal";
}

/** What a card calls a subject. User data for a health system: never logged. */
async function displayNameOf(repos: Repos, subject: FailingSubject): Promise<string> {
  // The run has no name: its card does not use one.
  if (subject === "run") return "";
  if (subject === "google") return GOOGLE_SUBJECT_NAME;
  const healthSystem = await repos.healthSystems.get(subject.healthSystemId);
  return healthSystem?.display_name ?? subject.healthSystemId;
}

/** What a card is made of, built only once it is known a card is needed. */
interface CardContent {
  title: string;
  description: string;
  url: string;
}

/**
 * Make sure a Trello card tracks an alert row. Throws; the caller catches.
 *
 * False when no card was created: the row already has one, or Trello is not
 * configured. The row has landed either way, which is the half that matters.
 */
async function attachCard(
  ctx: Ctx,
  repos: Repos,
  deps: SyncDeps,
  opened: { alert: AlertRow; created: boolean },
  build: (origin: string) => Promise<CardContent>,
): Promise<boolean> {
  const { alert, created } = opened;
  if (!created && alert.trello_card_id !== null) {
    ctx.log.debug("alert.already_open", { subject: alert.subject });
    return false;
  }
  const resolved = resolveDeps(deps);
  const trello = trelloFor(ctx, resolved.trelloFetch);
  if (trello === null) return false;
  const card = await build(resolved.origin ?? DEFAULT_PUBLIC_ORIGIN);
  const { cardId } = await trello.openReconnectCard(card);
  await repos.alerts.setCard(alert.id, cardId);
  return true;
}

/**
 * Close whatever alert a subject has open and complete its card. Throws.
 *
 * The row first: a card that could not be moved is a stale card, and a row left
 * open is an alert that never ends.
 */
async function closeOpenAlert(ctx: Ctx, repos: Repos, deps: SyncDeps, key: string): Promise<void> {
  const resolved = await repos.alerts.resolve(key);
  const cardId = resolved?.trello_card_id ?? null;
  if (cardId === null) return;
  const trello = trelloFor(ctx, resolveDeps(deps).trelloFetch);
  if (trello === null) return;
  await trello.completeCard(cardId);
  ctx.log.info("alert.card_completed", { subject: key });
}

/**
 * Open (or re-find) the reconnect alert for a subject, and make sure a Trello
 * card tracks it.
 *
 * Idempotent: called on every failed refresh, it creates one row and one card
 * however many times the connection fails. An open `sync_failing` alert for the
 * same subject is closed first and replaced -- see the module comment.
 */
export async function openReconnectAlert(
  ctx: Ctx,
  subject: AlertSubject,
  reason: string,
  deps: SyncDeps = {},
): Promise<void> {
  const key = subjectKey(subject);
  try {
    const repos = makeRepos(ctx);
    let opened = await repos.alerts.openOrGet(key, "reconnect", reason);
    if (opened.alert.kind === "sync_failing") {
      ctx.log.info("alert.superseded", { subject: key, reasonCode: reason });
      try {
        await closeOpenAlert(ctx, repos, deps, key);
      } catch (error) {
        // The old card not moving must not cost the owner the new one.
        ctx.log.warn("alert.supersede_card_failed", { subject: key, ...errorFields(error) });
      }
      opened = await repos.alerts.openOrGet(key, "reconnect", reason);
    }
    if (opened.alert.kind !== "reconnect") return;

    const { alert } = opened;
    const carded = await attachCard(ctx, repos, deps, opened, async (origin) => {
      const connection =
        subject === "google"
          ? null
          : await repos.connections.getForHealthSystem(subject.healthSystemId);
      const url = reconnectUrl(origin, subject, connection?.id ?? null);
      const card = buildReconnectCard({
        kind: kindOf(subject, reason),
        healthSystemName: await displayNameOf(repos, subject),
        reconnectUrl: url,
        reason,
        occurredAt: new Date(alert.opened_at * 1000),
      });
      return { title: card.title, description: card.description, url };
    });
    if (carded) ctx.log.info("alert.opened", { subject: key, reasonCode: reason });
  } catch (error) {
    // Never rethrow: see the module comment. The row may well have landed even
    // when the card did not, which is the outcome that matters.
    ctx.log.error("alert.open_failed", { subject: key, ...errorFields(error) });
  }
}

/**
 * Close the open reconnect alert for a subject and complete its Trello card.
 *
 * Called after every successful token refresh and every successful health system
 * sync, which is what makes the card's "this completes itself" promise true. A
 * subject with nothing open is one SELECT and no writes. A `sync_failing` alert
 * is not this function's to close: see the module comment.
 */
export async function resolveReconnectAlert(
  ctx: Ctx,
  subject: AlertSubject,
  deps: SyncDeps = {},
): Promise<void> {
  const key = subjectKey(subject);
  try {
    const repos = makeRepos(ctx);
    const open = await repos.alerts.getOpen(key);
    if (open?.kind !== "reconnect") return;
    await closeOpenAlert(ctx, repos, deps, key);
  } catch (error) {
    ctx.log.error("alert.resolve_failed", { subject: key, ...errorFields(error) });
  }
}

// ---------------------------------------------------------------------------
// A sync that keeps failing while its connection is still authorised.
// ---------------------------------------------------------------------------

/** Consecutive failed attempts of one pass before the owner is told. */
export const FAILING_AFTER_ATTEMPTS = 3;

/**
 * How long those attempts must span, as well.
 *
 * The count alone can be reached inside one bad quarter of an hour: the
 * four-hourly cron runs a calendar sync sixteen minutes after the hourly one,
 * and the owner pressing "Sync now" three times is three attempts. An hour and
 * a half is past two hourly runs and short of three, so on the hourly schedule
 * the alert opens on the third run that fails and no sooner.
 */
export const FAILING_MIN_SPAN_SECONDS = 90 * 60;

/** Which pass of a subject an outcome is for. `sync_failures.check_name`. */
export type SyncCheck = SyncFailureRow["check_name"];

/**
 * Codes that are not a failing sync. See "Where the line is" in the module
 * comment.
 */
const NOT_COUNTED: ReadonlySet<string> = new Set(["needs_reauth", "not_connected"]);

/** True once a streak is long enough, in attempts and in time, to be told. */
function isPersistent(row: SyncFailureRow, now: number): boolean {
  return (
    row.failures >= FAILING_AFTER_ATTEMPTS && now - row.first_failed_at >= FAILING_MIN_SPAN_SECONDS
  );
}

/** Which page shows a subject's current state. A path with no id in it. */
function statusPageUrl(origin: string, subject: FailingSubject): string {
  // The Overview page lists the runs, which is where a run that stopped shows.
  if (subject === "run") return `${origin}/`;
  return subject === "google" ? `${origin}/calendar` : `${origin}/health-systems`;
}

/** Which formatter flavour a subject is. */
function failingKindOf(subject: FailingSubject): "google" | "health_system" | "portal" | "run" {
  if (subject === "run") return "run";
  if (subject === "google") return "google";
  return subject.portal === true ? "portal" : "health_system";
}

/**
 * One pass of one subject failed: count it, and open the alert once it has
 * failed enough times running.
 *
 * Called once per attempt, where the failure is caught. Idempotent past the
 * threshold in the way `openReconnectAlert` is: one row and one card however
 * long the streak grows, and nothing at all while a reconnect alert is open
 * for the same subject. Never throws.
 */
export async function noteSyncFailure(
  ctx: Ctx,
  subject: FailingSubject,
  check: SyncCheck,
  errorCode: string,
  deps: SyncDeps = {},
): Promise<void> {
  if (NOT_COUNTED.has(errorCode)) return;
  const key = subjectKey(subject);
  try {
    const repos = makeRepos(ctx);
    const streak = await repos.syncFailures.fail(key, check, errorCode);
    ctx.log.warn("alert.sync_failure", {
      subject: key,
      check,
      failures: streak.failures,
      errorCode,
    });
    if (!isPersistent(streak, ctx.now())) return;

    const opened = await repos.alerts.openOrGet(key, "sync_failing", errorCode);
    if (opened.alert.kind !== "sync_failing") {
      // A reconnect card is open for this subject, and reconnecting is the fix.
      ctx.log.debug("alert.already_open", { subject: key });
      return;
    }
    const carded = await attachCard(ctx, repos, deps, opened, async (origin) => {
      const url = statusPageUrl(origin, subject);
      const card = buildSyncFailingCard({
        kind: failingKindOf(subject),
        healthSystemName: await displayNameOf(repos, subject),
        check,
        errorCode,
        failures: streak.failures,
        failingSince: new Date(streak.first_failed_at * 1000),
        pageUrl: url,
      });
      return { title: card.title, description: card.description, url };
    });
    if (carded) ctx.log.info("alert.opened", { subject: key, reasonCode: errorCode });
  } catch (error) {
    ctx.log.error("alert.open_failed", { subject: key, ...errorFields(error) });
  }
}

/**
 * One pass of one subject worked: end its streak, and close the subject's
 * `sync_failing` alert unless another of its passes is still failing.
 *
 * Called after every pass that works. With nothing failing that is one DELETE
 * that matches nothing and one SELECT. Never throws.
 */
export async function noteSyncOk(
  ctx: Ctx,
  subject: FailingSubject,
  check: SyncCheck,
  deps: SyncDeps = {},
): Promise<void> {
  const key = subjectKey(subject);
  try {
    const repos = makeRepos(ctx);
    await repos.syncFailures.clear(key, check);
    const open = await repos.alerts.getOpen(key);
    if (open?.kind !== "sync_failing") return;
    const rest = await repos.syncFailures.listForSubject(key);
    if (rest.some((row) => isPersistent(row, ctx.now()))) return;
    await closeOpenAlert(ctx, repos, deps, key);
  } catch (error) {
    ctx.log.error("alert.resolve_failed", { subject: key, ...errorFields(error) });
  }
}

/**
 * A whole run is over: say whether it stopped before finishing.
 *
 * Every failure a run meets inside one subject's pass is caught there and
 * counted against that subject. What is left is the run itself throwing --
 * settings that will not parse, a database error while listing what to sync --
 * which `record` catches and puts on the summary with no health system id.
 * Nothing above would ever count that, and it stops every subject at once, so
 * it has a subject of its own.
 *
 * `errors` is the run summary's list. Never throws.
 */
export async function noteRunOutcome(
  ctx: Ctx,
  check: SyncCheck,
  errors: readonly { healthSystemId: string; code: string }[],
  deps: SyncDeps = {},
): Promise<void> {
  const stopped = errors.find((error) => error.healthSystemId === "");
  if (stopped === undefined) await noteSyncOk(ctx, "run", check, deps);
  else await noteSyncFailure(ctx, "run", check, stopped.code, deps);
}

/**
 * A subject is no longer synced at all (switched off, disconnected): forget its
 * streaks and close its `sync_failing` alert, which nothing would ever resolve.
 */
async function dropSyncFailing(ctx: Ctx, subject: AlertSubject, deps: SyncDeps): Promise<void> {
  const key = subjectKey(subject);
  try {
    const repos = makeRepos(ctx);
    await repos.syncFailures.clearSubject(key);
    const open = await repos.alerts.getOpen(key);
    if (open?.kind !== "sync_failing") return;
    await closeOpenAlert(ctx, repos, deps, key);
  } catch (error) {
    ctx.log.error("alert.resolve_failed", { subject: key, ...errorFields(error) });
  }
}

/** The reason a reconnect alert opened by the sweep is given when the row has none. */
const SWEEP_REASON = "needs_reauth";

/**
 * Make sure everything that is waiting for the owner has its alert, and that
 * nothing switched off still has one for failing.
 *
 * The scheduled sync stops trying a connection or a portal account the moment
 * it is marked `needs_reauth`, so the code that marks it is the only code that
 * ever reports it -- once. If the card could not be created just then (Trello
 * was down), or the failure was one that deliberately waits (a first missed
 * verification code), or the account was already parked before alerts covered
 * its failure, nothing would ever raise it again. This is what does: it runs
 * after every scheduled sync and asks, for each thing in that state, for its
 * alert. `openReconnectAlert` is idempotent, so a subject that already has its
 * row and card costs one SELECT.
 *
 * Never throws.
 */
export async function sweepReconnectAlerts(ctx: Ctx, deps: SyncDeps = {}): Promise<void> {
  try {
    const repos = makeRepos(ctx);
    const healthSystems = await repos.healthSystems.list();
    for (const healthSystem of healthSystems) {
      const healthSystemId = healthSystem.id;
      const connection = await repos.connections.getForHealthSystem(healthSystemId);
      const config = await repos.healthSystems.getConfig(healthSystemId);
      const status = connection?.status ?? "disconnected";
      if (status === "disconnected" || !config.enabled) {
        await dropSyncFailing(ctx, { healthSystemId }, deps);
      } else if (status === "needs_reauth") {
        const reason = connection?.last_error_code ?? SWEEP_REASON;
        await openReconnectAlert(ctx, { healthSystemId }, reason, deps);
      }

      const portal = await repos.portalAccounts.get(healthSystemId);
      if (portal?.session_state === "needs_reauth") {
        const reason = portal.last_error_code ?? SWEEP_REASON;
        await openReconnectAlert(ctx, { healthSystemId, portal: true }, reason, deps);
      } else if (portal !== null && portal.session_state !== "active") {
        await dropSyncFailing(ctx, { healthSystemId, portal: true }, deps);
      }
    }
    const google = await repos.google.get();
    if (google.status === "needs_reauth") {
      await openReconnectAlert(ctx, "google", SWEEP_REASON, deps);
    } else if (google.status === "disconnected") {
      await dropSyncFailing(ctx, "google", deps);
    }
  } catch (error) {
    ctx.log.error("alert.sweep_failed", errorFields(error));
  }
}

// ---------------------------------------------------------------------------
// A phone whose uploads were set aside (worker/src/hc/apply.ts). The same two
// guarantees as above, for the same reasons: nothing here throws into the
// apply, and the row is the truth while the card is a convenience.
// ---------------------------------------------------------------------------

/** What the card calls a phone whose row has gone by the time the card is built. */
const UNNAMED_DEVICE = "a phone";

/**
 * Open (or re-find) the alert for a device with uploads set aside, and make
 * sure a Trello card tracks it.
 *
 * One alert per device, however many batches are parked: called for every
 * batch that is set aside, it creates one row and one card, and an alert that
 * is already open with its card is left exactly as it is. The card carries the
 * count and the error code as they were when it was opened; the Phone page has
 * the current ones.
 */
export async function openParkedAlert(
  ctx: Ctx,
  deviceId: string,
  errorCode: string,
  deps: SyncDeps = {},
): Promise<void> {
  const key = deviceSubject(deviceId);
  try {
    const repos = makeRepos(ctx);
    const { alert, created } = await repos.alerts.openOrGet(key, "hc_parked", errorCode);
    if (!created && alert.trello_card_id !== null) {
      ctx.log.debug("alert.already_open", { subject: key });
      return;
    }
    const resolved = resolveDeps(deps);
    const trello = trelloFor(ctx, resolved.trelloFetch);
    if (trello === null) return;

    const device = await repos.devices.get(deviceId);
    const parked = await repos.hcIngestQueue.parked(deviceId);
    // The path only: a URL that named the device would put its id in Trello.
    const url = `${resolved.origin ?? DEFAULT_PUBLIC_ORIGIN}/phone`;
    const card = buildParkedCard({
      deviceName: device?.name ?? UNNAMED_DEVICE,
      phoneUrl: url,
      batches: Math.max(1, parked.batches),
      errorCodes: [errorCode],
      occurredAt: new Date(alert.opened_at * 1000),
    });
    const { cardId } = await trello.openReconnectCard({
      title: card.title,
      description: card.description,
      url,
    });
    await repos.alerts.setCard(alert.id, cardId);
    ctx.log.info("alert.opened", { subject: key, reasonCode: errorCode });
  } catch (error) {
    // Never rethrow: an apply that failed because the alert about a parked
    // batch failed would turn one batch's problem into the whole queue's.
    ctx.log.error("alert.open_failed", { subject: key, ...errorFields(error) });
  }
}

/**
 * Close a device's alert and complete its card, once it has nothing set aside
 * any more: its parked batches were queued again and applied, or it was wiped.
 * Called after every applied batch; with no alert open that is one SELECT.
 */
export async function resolveParkedAlert(
  ctx: Ctx,
  deviceId: string,
  deps: SyncDeps = {},
): Promise<void> {
  const key = deviceSubject(deviceId);
  try {
    const repos = makeRepos(ctx);
    const open = await repos.alerts.getOpen(key);
    if (open === null) return;
    const parked = await repos.hcIngestQueue.parked(deviceId);
    if (parked.batches > 0) return;
    const resolved = await repos.alerts.resolve(key);
    const cardId = resolved?.trello_card_id ?? null;
    if (cardId === null) return;
    const trello = trelloFor(ctx, resolveDeps(deps).trelloFetch);
    if (trello === null) return;
    await trello.completeCard(cardId);
    ctx.log.info("alert.card_completed", { subject: key });
  } catch (error) {
    ctx.log.error("alert.resolve_failed", { subject: key, ...errorFields(error) });
  }
}
