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
 * **A claim is bound to the health system that asked for the code.** `claimCode`
 * passes the account's expected sender domain, and only that sender's rows are
 * eligible; where there is none yet, the sender allowlist stands in, narrowed to
 * a sender on the same site as this account's own `base_url` -- so a second
 * configured portal's own allowlisted sender is not eligible here -- and the
 * sender of the code the portal accepts is stored as the expected one. Without
 * that, anyone who can reach the inbound mail address, or another configured
 * portal's own sender arriving in the same window, could have a code of their
 * own choosing POSTed to the owner's real health-system account.
 *
 * Log lines carry the health system id, the phase, stable codes and counts. Never a
 * username, never the code, never a byte of portal markup.
 */

import { isHttpsUrl } from "@shared/url.ts";

import { makeRepos } from "../db/index.ts";
import { getSetting } from "../db/settings.ts";
import { CookieJar, createMyChartAdapter } from "../ehr/mychart/index.ts";
import { AppError, isAppError } from "../lib/errors.ts";
import { errorFields } from "../lib/log.ts";
import { parseAllowlistCsv } from "../mail/classify.ts";

import { openReconnectAlert } from "./alerts.ts";

import type { SyncDeps } from "./deps.ts";
import type { Ctx } from "../db/client.ts";
import type { ClaimedOtp } from "../db/repos/mail-inbox.ts";
import type { PortalClient, PortalCustomSettings, PortalEndpoint } from "../ehr/mychart/index.ts";
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
    // Bound, not passed by reference: an unbound `fetch` loses its `this` in
    // workerd, which throws "Illegal invocation" the moment anything calls it
    // as `x.fetchImpl(...)` -- as `worker/health-systems/mychart/http.ts` does. See
    // `worker/api/ports.ts`'s `defaults()`, which has the same fix already.
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    deps,
  };
}

/** A client pointed at one health system's portal, plus the way to persist its jar. */
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
 * waits for the owner to look at the admin UI -- except a *repeated* missing
 * code, see `isRepeatedCodeMiss`.
 */
const ALERTING_CODES: ReadonlySet<string> = new Set([
  "portal_bot_blocked",
  "portal_locked",
  // A script cannot solve a captcha; only the owner signing in once themselves
  // can, so this is the same "stop and tell the owner" shape as a lockout.
  "portal_captcha_required",
  // Not a portal failure at all, but the one state the owner has to be told about
  // out of band: the sync has given up for the day and will not try again until
  // the counter rolls over, so nothing else would surface it before tomorrow.
  "portal_attempts_exhausted",
  // The scheduled sync has stopped signing in on its own for the day. Nothing
  // on the Health systems page is looked at unprompted, so the card is what tells
  // the owner the next sign-in is theirs.
  "portal_signin_needs_owner",
]);

/** The emailed verification code never arrived. */
const CODE_MISS = "portal_2fa_required";

/**
 * The emailed code never arrived, and it did not arrive last time either.
 *
 * One miss is not worth a card: a slow mail hop explains it, and the Health systems
 * page already shows it. Two in a row -- with no successful sign-in between,
 * because `markActive` clears the stored code -- means the forwarding path is
 * broken, and nothing else tells the owner that out of band. The card goes
 * through `openReconnectAlert`, whose one-open-alert-per-subject rule keeps a
 * third and fourth miss from opening more.
 *
 * The scheduled sync only signs in to `active` accounts, so after the first miss
 * the second one normally comes from the owner's own "Sign in now".
 */
function isRepeatedCodeMiss(code: string, previous: string | null): boolean {
  return code === CODE_MISS && previous === CODE_MISS;
}

/** A stable code for any thrown value. */
function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : "internal";
}

/**
 * Open a client for one health system's portal.
 *
 * Throws `conflict` when the account is not ready -- no endpoint discovered, or
 * no credentials stored. That is a state the admin UI can fix and is not a portal
 * failure, so it is deliberately not one of the `portal_*` codes.
 */
export async function openPortalSession(
  ctx: Ctx,
  healthSystemId: string,
  deps: PortalDeps,
): Promise<{ session: PortalSession; credentials: { username: string; password: string } }> {
  const repos = makeRepos(ctx);
  const row = await repos.portalAccounts.get(healthSystemId);
  if (row === null) throw new AppError("conflict", "this health system has no portal account");
  if (row.base_url === null || row.mount_path === null) {
    throw new AppError("conflict", "the portal endpoint is not known yet", { healthSystemId });
  }
  // Fail closed rather than sign in over cleartext. `base_url` is what
  // `fallbackEndpoint` builds from and what every mounted URL is joined onto, so
  // a row that predates the https checks (or one written by hand) stops here
  // instead of carrying the owner's password to an `http://` origin.
  if (!isHttpsUrl(row.base_url)) {
    throw new AppError(
      "portal_discovery_failed",
      "the stored portal origin is not https; re-save the portal login",
      { healthSystemId },
    );
  }
  const secrets = await repos.portalAccounts.getSecrets(healthSystemId);
  const username = secrets?.username ?? null;
  const password = secrets?.password ?? null;
  if (username === null || password === null) {
    throw new AppError("conflict", "no portal credentials are stored", { healthSystemId });
  }

  const serialisedJar = secrets?.cookieJar ?? null;
  const jar =
    serialisedJar === null
      ? new CookieJar({ now: ctx.now })
      : CookieJar.deserialise(serialisedJar, { now: ctx.now });
  const adapter = deps.deps.portalAdapter ?? createMyChartAdapter();
  const stored = await repos.portalAccounts.getEndpoint(healthSystemId);
  // The adapter's own discovery result, passed back unread where there is one. It
  // carries more than the two columns -- which login strategy this deployment
  // needs, for one -- and nothing outside `worker/health-systems/mychart/**` has any
  // business knowing what.
  const endpoint =
    stored === null
      ? fallbackEndpoint(row.base_url, row.mount_path)
      : (stored as unknown as PortalEndpoint);
  // The two values a `custom_oidc` deployment may need and the endpoint alone
  // cannot always supply -- see `PortalAdapterDeps.custom`'s own comment in
  // `worker/health-systems/mychart/index.ts`. Built here, not in the adapter, because
  // both live outside `worker/health-systems/mychart/**`: one is a stored setting, the
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
        await repos.portalAccounts.saveCookieJar(healthSystemId, client.jar.serialise());
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
export async function attemptsLeft(ctx: Ctx, healthSystemId: string): Promise<number> {
  const limit = await getSetting(ctx, "portal_login_attempt_limit");
  const used = await makeRepos(ctx).portalAccounts.countLoginAttemptsToday(healthSystemId);
  return Math.max(limit - used, 0);
}

/**
 * How recently a session must have been proven good for a failed liveness check
 * to be *our* problem rather than the portal's.
 *
 * A portal session does not die ten minutes after it was established. When the
 * liveness check fails that soon, the likeliest explanation is that the session
 * this app thinks it has was never the one the portal serves -- and signing in
 * again would only repeat whatever went wrong, spending one of the day's
 * attempts to do it. So inside this window a dead session is reported as
 * `portal_session_expired` and no sign-in is attempted.
 */
export const RECENT_SESSION_SECONDS = 10 * 60;

/**
 * Seconds since this account's session was last proven good, when that is inside
 * `RECENT_SESSION_SECONDS`; null otherwise.
 *
 * `last_ok_at` is stamped by `markActive`, which runs on a completed sign-in and
 * on every portal pass that read the visits -- both of which are proof.
 */
export async function recentSessionAge(ctx: Ctx, healthSystemId: string): Promise<number | null> {
  const row = await makeRepos(ctx).portalAccounts.get(healthSystemId);
  const lastOk = row?.last_ok_at ?? null;
  if (lastOk === null) return null;
  const age = ctx.now() - lastOk;
  return age >= 0 && age < RECENT_SESSION_SECONDS ? age : null;
}

/**
 * Record the failure: the account's state, and the Trello card when it warrants one.
 *
 * Never throws. A failure to write the failure must not turn into a second,
 * different failure for the caller to interpret.
 */
export async function failSignIn(
  ctx: Ctx,
  healthSystemId: string,
  code: string,
  deps: PortalDeps,
): Promise<SignInOutcome> {
  try {
    const repos = makeRepos(ctx);
    const previous = await repos.portalAccounts.markNeedsReauth(healthSystemId, code);
    if (ALERTING_CODES.has(code) || isRepeatedCodeMiss(code, previous)) {
      await openReconnectAlert(ctx, { healthSystemId, portal: true }, code, deps.deps);
    }
  } catch (error) {
    ctx.log.error("portal.fail_record_failed", { healthSystemId, ...errorFields(error) });
  }
  return { phase: "failed", code };
}

/**
 * Step one: spend an attempt, send the password, and ask for a code if one is wanted.
 *
 * Resolves with the instant `SendCode` was called, which is the floor for the
 * code poll -- a code that arrived *before* it belongs to an earlier attempt and
 * claiming it would submit a stale code and burn this one too. Null means the
 * password was enough and there is nothing to wait for -- unless `withheld`,
 * which means a code *was* wanted and `beforeCode` said not to ask for one.
 *
 * `beforeCode` is the unattended driver's say in the one step that emails the
 * owner: it runs after the password worked and before `SendCode`, and false
 * stops there. Both owner-driven paths leave it out.
 */
export async function startSignIn(
  ctx: Ctx,
  healthSystemId: string,
  session: PortalSession,
  credentials: { username: string; password: string },
  options: { beforeCode?: () => Promise<boolean> } = {},
): Promise<{ sendCodeAt: number | null; withheld: boolean }> {
  const repos = makeRepos(ctx);
  // Before the credentials go anywhere: see the module comment.
  const attempt = await repos.portalAccounts.recordLoginAttempt(healthSystemId);
  ctx.log.info("portal.signin.attempt", { healthSystemId, attempt });

  const status = await session.client.login(credentials);
  if (status === "signed_in") return { sendCodeAt: null, withheld: false };

  if (options.beforeCode !== undefined && !(await options.beforeCode())) {
    ctx.log.info("portal.signin.code_withheld", { healthSystemId });
    return { sendCodeAt: null, withheld: true };
  }
  await session.client.secondaryValidation.sendCode("email");
  const sendCodeAt = ctx.now();
  ctx.log.info("portal.signin.code_requested", { healthSystemId });
  return { sendCodeAt, withheld: false };
}

/**
 * Step two: claim the oldest unconsumed *eligible* code that arrived after
 * `sendCodeAt`.
 *
 * Eligible means "from a sender this health system's codes come from". That binding
 * is the point of this step, and it has two states.
 *
 *   - The account has an expected sender (the owner set it, or an earlier
 *     success learned it): only that domain's rows are eligible, so nobody
 *     else's message can be submitted to this portal, whatever they send or how
 *     often.
 *   - It has none yet: the sender allowlist is the gate, narrowed to a sender on
 *     the same site (registrable domain) as this account's own `base_url` -- so
 *     with two portals configured, the *other* one's own allowlisted sender is
 *     not eligible here even though it is on the shared allowlist too. This is
 *     exactly the first-sign-in case the learning step in `completeSignIn`
 *     exists to end.
 *
 * Scoped to a health system, not global, so two configured portals cannot claim each
 * other's code either.
 */
export async function claimCode(
  ctx: Ctx,
  healthSystemId: string,
  sendCodeAt: number,
): Promise<ClaimedOtp | null> {
  const repos = makeRepos(ctx);
  const expectedSender = await repos.portalAccounts.getOtpSender(healthSystemId);
  const allowlist = parseAllowlistCsv(await getSetting(ctx, "mail_sender_allowlist"));
  // Only consulted by `takeFreshOtp` when there is no expected sender yet.
  // `openPortalSession` refuses to run at all without a `base_url`, so by the
  // time a sign-in is far enough along to be polling for a code this account
  // always has one; null here only for a call outside that guard (a test).
  const account = await repos.portalAccounts.get(healthSystemId);
  const portalHost = hostOf(account?.base_url ?? null);
  return repos.mailInbox.takeFreshOtp({
    since: sendCodeAt,
    now: ctx.now(),
    expectedSender,
    allowlist,
    portalHost,
  });
}

/** The hostname of an origin string, or null when there isn't one to parse. */
function hostOf(baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
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
  healthSystemId: string,
  session: PortalSession,
  claimed: ClaimedOtp,
): Promise<void> {
  await session.client.secondaryValidation.validate(claimed.code, true);
  await session.persistJar();
  const repos = makeRepos(ctx);
  await repos.portalAccounts.markActive(healthSystemId);
  // The learning step. The portal itself has just confirmed this code was the
  // one it sent, which makes its sender the authoritative answer to "where do
  // this account's codes come from" -- and from here on the only eligible one.
  // Records nothing when a sender is already stored: see `learnOtpSender`.
  const learned = await repos.portalAccounts.learnOtpSender(healthSystemId, claimed.senderDomain);
  ctx.log.info("portal.signin.done", { healthSystemId, viaCode: true, learnedSender: learned });
}

/**
 * The session was already good, or a password alone was enough.
 *
 * Exported because the alarm driver reaches the same conclusion in its own
 * invocation and must mark it the same way.
 */
export async function markSessionActive(
  ctx: Ctx,
  healthSystemId: string,
  session: PortalSession,
): Promise<SignInOutcome> {
  await session.persistJar();
  await makeRepos(ctx).portalAccounts.markActive(healthSystemId);
  ctx.log.info("portal.signin.done", { healthSystemId, viaCode: false });
  return OK;
}

/**
 * The whole sign-in, waiting for the emailed code inline.
 *
 * For a caller with wall clock to spare -- cron. Never throws: every failure
 * becomes an outcome, the account state and (where it warrants one) a Trello
 * card. The budget check is the caller's, because the caller is the one that has
 * to tell the owner about `portal_attempts_exhausted`.
 *
 * `unattended` is the scheduled sync. It may still sign in with a password
 * alone or a trusted device, but it has a code emailed only while
 * `unattendedCodeWait` allows one, and counts each one it asks for; past that,
 * the sign-in stops before the email and the account waits for the owner.
 */
export async function signInAndWait(
  ctx: Ctx,
  healthSystemId: string,
  deps: PortalDeps,
  waitSeconds = OTP_WAIT_SECONDS,
  options: { unattended?: boolean } = {},
): Promise<SignInOutcome> {
  let session: PortalSession | null = null;
  try {
    const opened = await openPortalSession(ctx, healthSystemId, deps);
    session = opened.session;
    const accounts = makeRepos(ctx).portalAccounts;
    const beforeCode = async (): Promise<boolean> => {
      const codes = await accounts.unattendedCodes(healthSystemId);
      if (unattendedCodeWait(codes, ctx.now()) !== "allowed") return false;
      await accounts.recordUnattendedCode(healthSystemId);
      return true;
    };
    const { sendCodeAt, withheld } = await startSignIn(
      ctx,
      healthSystemId,
      session,
      opened.credentials,
      options.unattended === true ? { beforeCode } : {},
    );
    if (withheld) return await failSignIn(ctx, healthSystemId, NEEDS_OWNER, deps);
    if (sendCodeAt === null) return await markSessionActive(ctx, healthSystemId, session);

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
      const claimed = await claimCode(ctx, healthSystemId, sendCodeAt);
      if (claimed === null) continue;
      await completeSignIn(ctx, healthSystemId, session, claimed);
      return OK;
    }
    ctx.log.warn("portal.signin.code_timeout", { healthSystemId, waitSeconds });
    return await failSignIn(ctx, healthSystemId, "portal_2fa_required", deps);
  } catch (error) {
    ctx.log.warn("portal.signin.failed", { healthSystemId, ...errorFields(error) });
    return await failSignIn(ctx, healthSystemId, codeOf(error), deps);
  } finally {
    // Whatever happened: a failed sign-in still leaves cookies worth keeping.
    if (session !== null) await persistQuietly(ctx, healthSystemId, session);
  }
}

/**
 * How many emailed codes an unattended sign-in may ask for in one UTC day.
 *
 * The incident this exists for: a portal whose session died every hour emailed
 * the owner a code every hour, and spent the day's whole sign-in budget doing
 * it. Two is enough to recover from one dead session and one retry; after that
 * the account waits for the owner.
 */
export const UNATTENDED_CODES_PER_DAY = 2;

/** The least time between two codes an unattended sign-in asks for. Six hours. */
export const UNATTENDED_CODE_GAP_SECONDS = 6 * 60 * 60;

/**
 * Sign-in attempts the scheduled sync leaves for the owner.
 *
 * The daily budget (`portal_login_attempt_limit`) is shared with "Sign in now",
 * so without a reserve an unattended run can leave the owner unable to retry
 * until tomorrow -- which is what happened. The sync stops signing in on its
 * own once only this many are left.
 */
export const OWNER_RESERVED_ATTEMPTS = 2;

/** The scheduled sync has done what it may on its own; the owner has to act. */
const NEEDS_OWNER = "portal_signin_needs_owner";

/** The scheduled sync is waiting out the spacing between emailed codes. */
export const SIGN_IN_DEFERRED = "portal_signin_deferred";

/**
 * Whether an unattended sign-in may have a code emailed right now.
 *
 * `spent` once today's allowance is used, which only the owner gets past;
 * `wait` inside the spacing after the last one, which ends on its own.
 */
export function unattendedCodeWait(
  codes: { today: number; lastAt: number | null },
  now: number,
): "allowed" | "wait" | "spent" {
  if (codes.today >= UNATTENDED_CODES_PER_DAY) return "spent";
  return codes.lastAt !== null && now - codes.lastAt < UNATTENDED_CODE_GAP_SECONDS
    ? "wait"
    : "allowed";
}

/** Saving the jar must never be the thing that fails a sign-in. */
export async function persistQuietly(
  ctx: Ctx,
  healthSystemId: string,
  session: PortalSession,
): Promise<void> {
  try {
    await session.persistJar();
  } catch (error) {
    ctx.log.warn("portal.jar_save_failed", { healthSystemId, ...errorFields(error) });
  }
}
