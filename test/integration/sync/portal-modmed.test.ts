// A ModMed portal through the real portal pass: real D1, the in-memory calendar,
// and the real ModMed client against a synthetic practice and identity provider.
//
// Unlike `portal-sync.test.ts` this injects no adapter: the routing adapter has
// to read `portal: "modmed"` off the stored endpoint and pick the ModMed client
// by itself, which is exactly the wiring that would otherwise go untested.

import { beforeEach, describe, expect, it } from "vitest";

import { makeRepos } from "../../../worker/db/index.ts";
import { TOKEN_EXTRAS } from "../../../worker/ehr/modmed/wire.ts";
import { CookieJar } from "../../../worker/ehr/mychart/index.ts";
import { runCalendarSync } from "../../../worker/sync/calendar-sync.ts";
import {
  ENDPOINT,
  IDENTITY_PAGE,
  OIDC,
  PORTAL,
  REDIRECT_URI,
  SSO,
  USERNAME_PAGE,
  appointmentRow,
  authData,
  found,
  html,
  json,
  router,
  tokenResponse,
  urlOf,
} from "../../unit/ehr/modmed/fixtures.ts";

import {
  T0,
  fhirServer,
  resetSyncDb,
  seedConnectedHealthSystem,
  seedGoogle,
  seedSettings,
  sk,
  stubUpstreams,
  syncCtx,
} from "./helpers.ts";

import type { Ctx } from "../../../worker/db/client.ts";

beforeEach(resetSyncDb);

const HOST = "fhir.modmed.example.test";
const ACTION = `${SSO}/realms/ExampleRealm/login-actions/authenticate`;
const UPCOMING = `${PORTAL}/ema/ws/v3/patientPortal/appointments/upcoming`;

/** A synthetic practice: sign-in document, Keycloak, token endpoint, upcoming list. */
function practice(rows: () => unknown[]) {
  let state = "";
  return router([
    {
      method: "GET",
      match: `${PORTAL}/ema/ws/v3/auth/data/patient`,
      respond: () => json(authData()),
    },
    {
      method: "GET",
      match: `${OIDC}/auth`,
      respond: ({ url }) => {
        state = url.searchParams.get("state") ?? "";
        return html(IDENTITY_PAGE);
      },
    },
    {
      method: "POST",
      match: ACTION,
      respond: ({ url }) =>
        url.searchParams.get("session_code") === "s1"
          ? html(USERNAME_PAGE)
          : found(`${REDIRECT_URI}#state=${state}&code=synthetic-code`),
    },
    { method: "POST", match: `${OIDC}/token`, respond: () => json(tokenResponse()) },
    {
      method: "GET",
      match: UPCOMING,
      respond: ({ init }) => {
        const auth = new Headers(init.headers).get("authorization");
        if (auth !== "Bearer synthetic-access-1") return json({ statusCode: 500 }, {}, 500);
        const all = rows();
        return json(all, { count: String(all.length), pagenumber: "1", pagesize: "50" });
      },
    },
  ]);
}

/** The practice and its identity provider go to `portal`; everything else to the stubs. */
function routed(portal: typeof fetch, fallback: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(urlOf(input));
    return url.origin === PORTAL || url.origin === new URL(SSO).origin
      ? portal(input, init)
      : fallback(input, init);
  };
}

async function seed(ctx: Ctx, healthSystemId: string): Promise<void> {
  const repos = makeRepos(ctx);
  await repos.portalAccounts.setEndpoint(healthSystemId, {
    baseUrl: ENDPOINT.baseUrl,
    mountPath: ENDPOINT.mountPath,
    endpoint: { ...ENDPOINT },
  });
  await repos.portalAccounts.setCredentials(healthSystemId, {
    username: "portal-user",
    password: "portal-password",
  });
  await repos.portalAccounts.markActive(healthSystemId);
}

describe("a ModMed portal on the calendar", () => {
  it("signs in with the password alone, reads the list and calendars it", async () => {
    const ctx = syncCtx();
    const healthSystem = await seedConnectedHealthSystem(ctx, { host: HOST });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seed(ctx, healthSystem.healthSystemId);
    const upstreams = stubUpstreams({ [HOST]: fhirServer({ patientId: healthSystem.patientId }) });
    const portal = practice(() => [
      // Four days after the fixed clock; the clinic is on Mountain time.
      appointmentRow({
        id: 4242,
        appointmentDate: new Date((T0 + 4 * 86_400) * 1000).toISOString().replace("Z", "+0000"),
      }),
    ]);
    const fetchImpl = routed(portal.fetchImpl, upstreams.deps.fetchImpl!);

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, fetchImpl, sleep: () => Promise.resolve() },
    });

    expect(summary.portalErrors).toStrictEqual([]);
    expect(summary.portalVisits).toBe(1);
    expect(summary.eventsInserted).toBe(1);
    const event = upstreams.calendar
      .byKey()
      .get(await sk(`${healthSystem.healthSystemId}:csn:4242`));
    expect(event?.summary).toContain("Skin check");
    expect(event?.location).toContain("Example Clinic North");

    // One sign-in, password to the identity provider only, and the token pair
    // sealed into the account's jar for the next run.
    const credentialPosts = portal.calls.filter((call) =>
      new URLSearchParams(typeof call.init.body === "string" ? call.init.body : "").has("password"),
    );
    expect(credentialPosts).toHaveLength(1);
    expect(credentialPosts[0]?.url.origin).toBe(new URL(SSO).origin);
    const secrets = await makeRepos(ctx).portalAccounts.getSecrets(healthSystem.healthSystemId);
    const jar = CookieJar.deserialise(secrets?.cookieJar ?? "{}", { now: () => T0 });
    expect(jar.getExtra(TOKEN_EXTRAS.accessToken)).toBe("synthetic-access-1");
    const row = await makeRepos(ctx).portalAccounts.get(healthSystem.healthSystemId);
    expect(row?.session_state).toBe("active");

    // The next run reuses the stored token: no second sign-in.
    await runCalendarSync(ctx, {
      trigger: "manual",
      portalOnly: true,
      deps: { ...upstreams.deps, fetchImpl, sleep: () => Promise.resolve() },
    });
    expect(
      portal.calls.filter((call) =>
        new URLSearchParams(typeof call.init.body === "string" ? call.init.body : "").has(
          "password",
        ),
      ),
    ).toHaveLength(1);
  });

  it("calendars a portal-only health system, whose FHIR side never connected", async () => {
    const ctx = syncCtx();
    const healthSystem = await makeRepos(ctx).healthSystems.create({
      vendor: "epic",
      displayName: "Portal Only Example",
      fhirBaseUrl: "https://fhir.portal-only.example.test/r4",
      portalUrl: null,
      environment: "prod",
    });
    await seedGoogle(ctx);
    await seedSettings(ctx);
    await seed(ctx, healthSystem.id);
    const upstreams = stubUpstreams({});
    const portal = practice(() => [
      appointmentRow({
        id: 5151,
        appointmentDate: new Date((T0 + 2 * 86_400) * 1000).toISOString().replace("Z", "+0000"),
      }),
    ]);
    const fetchImpl = routed(portal.fetchImpl, upstreams.deps.fetchImpl!);

    const summary = await runCalendarSync(ctx, {
      trigger: "manual",
      deps: { ...upstreams.deps, fetchImpl, sleep: () => Promise.resolve() },
    });

    expect(summary.healthSystems).toBe(0);
    expect(summary.portalVisits).toBe(1);
    expect(summary.eventsInserted).toBe(1);
    expect(upstreams.calendar.byKey().has(await sk(`${healthSystem.id}:csn:5151`))).toBe(true);
  });
});
