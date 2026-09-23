/**
 * `/api/providers/:id/portal` -- the patient-portal account for one health system.
 *
 * A separate file from `routes/providers.ts` because it is a separate subsystem:
 * the portal is a scrape with the owner's own login, a cookie jar, a daily attempt
 * budget, its own Durable Object and its own failure vocabulary. It is mounted
 * under `/api/providers` alongside that router; `/:id` and `/:id/portal` are
 * different path shapes, so neither can shadow the other.
 *
 * ### The four behaviours worth reading before changing anything
 *
 * **Discovery happens before anything is written.** `PUT` probes the host for a
 * login page and stores the endpoint the probe settled on, exactly as
 * `POST /api/providers` proves a FHIR base before inserting a row. Sealing a
 * password against a URL that turns out to host no portal produces an account that
 * can never sign in and a reconnect card that can never be cleared. The whole
 * discovery result is stored, opaquely -- it says *how* to sign in to that
 * deployment, not merely where it is.
 *
 * **Discovery is skipped when nothing about the endpoint changed.** Re-saving a
 * password against a portal that is already known must not re-probe: that is
 * several unauthenticated requests to a host with bot protection, for nothing.
 *
 * **The password is write-only, in both directions.** It is sealed by the repo and
 * no response here echoes it, not even as a length. `PortalAccountDto` reports
 * `hasCredentials` and nothing more.
 *
 * **A sign-in is a 202 and a Durable Object, never a `waitUntil`.** The portal
 * emails a verification code; waiting for it takes seconds to minutes, and work in
 * a request's `waitUntil` is cancelled about thirty seconds after the response. So
 * the route queues a job and the SPA polls `GET`'s `signIn` for the phase. The same
 * is true of `POST .../portal/sync`, which may have to re-establish the session
 * before it can read anything.
 *
 * Nothing here logs a username, a password, a portal host or an emailed code.
 * Provider ids, stable codes and counts only.
 */

import { Hono } from "hono";

import { getSetting } from "../../db/settings.ts";
import { AppError, isAppError } from "../../lib/errors.ts";
import { makeLogger } from "../../lib/log.ts";
import { nowSeconds } from "../../lib/time.ts";
import { portalAdapterFor } from "../../providers/mychart/index.ts";
import { closeAlert, portalSubject } from "../close-alert.ts";
import { NO_STORE, apiContext, readJson } from "../http.ts";
import { portalAccountSchema } from "../schemas.ts";

import { isLiveProvider } from "./providers.ts";

import type { AppHonoEnv } from "../../auth/gate.ts";
import type { ProviderRow } from "../../db/rows.ts";
import type { PortalEndpoint } from "../../providers/mychart/index.ts";
import type { ApiContext } from "../http.ts";
import type { PortalAccountDto, PortalAccountStatusDto } from "@shared/types.ts";

/** The only portal vendor today. `worker/providers/mychart/index.ts` holds the map. */
const PORTAL_VENDOR = "mychart";

export const portalRouter = new Hono<AppHonoEnv>();

/** The row for `:id`, or a 404. A soft-deleted provider has no portal either. */
async function requireProvider(api: ApiContext, id: string): Promise<ProviderRow> {
  const row = await api.repos.providers.get(id);
  if (!isLiveProvider(row)) throw new AppError("not_found", "no such provider");
  return row;
}

/**
 * What `GET` answers for a provider that has never had a portal account.
 *
 * Synthesized rather than a 404: the admin UI's portal card is how an account is
 * created in the first place, so it has to be able to render against "there is
 * nothing here yet".
 */
function emptyAccount(providerId: string): PortalAccountDto {
  return {
    providerId,
    baseUrl: null,
    mountPath: null,
    hasCredentials: false,
    hasSession: false,
    hasMfaContact: false,
    hasOtpSender: false,
    state: "none",
    lastLoginAt: null,
    lastOkAt: null,
    lastErrorCode: null,
    needsReauthSince: null,
    loginAttemptsToday: 0,
    updatedAt: null,
  };
}

/**
 * The account, the live sign-in progress, and how many visits it is tracking.
 *
 * `lastVisitCount` is null until the portal has answered at least once, and is
 * otherwise the number of upcoming visits currently on the calendar from this
 * portal -- which is the question the card is really asking ("is this working?"),
 * and is a count of our own rows rather than anything re-fetched.
 */
async function portalStatus(api: ApiContext, providerId: string): Promise<PortalAccountStatusDto> {
  const dto = (await api.repos.portalAccounts.dto(providerId)) ?? emptyAccount(providerId);
  const signIn = await api.ports.portal.signInState(api.ctx, { providerId });
  const lastVisitCount =
    dto.lastOkAt === null
      ? null
      : await api.repos.calendarEvents.countBySource(providerId, "portal", "active");
  return { ...dto, signIn, lastVisitCount };
}

/** A 409 when there is no stored login for a job to use. */
async function requireCredentials(api: ApiContext, providerId: string): Promise<void> {
  const account = await api.repos.portalAccounts.get(providerId);
  if ((account?.username_enc ?? null) === null || (account?.password_enc ?? null) === null) {
    throw new AppError("conflict", "no portal credentials are stored for this provider");
  }
}

/** The origin of a URL, or a 400 naming the field rather than the host. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new AppError("bad_request", "baseUrl is not a URL");
  }
}

/**
 * A mount hint from the path the owner's pasted URL carried, when they did not
 * name one with `mountHint` directly.
 *
 * The owner sometimes pastes the login page itself -- `<origin>/<org>/
 * Authentication/Login` -- rather than the bare host, and that first path
 * segment is exactly the vanity mount discovery's generic candidates
 * (`/MyChart/`, `/`, `/prd/`) cannot guess. `originOf` above keeps only the
 * origin for `base_url`; this is what stops the rest of the path from being
 * silently dropped on the way to `discover()`. Undefined for a bare origin
 * (no path to derive from) or an unparseable URL, in which case discovery
 * falls back to its own generic candidates exactly as it always did.
 */
function mountHintFromPath(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const first = pathname.split("/").find((segment) => segment !== "");
  return first === undefined ? undefined : `/${first}/`;
}

/**
 * Probe for the portal and store what was found.
 *
 * Every failure is reported as one code -- `portal_discovery_failed`, 400 -- with
 * the underlying code in `details.reason`. The admin UI has one thing to say
 * ("that URL does not look like a patient portal") and one place to look for why,
 * and the underlying codes (`portal_parse_failed`, `portal_bot_blocked`,
 * `portal_unreachable`) are about a host the owner typed, which makes them the
 * request's fault however the portal phrased it.
 */
async function discover(
  api: ApiContext,
  providerId: string,
  input: { baseUrl: string; mountHint?: string | undefined },
): Promise<void> {
  const adapter = portalAdapterFor(PORTAL_VENDOR);
  let endpoint: PortalEndpoint;
  try {
    endpoint = await adapter.discover(input, {
      fetchImpl: api.ports.fetch,
      logger: makeLogger({ src: "api.portal" }),
      now: nowSeconds,
    });
  } catch (error) {
    throw new AppError(
      "portal_discovery_failed",
      "no patient-portal login page answered at that URL",
      { reason: isAppError(error) ? error.code : "internal" },
      { cause: error },
    );
  }
  await api.repos.portalAccounts.setEndpoint(providerId, {
    baseUrl: endpoint.baseUrl,
    mountPath: endpoint.mountPath,
    // Stored whole and read back unread: the adapter owns this shape and it says
    // which login strategy this deployment needs, not just where it lives.
    endpoint: { ...endpoint },
  });
}

portalRouter.get("/:id/portal", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  return c.json(await portalStatus(api, row.id), 200, NO_STORE);
});

/**
 * Store (or replace) the portal login.
 *
 * Discovery runs unless the endpoint is already known and `baseUrl` names the same
 * origin -- comparing origins, not the string the owner pasted, because discovery
 * may have followed a vanity host to somewhere else entirely and the stored value
 * is where it landed.
 */
portalRouter.put("/:id/portal", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  const body = await readJson(c, portalAccountSchema);
  const stored = await api.repos.portalAccounts.get(row.id);

  const known = stored?.base_url ?? null;
  if (known === null && body.baseUrl === undefined) {
    throw new AppError("bad_request", "baseUrl is required until the portal has been found once");
  }
  const wanted = body.baseUrl === undefined ? known : originOf(body.baseUrl);
  const unchanged = wanted === known && stored?.endpoint_json !== null;
  if (!unchanged && wanted !== null) {
    // The owner's own `mountHint` wins when given; otherwise the pasted URL's
    // path is the only other place a vanity mount could be named.
    const mountHint =
      body.mountHint ?? (body.baseUrl === undefined ? undefined : mountHintFromPath(body.baseUrl));
    await discover(api, row.id, {
      baseUrl: wanted,
      ...(mountHint !== undefined && { mountHint }),
    });
  }

  // Last, and sealed by the repo: storing credentials also drops any cookie jar and
  // resets the state, which is right -- a new password invalidates the old session.
  await api.repos.portalAccounts.setCredentials(row.id, {
    username: body.username,
    password: body.password,
    ...(body.mfaContact !== undefined && { mfaContact: body.mfaContact }),
    ...(body.otpSenderDomain !== undefined && { otpSenderDomain: body.otpSenderDomain }),
  });
  return c.json(await portalStatus(api, row.id), 200, NO_STORE);
});

/**
 * Start a sign-in. 202: the job outlives this request by minutes.
 *
 * The daily budget is checked here rather than only in the job, because this is
 * where there is somewhere to put the answer: `portal_attempts_exhausted` is a 429,
 * and the admin UI tells the owner to come back tomorrow instead of leaving them
 * pressing a button that silently does nothing.
 */
portalRouter.post("/:id/portal/sign-in", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  await requireCredentials(api, row.id);

  const limit = await getSetting(api.ctx, "portal_login_attempt_limit");
  const used = await api.repos.portalAccounts.countLoginAttemptsToday(row.id);
  if (used >= limit) {
    throw new AppError("portal_attempts_exhausted", "the daily sign-in budget is spent", {
      used,
      limit,
    });
  }

  const { started } = await api.ports.portal.startSignIn(api.ctx, { providerId: row.id });
  return c.json({ accepted: true, started }, 202, NO_STORE);
});

/** Read this portal's upcoming visits now. 202, via the runner -- see the header. */
portalRouter.post("/:id/portal/sync", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  // Refused here rather than in the job: a queued sync with nothing to sign in with
  // fails inside the alarm, which would mark the account `needs_reauth` over a
  // button press that should simply not have been possible.
  await requireCredentials(api, row.id);
  const { started } = await api.ports.portal.startSync(api.ctx, { providerId: row.id });
  return c.json({ accepted: true, started }, 202, NO_STORE);
});

/**
 * Forget the cookie jar, keeping the credentials.
 *
 * The recovery for a session the portal no longer recognises: the next sign-in
 * starts from the password instead of replaying a jar that cannot work. It does
 * *not* free an attempt -- the budget is about how often we may knock.
 */
portalRouter.delete("/:id/portal/session", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  const account = await api.repos.portalAccounts.get(row.id);
  if (account === null) throw new AppError("not_found", "no portal account for this provider");
  await api.repos.portalAccounts.forgetSession(row.id);
  return c.body(null, 204, NO_STORE);
});

/**
 * Remove the portal account: credentials, jar, endpoint and counters.
 *
 * The calendar events the portal wrote are deliberately left alone, exactly as
 * deleting a provider leaves its events: they are the owner's appointments, and
 * removing an account is not a reason to rewrite their week. Any open reconnect
 * card is closed, because there is now nothing to reconnect.
 */
portalRouter.delete("/:id/portal", async (c) => {
  const api = apiContext(c);
  const row = await requireProvider(api, c.req.param("id"));
  await api.repos.portalAccounts.clear(row.id);
  await closeAlert(api, c.env, portalSubject(row.id));
  return c.body(null, 204, NO_STORE);
});
