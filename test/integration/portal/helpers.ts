// Scaffolding for the patient-portal integration tests: a fake `PortalAdapter`,
// and the seeding a portal account needs.
//
// ### Why a fake adapter rather than stubbed HTTP
//
// The portal is a scrape, and `test/unit/providers/mychart/**` already drives the
// real client against synthetic HTML -- that is where "does the login POST echo the
// antiforgery token" belongs. What these suites are about is everything *around*
// it: the session state machine, the attempt budget, the emailed-code handoff
// through `mail_inbox`, and the calendar diff. Stubbing at the adapter boundary is
// what keeps those tests about those things instead of about markup.
//
// Nothing here names a real host, organisation, person or timezone. Hosts are
// `*.example.test` (reserved by RFC 6761), names are invented, and the visits are
// numbers around invented places.

import { makeRepos } from "../../../worker/db/index.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import type { Ctx } from "../../../worker/db/client.ts";
import type {
  PortalAdapter,
  PortalAdapterDeps,
  PortalClient,
  PortalVisit,
  PortalVisitStatus,
} from "../../../worker/providers/mychart/index.ts";

/** An invented portal host. Never a real one. */
export const PORTAL_ORIGIN = "https://portal.example.test";
export const PORTAL_MOUNT = "/MyChart/";
export const PORTAL_USERNAME = "portal-user";
export const PORTAL_PASSWORD = "portal-password";

/**
 * The domain the invented portal's verification codes arrive from.
 *
 * `seedPortalAccount` stores it as the account's expected OTP sender and
 * `seedOtp` sends from it, because a claim is bound to a sender now: a code from
 * anywhere else is not eligible for this health system. A test that wants the
 * *unbound* path (a first-ever sign-in, where the allowlist stands in and the
 * sender is then learned) passes `otpSenderDomain: null`.
 */
export const OTP_SENDER_DOMAIN = "mail.example.test";
const OTP_SENDER = `no-reply@${OTP_SENDER_DOMAIN}`;

/** What the fake portal will do, and what it recorded. All of it mutable. */
export interface FakePortal {
  adapter: PortalAdapter;
  /** Visits `loadUpcoming` answers with. Assign to change what the portal reports. */
  visits: PortalVisit[];
  /** What `isSessionAlive` answers. A sign-in sets it true. */
  alive: boolean;
  /** What `login` resolves with, when it does not throw. */
  loginStatus: "signed_in" | "awaiting_code";
  /** Thrown by `login` instead of resolving. */
  loginError: AppError | null;
  /** Thrown by `loadUpcoming` instead of resolving. */
  loadError: AppError | null;
  calls: {
    logins: number;
    sendCodes: number;
    validates: number;
    loadUpcoming: number;
    sessionChecks: number;
  };
  /** Codes handed to `validate`, so a test can prove which one was submitted. */
  submitted: string[];
  /**
   * The deps every `adapter.client(...)` call received, oldest first.
   *
   * What proves `openPortalSession` builds and passes `custom` -- the sign-in
   * path opens a fresh client on more than one occasion in a single run, so this
   * is a log, not a single slot.
   */
  clientDeps: PortalAdapterDeps[];
}

/**
 * A `PortalAdapter` whose client answers from a mutable script.
 *
 * `discover` throws: discovery is exercised against the real adapter and synthetic
 * HTML in `test/integration/api/portal.test.ts`, and a fake that silently answered
 * it would make a broken discovery path look tested.
 */
export function fakePortal(overrides: Partial<FakePortal> = {}): FakePortal {
  const state: FakePortal = {
    adapter: {
      portal: "mychart",
      discover: () => {
        throw new AppError("portal_parse_failed", "the fake adapter does not discover");
      },
      client: (_endpoint, jar, deps) => {
        state.clientDeps.push(deps);
        return client(jar);
      },
    },
    visits: [],
    alive: true,
    loginStatus: "awaiting_code",
    loginError: null,
    loadError: null,
    calls: { logins: 0, sendCodes: 0, validates: 0, loadUpcoming: 0, sessionChecks: 0 },
    submitted: [],
    clientDeps: [],
    ...overrides,
  };

  function client(jar: PortalClient["jar"]): PortalClient {
    return {
      jar,
      login: () => {
        state.calls.logins += 1;
        if (state.loginError !== null) throw state.loginError;
        // A password that is enough is a live session; a code still to come is not.
        if (state.loginStatus === "signed_in") state.alive = true;
        return Promise.resolve(state.loginStatus);
      },
      secondaryValidation: {
        sendCode: () => {
          state.calls.sendCodes += 1;
          return Promise.resolve();
        },
        validate: (code: string) => {
          state.calls.validates += 1;
          state.submitted.push(code);
          state.alive = true;
          return Promise.resolve();
        },
      },
      loadUpcoming: () => {
        state.calls.loadUpcoming += 1;
        if (state.loadError !== null) throw state.loadError;
        return Promise.resolve([...state.visits]);
      },
      // Not what the calendar sync reads -- the portal is the source for upcoming
      // visits only, and FHIR is the source for history -- so the fake answers with
      // nothing rather than pretending to page through a past it has no fixture for.
      loadPast: () => Promise.resolve([]),
      isSessionAlive: () => {
        state.calls.sessionChecks += 1;
        return Promise.resolve(state.alive);
      },
    };
  }

  return state;
}

/** One upcoming visit. Everything optional has an invented default. */
export function portalVisit(overrides: Partial<PortalVisit> & { csn: string }): PortalVisit {
  return {
    start: "2026-06-20T14:30:00+00:00",
    timeZone: "UTC",
    visitType: "Follow-up",
    practitioner: "A. Example, MD",
    department: "Example Clinic",
    isVideo: false,
    status: "scheduled" satisfies PortalVisitStatus,
    ...overrides,
  };
}

/**
 * A portal account in state `active`, with a stored endpoint, credentials and an
 * (empty but present) cookie jar.
 *
 * The jar matters: `hasSession` and the sign-in path both key off it, and an
 * account with credentials but no jar is a different state.
 */
export async function seedPortalAccount(
  ctx: Ctx,
  healthSystemId: string,
  options: {
    active?: boolean;
    mfaContact?: string;
    apiBasePath?: string;
    /** Null leaves the account with no expected sender at all. */
    otpSenderDomain?: string | null;
  } = {},
): Promise<void> {
  const repos = makeRepos(ctx);
  await repos.portalAccounts.setEndpoint(healthSystemId, {
    baseUrl: PORTAL_ORIGIN,
    mountPath: PORTAL_MOUNT,
    endpoint: {
      baseUrl: PORTAL_ORIGIN,
      mountPath: PORTAL_MOUNT,
      usernameField: "LoginIdentifier",
      antiforgeryFieldName: "__RequestVerificationToken",
      ...(options.apiBasePath !== undefined && { apiBasePath: options.apiBasePath }),
    },
  });
  const otpSenderDomain =
    options.otpSenderDomain === undefined ? OTP_SENDER_DOMAIN : options.otpSenderDomain;
  await repos.portalAccounts.setCredentials(healthSystemId, {
    username: PORTAL_USERNAME,
    password: PORTAL_PASSWORD,
    ...(options.mfaContact !== undefined && { mfaContact: options.mfaContact }),
    ...(otpSenderDomain !== null && { otpSenderDomain }),
  });
  await repos.portalAccounts.saveCookieJar(healthSystemId, JSON.stringify({ v: 1, cookies: [] }));
  if (options.active !== false) await repos.portalAccounts.markActive(healthSystemId);
}

/**
 * An unconsumed verification code in the inbox.
 *
 * `receivedAt` defaults to a minute ahead of the clock, because `takeFreshOtp`
 * only claims a code that arrived strictly after the `SendCode` call -- a code from
 * before it belongs to an earlier attempt, and submitting it would fail and burn
 * this one too. A minute rather than a second so a suite running against the real
 * wall clock (rather than a frozen one) cannot spend that second on the requests
 * between seeding the code and asking for one.
 *
 * `fromAddr` defaults to `OTP_SENDER`, which is what `seedPortalAccount` stores
 * as the account's expected sender: a code from anywhere else is deliberately
 * not eligible for that health system.
 */
export async function seedOtp(
  ctx: Ctx,
  code: string,
  options: { receivedAt?: number; expiresAt?: number; fromAddr?: string } = {},
): Promise<void> {
  await makeRepos(ctx).mailInbox.insert({
    fromAddr: options.fromAddr ?? OTP_SENDER,
    subject: "Your verification code",
    kind: "otp",
    code,
    url: null,
    receivedAt: options.receivedAt ?? ctx.now() + 60,
    expiresAt: options.expiresAt ?? ctx.now() + 600,
    rawSize: 512,
  });
}

/** Spend `count` sign-in attempts, so the budget check has something to refuse. */
export async function spendAttempts(
  ctx: Ctx,
  healthSystemId: string,
  count: number,
): Promise<void> {
  const repos = makeRepos(ctx);
  for (let attempt = 0; attempt < count; attempt += 1) {
    await repos.portalAccounts.recordLoginAttempt(healthSystemId);
  }
}
