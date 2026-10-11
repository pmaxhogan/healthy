// Synthetic ModMed portal fixtures. Every host, name, address and id here is
// invented; the *shapes* mirror what a signed-in session returned, with every
// value replaced.

import type { ModMedEndpoint } from "../../../../src/ehr/modmed/index.ts";

export const PORTAL = "https://example-practice.example.test";
export const SSO = "https://sso.example.test/auth";
const REALM = "ExampleRealm";
export const CLIENT_ID = "portal-app";
export const OIDC = `${SSO}/realms/${REALM}/protocol/openid-connect`;
export const REDIRECT_URI = `${PORTAL}/patient-portal/?initialLogin`;

export const ENDPOINT: ModMedEndpoint = {
  portal: "modmed",
  baseUrl: PORTAL,
  mountPath: "/patient-portal/",
  flavor: "modmed",
  authServerUrl: SSO,
  realm: REALM,
  clientId: CLIENT_ID,
};

export function authData(overrides: Record<string, unknown> = {}): unknown {
  return {
    applicationEnabled: true,
    ssoEnabled: true,
    keycloakConfig: {
      loginHint: "U1lOVEhFVElDX0hJTlQ9VFJVRQ==",
      clientId: CLIENT_ID,
      tokenConfig: { alwaysRefresh: false, minimumTimeToLive: 0 },
      realm: REALM,
      authServerUrl: SSO,
    },
    stateless: true,
    ...overrides,
  };
}

const ACTION_1 = `${SSO}/realms/${REALM}/login-actions/authenticate?session_code=s1&amp;execution=e1&amp;client_id=${CLIENT_ID}&amp;tab_id=t1`;
const ACTION_2 = `${SSO}/realms/${REALM}/login-actions/authenticate?session_code=s2&amp;execution=e2&amp;client_id=${CLIENT_ID}&amp;tab_id=t2`;

/** The default identity form: name and date of birth, plus "Login with Username". */
export const IDENTITY_PAGE = `<html><body><form id="patient-login-form" action="${ACTION_1}" method="post">
<input id="firm" type="hidden" name="firm" value="example-practice.example.test" />
<input type="text" id="userFirstName" name="userFirstName" />
<input type="text" id="userLastName" name="userLastName" />
<input type="text" id="userDateOfBirth" name="userDateOfBirth" />
<button type="submit" id="login" name="login">Confirm Identity</button>
<button type="submit" name="submitAction" formnovalidate value="loginWithUsername">Login with Username</button>
</form></body></html>`;

/** The username/password form. */
export const USERNAME_PAGE = `<html><body><form id="patient-login-form" action="${ACTION_2}" method="post">
<input id="firm" type="hidden" name="firm" value="example-practice.example.test" />
<input type="text" id="username" name="username" value="" />
<input type="password" id="password" name="password" />
<button type="submit">Log In</button>
</form></body></html>`;

export const BAD_PASSWORD_PAGE = USERNAME_PAGE.replace(
  "<form",
  '<div class="alert">Invalid username or password.</div><form',
);

export const CODE_PAGE = `<html><body><form action="${ACTION_2}" method="post">
<input type="text" id="code" name="code" />
<button type="submit">Verify</button></form></body></html>`;

export const LOCKED_PAGE = `<html><body><p>Your account is temporarily locked.</p></body></html>`;

export function tokenResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "synthetic-access-1",
    expires_in: 900,
    refresh_expires_in: 7200,
    refresh_token: "synthetic-refresh-1",
    token_type: "Bearer",
    scope: "openid profile email",
    ...overrides,
  };
}

/** One upcoming appointment row, shaped like the real list, every value invented. */
export function appointmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: "Skin check",
    timeZone: "US/Pacific",
    physician: {
      lastName: "Example",
      firstName: "Pat",
      isRcmUser: false,
      isFhirUser: false,
      name: "Pat Example, MD",
      fullNameComplete: "Pat Example, MD",
      fullName: "Pat Example",
      id: 501,
      testUser: false,
      suffix: "MD",
      username: "pexample",
    },
    id: 90_001,
    facility: {
      address: {
        zipcode: "00000-0000",
        country: "UNITED_STATES",
        city: "Exampletown",
        addressType: "OFFICE_BUSINESS",
        countryDisplayValue: "United States of America",
        street1: "1 Example Plaza",
        id: 7,
        state: "ZZ",
        fullStreetAddress: "1 Example Plaza",
      },
      visible: true,
      facilityId: 11,
      mainPhone: {
        formattedPhoneNumber: "(555) 010-0000",
        phoneNumber: "5550100000",
        formattedPhoneNumberWithParens: "(555) 010-0000",
        phoneNumberType: "WORK",
        formattedPhoneNumberWithExtension: "(555) 010-0000",
        id: 3,
      },
      primaryFacility: false,
      name: "Example Clinic North",
      timeZone: "US/Mountain",
      facilityPhoneNumbers: [],
      id: 11,
    },
    appointmentDate: "2027-03-10T15:30:00.000+0000",
    ...overrides,
  };
}

export function pastRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    finalized: true,
    visitId: 70_001,
    primaryProvider: "Pat Example, MD",
    attendees: "Pat Example, MD",
    providerId: 501,
    primaryBiller: "Pat Example, MD",
    visitNotePdfUrl: "/synthetic/note",
    additionalAttendees: "",
    visitDate: "2026-02-01T14:00:00.000+0000",
    impressions: "synthetic clinical text that must never be read",
    facility: appointmentRow().facility,
    visitEncryptedId: "synthetic-encrypted-id",
    ...overrides,
  };
}

interface Route {
  method: string;
  /** Absolute URL without query, or a predicate over the full URL. */
  match: string | ((url: URL) => boolean);
  respond: (request: { url: URL; init: RequestInit }) => Response;
}

/** The URL string of whatever `fetch` was handed. */
export function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A tiny router over `fetch`, recording every call. Unmatched calls are a 599. */
export function router(routes: Route[]) {
  const calls: { method: string; url: URL; init: RequestInit }[] = [];
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(urlOf(input));
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url, init });
    const route = routes.find(
      (candidate) =>
        candidate.method === method &&
        (typeof candidate.match === "string"
          ? `${url.origin}${url.pathname}` === candidate.match
          : candidate.match(url)),
    );
    return Promise.resolve(
      route?.respond({ url, init }) ?? new Response("no route", { status: 599 }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

export function found(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

/** An inbox row: a practice reply, read, with one attachment. Every value invented. */
export function inboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cc: [],
    hasFileAttachments: true,
    currentRecipientFlags: {
      messageFlagged: false,
      messageRead: true,
      recipientId: 31,
      messageArchived: false,
    },
    messageBody: "<p>Thanks for writing.</p><p>Your results look <b>normal</b>.</p>",
    subject: "RE: Question about my results",
    authorType: "STAFF",
    isDraft: false,
    fileAttachments: [{ id: 801, fileName: "results-letter.pdf", formattedFileSize: "12 KB" }],
    received: "2026-09-02T15:00:00.000+0000",
    authorId: 77,
    priority: "NORMAL",
    dateCreated: "2026-09-02T14:59:00.000+0000",
    messageLinks: [],
    authorName: "Example Nurse",
    to: [{ firstName: "Test", lastName: "Patient", id: 5, type: "PATIENT" }],
    id: 6001,
    ...overrides,
  };
}

/** A sent row: the owner's own message to a care-team group. */
export function sentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cc: [],
    hasFileAttachments: false,
    messageBody: "Could you explain my results?",
    subject: "Question about my results",
    authorType: "PATIENT",
    isDraft: false,
    fileAttachments: [],
    received: "2026-09-01T12:00:00.000+0000",
    authorId: 5,
    priority: "NORMAL",
    dateCreated: "2026-09-01T12:00:00.000+0000",
    authorName: "Test Patient",
    to: [{ groupName: "Example Clinic Nurses", id: 9, type: "GROUP" }],
    id: 6000,
    ...overrides,
  };
}
