/**
 * Signing in to a patient portal, including the code that arrives by email.
 *
 * The portal is not an API and there is no refresh token: the only way back in
 * once the session cookie dies is the owner's password plus a one-time code the
 * portal emails. That code lands in `mail_inbox` (see `worker/mail/handler.ts`),
 * so signing in means *waiting* -- seconds usually, a couple of minutes
 * occasionally -- and waiting is the whole design problem this module exists to
 * solve twice over.
 *
 * ### Two callers, two ways of waiting, one set of steps
 *
 * The four steps are the same either way: log in, ask for a code, claim the code,
 * submit it. What differs is who does the waiting.
 *
 *   - **Cron** (`portal-sync.ts`, inside the hourly calendar run) uses
 *     `signInAndWait`, which polls with `deps.sleep`. A scheduled invocation has
 *     the wall clock for it, and doing it inline means the visits are synced in
 *     the same run rather than an hour later.
 *   - **The admin button** (`portal-runner.ts`) cannot: it answers a request, and
 *     work handed to `waitUntil` is cancelled about thirty seconds after the
 *     response. So the Durable Object drives the same steps one alarm invocation
 *     at a time -- `startSignIn`, then `claimCode`/`completeSignIn` every ten
 *     seconds -- and no single invocation ever sleeps.
 *
 * Hence the shape of this file: small steps that both drivers compose, and the
 * bookkeeping (the attempt counter, the cookie jar, `markActive`,
 * `markNeedsReauth`, the Trello card) written once, here, so the two drivers
 * cannot disagree about what a failure means.
 *
 * ### What is deliberately strict
 *
 * **The jar is saved on every exit path**, success or failure. A failed sign-in
 * still leaves cookies worth keeping -- the antiforgery cookie, and sometimes the
 * trust-this-device cookie from a *previous* success that must not be discarded
 * because today's password was mistyped.
 *
 * **Every attempt is counted before it is made.** `recordLoginAttempt` runs
 * before the credentials are sent, so an invocation that dies mid-login still
 * spent its attempt. A portal that locks the account after a handful of failures
 * is a much worse outcome than a sign-in the owner has to ask for again tomorrow.
 *
 * **A code is claimed, not read.** `takeFreshOtp` consumes it in the same
 * statement, so two drivers racing (a manual sign-in during the hourly run)
 * cannot both submit the same code -- the second finds nothing and waits for the
 * next email, which is the correct behaviour rather than a mysterious rejection.
 *
 * **A claim is bound to the provider that asked for the code.** `claimCode`
 * passes the account's expected sender domain, and only that sender's rows are
 * eligible; where there is none yet, the sender allowlist stands in and the
 * sender of the code the portal accepts is stored as the expected one. Without
 * that, anyone who can reach the inbound mail address could have a code of
 * their own choosing POSTed to the owner's real health-system account.
 *
 * Log lines carry the provider id, the phase, stable codes and counts. Never a
 * username, never the code, never a byte of portal markup.
 */

import { isHttpsUrl } from "@shared/url.ts";

import { makeRepos } from "../db/index.ts";
import { getSetting } from "../db/settings.ts";
import { AppError, isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";
import { parseAllowlistCsv } from "../mail/classify.ts";
import { CookieJar, createMyChartAdapter } from "../providers/mychart/index.ts";

import { openReconnectAlert } from "./alerts.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { ClaimedOtp } from "../db/repos/mail-inbox.ts";
import type {
  PortalClient,
  PortalCustomSettings,
  PortalEndpoint,
} from "../providers/mychart/index.ts";
import type { PortalSignInPhase } from "@shared/types.ts";

/** How long to wait for the emailed code before giving up. */
export const OTP_WAIT_SECONDS = 240;

/** How often to look for it. Ten seconds; the alarm interval matches. */
export const OTP_POLL_SECONDS = 10;

/** Everything the portal pass needs from the outside world. */
export interface PortalDeps {
  fetchImpl: typeof fetch;
  /** Only the sleep-based driver uses it. The alarm driver never sleeps. */
  sleep: (ms: number) => Promise<void>;
  /** Forwarded to the alert path, which must not reach the portal's stub. */
  deps: SyncDeps;
}

/** The deps a portal call needs, resolved from `SyncDeps`. */
export function portalDeps(deps: SyncDeps = {}): PortalDeps {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    deps,
  };
}

/** A client pointed at one provider's portal, plus the way to persist its jar. */
export interface PortalSession {
  client: PortalClient;
  /** Seal whatever the jar holds now. Called on every exit path. */
  persistJar(): Promise<void>;
}

/** How a sign-in ended. Never thrown: both drivers report rather than propagate. */
export interface SignInOutcome {
  phase: PortalSignInPhase;
  /** The stable failure code, or null when the sign-in worked. */
  code: string | null;
}

const OK: SignInOutcome = { phase: "signed_in", code: null };

/**
 * Codes that mean "stop, and tell the owner" rather than "try again later".
 *
 * A bot block or a locked account is not going to resolve itself, and the next
 * hourly run retrying it is how a temporary block becomes a permanent one. These
 * two open the Trello reconnect card; every other failure marks the account and
 * waits for the owner to look at the admin UI.
 */
const ALERTING_CODES: ReadonlySet<string> = new Set([
  "portal_bot_blocked",
  "portal_locked",
  // Not a portal failure at all, but the one state the owner has to be told about
  // out of band: the sync has given up for the day and will not try again until
  // the counter rolls over, so nothing else would surface it before tomorrow.
  "portal_attempts_exhausted",
]);

/** A stable code for any thrown value. */
function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : "internal";
}

/**
 * Open a client for one provider's portal.
 *
 * Throws `conflict` when the account is not ready -- no endpoint discovered, or
 * no credentials stored. That is a state the admin UI can fix and is not a portal
 * failure, so it is deliberately not one of the `portal_*` codes.
 */
export async function openPortalSession(
  ctx: Ctx,
  providerId: string,
  deps: PortalDeps,
): Promise<{ session: PortalSession; credentials: { username: string; password: string } }> {
  const repos = makeRepos(ctx);
  const row = await repos.portalAccounts.get(providerId);
  if (row === null) throw new AppError("conflict", "this provider has no portal account");
  if (row.base_url === null || row.mount_path === null) {
    throw new AppError("conflict", "the portal endpoint is not known yet", { providerId });
  }
  // Fail closed rather than sign in over cleartext. `base_url` is what
  // `fallbackEndpoint` builds from and what every mounted URL is joined onto, so
  // a row that predates the https checks (or one written by hand) stops here
  // instead of carrying the owner's password to an `http://` origin.
  if (!isHttpsUrl(row.base_url)) {
    throw new AppError(
      "portal_discovery_failed",
      "the stored portal origin is not https; re-save the portal login",
      { providerId },
    );
  }
  const secrets = await repos.portalAccounts.getSecrets(providerId);
  const username = secrets?.username ?? null;
  const password = secrets?.password ?? null;
  if (username === null || password === null) {
    throw new AppError("conflict", "no portal credentials are stored", { providerId });
  }

  const serialisedJar = secrets?.cookieJar ?? null;
  const jar =
    serialisedJar === null
      ? new CookieJar({ now: ctx.now })
      : CookieJar.deserialise(serialisedJar, { now: ctx.now });
  const adapter = deps.deps.portalAdapter ?? createMyChartAdapter();
  const stored = await repos.portalAccounts.getEndpoint(providerId);
  // The adapter's own discovery result, passed back unread where there is one. It
  // carries more than the two columns -- which login strategy this deployment
  // needs, for one -- and nothing outside `worker/providers/mychart/**` has any
  // business knowing what.
  const endpoint =
    stored === null
      ? fallbackEndpoint(row.base_url, row.mount_path)
      : (stored as unknown as PortalEndpoint);
  // The two values a `custom_oidc` deployment may need and the endpoint alone
  // cannot always supply -- see `PortalAdapterDeps.custom`'s own comment in
  // `worker/providers/mychart/index.ts`. Built here, not in the adapter, because
  // both live outside `worker/providers/mychart/**`: one is a stored setting, the
  // other a sealed column. Harmless to build unconditionally -- the classic
  // client ignores it entirely.
  const shellApiBasePath = await getSetting(ctx, "portal_api_base_path");
  const custom: PortalCustomSettings = {
    apiBasePath: endpoint.apiBasePath ?? shellApiBasePath ?? undefined,
    mfaContact: secrets?.mfaContact ?? undefined,
  };
  const client = adapter.client(endpoint, jar, {
    fetchImpl: deps.fetchImpl,
    logger: ctx.log,
    now: ctx.now,
    custom,
  });

  return {
    session: {
      client,
      persistJar: async () => {
        await repos.portalAccounts.saveCookieJar(providerId, client.jar.serialise());
      },
    },
    credentials: { username, password },
  };
}

/**
 * An endpoint for a row whose discovery result predates `endpoint_json`.
 *
 * The two field names are seeds rather than facts: the client reads both out of
 * the live login page and falls back to these only when the page looks like
 * neither known shape. Anything else the adapter would have discovered takes its
 * own default, which is what re-running discovery from the admin UI fixes. The
 * cast is the same deliberate opacity as above -- this module must not have to be
 * edited every time the adapter learns something new about a deployment.
 */
function fallbackEndpoint(baseUrl: string, mountPath: string): PortalEndpoint {
  return {
    baseUrl,
    mountPath,
    usernameField: "LoginIdentifier",
    antiforgeryFieldName: "__RequestVerificationToken",
  } as unknown as PortalEndpoint;
}

/**
 * Sign-in attempts this account has left today.
 *
 * The cap is the `portal_login_attempt_limit` setting (default three), not a
 * constant: it is a safety limit against the portal's own lockout, and the one
 * time it legitimately moves is live QA against a real portal. The counter itself
 * resets by comparing UTC days, so nothing has to clear it -- see
 * `portal-accounts.ts`.
 */
export async function attemptsLeft(ctx: Ctx, providerId: string): Promise<number> {
  const limit = await getSetting(ctx, "portal_login_attempt_limit");
  const used = await makeRepos(ctx).portalAccounts.countLoginAttemptsToday(providerId);
  return Math.max(limit - used, 0);
}

/**
 * Record the failure: the account's state, and the Trello card when it warrants one.
 *
 * Never throws. A failure to write the failure must not turn into a second,
 * different failure for the caller to interpret.
 */
export async function failSignIn(
  ctx: Ctx,
  providerId: string,
  code: string,
  deps: PortalDeps,
): Promise<SignInOutcome> {
  try {
    const repos = makeRepos(ctx);
    await repos.portalAccounts.markNeedsReauth(providerId, code);
    if (ALERTING_CODES.has(code)) {
      await openReconnectAlert(ctx, { providerId, portal: true }, code, deps.deps);
    }
  } catch (error) {
    ctx.log.error("portal.fail_record_failed", { providerId, ...errorFields(error) });
  }
  return { phase: "failed", code };
}

/**
 * Step one: spend an attempt, send the password, and ask for a code if one is wanted.
 *
 * Resolves with the instant `SendCode` was called, which is the floor for the
 * code poll -- a code that arrived *before* it belongs to an earlier attempt and
 * claiming it would submit a stale code and burn this one too. Null means the
 * password was enough and there is nothing to wait for.
 */
export async function startSignIn(
  ctx: Ctx,
  providerId: string,
  session: PortalSession,
  credentials: { username: string; password: string },
): Promise<{ sendCodeAt: number | null }> {
  const repos = makeRepos(ctx);
  // Before the credentials go anywhere: see the module comment.
  const attempt = await repos.portalAccounts.recordLoginAttempt(providerId);
  ctx.log.info("portal.signin.attempt", { providerId, attempt });

  const status = await session.client.login(credentials);
  if (status === "signed_in") return { sendCodeAt: null };

  await session.client.secondaryValidation.sendCode("email");
  const sendCodeAt = ctx.now();
  ctx.log.info("portal.signin.code_requested", { providerId });
  return { sendCodeAt };
}

/**
 * Step two: claim the oldest unconsumed *eligible* code that arrived after
 * `sendCodeAt`.
 *
 * Eligible means "from a sender this provider's codes come from". That binding
 * is the point of this step, and it has two states.
 *
 *   - The account has an expected sender (the owner set it, or an earlier
 *     success learned it): only that domain's rows are eligible, so nobody
 *     else's message can be submitted to this portal, whatever they send or how
 *     often.
 *   - It has none yet: the sender allowlist is the gate, which is exactly the
 *     first-sign-in case the learning step in `completeSignIn` exists to end.
 *
 * Scoped to a provider, not global, so two configured portals cannot claim each
 * other's code either.
 */
export async function claimCode(
  ctx: Ctx,
  providerId: string,
  sendCodeAt: number,
): Promise<ClaimedOtp | null> {
  const repos = makeRepos(ctx);
  const expectedSender = await repos.portalAccounts.getOtpSender(providerId);
  const allowlist = parseAllowlistCsv(await getSetting(ctx, "mail_sender_allowlist"));
  return repos.mailInbox.takeFreshOtp({
    since: sendCodeAt,
    now: ctx.now(),
    expectedSender,
    allowlist,
  });
}

/**
 * Step three: submit the code and mark the session live.
 *
 * `rememberMe` is always true: the cookie it plants is what lets the next
 * scheduled run sign in with no code at all, which is the difference between a
 * sync that runs unattended and one that emails the owner every hour.
 */
export async function completeSignIn(
  ctx: Ctx,
  providerId: string,
  session: PortalSession,
  claimed: ClaimedOtp,
): Promise<void> {
  await session.client.secondaryValidation.validate(claimed.code, true);
  await session.persistJar();
  const repos = makeRepos(ctx);
  await repos.portalAccounts.markActive(providerId);
  // The learning step. The portal itself has just confirmed this code was the
  // one it sent, which makes its sender the authoritative answer to "where do
  // this account's codes come from" -- and from here on the only eligible one.
  // Records nothing when a sender is already stored: see `learnOtpSender`.
  const learned = await repos.portalAccounts.learnOtpSender(providerId, claimed.senderDomain);
  ctx.log.info("portal.signin.done", { providerId, viaCode: true, learnedSender: learned });
}

/**
 * The session was already good, or a password alone was enough.
 *
 * Exported because the alarm driver reaches the same conclusion in its own
 * invocation and must mark it the same way.
 */
export async function markSessionActive(
  ctx: Ctx,
  providerId: string,
  session: PortalSession,
): Promise<SignInOutcome> {
  await session.persistJar();
  await makeRepos(ctx).portalAccounts.markActive(providerId);
  ctx.log.info("portal.signin.done", { providerId, viaCode: false });
  return OK;
}

/**
 * The whole sign-in, waiting for the emailed code inline.
 *
 * For a caller with wall clock to spare -- cron. Never throws: every failure
 * becomes an outcome, the account state and (where it warrants one) a Trello
 * card. The budget check is the caller's, because the caller is the one that has
 * to tell the owner about `portal_attempts_exhausted`.
 */
export async function signInAndWait(
  ctx: Ctx,
  providerId: string,
  deps: PortalDeps,
  waitSeconds = OTP_WAIT_SECONDS,
): Promise<SignInOutcome> {
  let session: PortalSession | null = null;
  try {
    const opened = await openPortalSession(ctx, providerId, deps);
    session = opened.session;
    const { sendCodeAt } = await startSignIn(ctx, providerId, session, opened.credentials);
    if (sendCodeAt === null) return await markSessionActive(ctx, providerId, session);

    // The jar as it stands after `SendCode`: the challenge page's cookies are
    // what the `Validate` POST has to carry, and this is the last chance to keep
    // them if the wait below is cut short by a cancelled invocation.
    await session.persistJar();

    // A counted loop, and the count -- not the clock -- is the bound. A real run
    // sleeps ten seconds per iteration and so waits `waitSeconds`; a test injects
    // a no-op sleep and a frozen clock, where a `while (now < deadline)` would
    // spin for ever.
    const polls = Math.ceil(waitSeconds / OTP_POLL_SECONDS);
    for (let poll = 0; poll < polls; poll += 1) {
      await deps.sleep(OTP_POLL_SECONDS * 1000);
      const claimed = await claimCode(ctx, providerId, sendCodeAt);
      if (claimed === null) continue;
      await completeSignIn(ctx, providerId, session, claimed);
      return OK;
    }
    ctx.log.warn("portal.signin.code_timeout", { providerId, waitSeconds });
    return await failSignIn(ctx, providerId, "portal_2fa_required", deps);
  } catch (error) {
    ctx.log.warn("portal.signin.failed", { providerId, ...errorFields(error) });
    return await failSignIn(ctx, providerId, codeOf(error), deps);
  } finally {
    // Whatever happened: a failed sign-in still leaves cookies worth keeping.
    if (session !== null) await persistQuietly(ctx, providerId, session);
  }
}

/** Saving the jar must never be the thing that fails a sign-in. */
export async function persistQuietly(
  ctx: Ctx,
  providerId: string,
  session: PortalSession,
): Promise<void> {
  try {
    await session.persistJar();
  } catch (error) {
    ctx.log.warn("portal.jar_save_failed", { providerId, ...errorFields(error) });
  }
}
