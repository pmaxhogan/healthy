/**
 * Re-auth alerts: the D1 row, the Trello card, and the promise that neither can
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
 * and the admin UI still shows the alert.
 *
 * Log lines carry subjects (`provider:<id>`, `portal:<id>`, `google`) and error
 * codes. Never a provider display name -- that names a real health system -- and
 * never a card body, which contains one.
 */

import { buildReconnectCard } from "../alerts/reconnect.ts";
import { createTrelloAlerts } from "../alerts/trello.ts";
import { makeRepos } from "../db/index.ts";
import { GOOGLE_SUBJECT, portalSubject, providerSubject } from "../db/repos/alerts.ts";
import { errorFields } from "../lib/log.ts";

import { DEFAULT_PUBLIC_ORIGIN, resolveDeps } from "./deps.ts";

import type { SyncDeps } from "./deps.ts";
import type { TrelloAlerts } from "../alerts/trello.ts";
import type { Ctx } from "../db/client.ts";

/**
 * Who an alert is about: the Google account, one health system's FHIR connection,
 * or one health system's patient-portal session.
 *
 * The portal is a separate subject from the FHIR connection for the same provider,
 * and that is load-bearing. They break independently and are fixed differently --
 * one is an OAuth reconnect, the other is a password and an emailed code -- so one
 * subject for both would mean a dead portal session silently closing the card
 * about a dead FHIR grant, or the reverse.
 */
export type AlertSubject = "google" | { providerId: string; portal?: true };

/** The label Trello cards use for the calendar account. Not a health system. */
const GOOGLE_PROVIDER_NAME = "Google";

/** `alerts.subject` for a subject. */
function subjectKey(subject: AlertSubject): string {
  if (subject === "google") return GOOGLE_SUBJECT;
  return subject.portal === true
    ? portalSubject(subject.providerId)
    : providerSubject(subject.providerId);
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
 * consent flow. A portal reconnect is neither, and goes to the Providers page.
 * The origin is this app's own public domain, which is not personal data;
 * `deps.origin` overrides it for a local run or a test.
 */
function reconnectUrl(origin: string, subject: AlertSubject, connectionId: string | null): string {
  if (subject === "google") return `${origin}/oauth/google/start`;
  // A portal session is not an OAuth grant: there is no consent screen to send the
  // owner to, only the Providers page, where they re-enter the password and press
  // "Sign in now". The path carries no provider id, because a URL that names one is
  // one lookup away from naming a health system and this one ends up in Trello.
  if (subject.portal === true) return `${origin}/providers`;
  return connectionId === null
    ? `${origin}/oauth/epic/start?provider=${encodeURIComponent(subject.providerId)}`
    : `${origin}/oauth/reconnect/${connectionId}`;
}

/** Which flavour of card a subject wants. */
function kindOf(subject: AlertSubject): "google" | "epic" | "portal" {
  if (subject === "google") return "google";
  return subject.portal === true ? "portal" : "epic";
}

/**
 * Open (or re-find) the alert for a subject, and make sure a Trello card tracks
 * it.
 *
 * Idempotent: called on every failed refresh, it creates one row and one card
 * however many times the connection fails.
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
    const { alert, created } = await repos.alerts.openOrGet(key);
    if (!created && alert.trello_card_id !== null) {
      ctx.log.debug("alert.already_open", { subject: key });
      return;
    }
    const resolved = resolveDeps(deps);
    const trello = trelloFor(ctx, resolved.trelloFetch);
    if (trello === null) return;

    const provider = subject === "google" ? null : await repos.providers.get(subject.providerId);
    const connection =
      subject === "google" ? null : await repos.connections.getForProvider(subject.providerId);
    const providerName =
      subject === "google" ? GOOGLE_PROVIDER_NAME : (provider?.display_name ?? subject.providerId);
    const url = reconnectUrl(
      resolved.origin ?? DEFAULT_PUBLIC_ORIGIN,
      subject,
      connection?.id ?? null,
    );

    const card = buildReconnectCard({
      kind: kindOf(subject),
      providerName,
      reconnectUrl: url,
      reason,
      occurredAt: new Date(alert.opened_at * 1000),
    });
    const { cardId } = await trello.openReconnectCard({
      title: card.title,
      description: card.description,
      url,
    });
    await repos.alerts.setCard(alert.id, cardId);
    ctx.log.info("alert.opened", { subject: key, reasonCode: reason });
  } catch (error) {
    // Never rethrow: see the module comment. The row may well have landed even
    // when the card did not, which is the outcome that matters.
    ctx.log.error("alert.open_failed", { subject: key, ...errorFields(error) });
  }
}

/**
 * Close the open alert for a subject and complete its Trello card.
 *
 * Called after every successful token refresh and every successful provider
 * sync, which is what makes the card's "this completes itself" promise true. A
 * subject with nothing open is one SELECT and no writes.
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
    if (open === null) return;
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
