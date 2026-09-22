// `/api/google` -- the calendar account, its pickers, and disconnecting it.
//
// The assertion this file exists for: **the owner's address is masked and its
// plaintext never appears in a response.** It is the one string in this deployment
// that names a person, it lives in an encrypted column, and the UI needs just enough
// of it to tell one Google account from another.

import { afterEach, describe, expect, it } from "vitest";

import { freshOwner, json, resetPorts, stubFetch, testRepos, usePorts } from "./helpers.ts";

import type { CalendarClient } from "../../../worker/google/calendar.ts";
import type {
  ApiError,
  CalendarOptionDto,
  ColorOptionDto,
  GoogleAccountDto,
} from "@shared/types.ts";

const EMAIL = "person@example.test";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

/** Connect the account the way the OAuth callback does. */
async function connectGoogle(): Promise<void> {
  const repos = testRepos();
  await repos.google.upsertTokens({
    email: EMAIL,
    accessToken: "google-access-token",
    accessExpiresAt: 1_767_229_200,
    refreshToken: "google-refresh-token",
    scope: "https://www.googleapis.com/auth/calendar.events.owned",
    status: "connected",
  });
  await repos.google.markConnected();
}

/** A calendar client that answers from memory. */
function stubCalendar(): CalendarClient {
  return {
    listCalendars: () =>
      Promise.resolve([
        {
          id: EMAIL,
          summary: EMAIL,
          primary: true,
          timeZone: "America/New_York",
          backgroundColor: "#9fe1e7",
        },
        {
          id: "other@group.calendar.google.com",
          summary: "Healthy Test",
          primary: false,
          timeZone: "",
          backgroundColor: null,
        },
      ]),
    getColors: () =>
      Promise.resolve([
        { id: "1", background: "#a4bdfc", foreground: "#1d1d1d" },
        { id: "8", background: "#e1e1e1", foreground: "#1d1d1d" },
      ]),
    listSyncedEvents: () => Promise.resolve([]),
    getEvent: () => Promise.resolve(null),
    insertEvent: () => Promise.reject(new Error("not used")),
    patchEvent: () => Promise.resolve(null),
    deleteEvent: () => Promise.resolve(true),
  };
}

function withCalendar(calendar: CalendarClient): void {
  usePorts({
    sync: {
      runCalendarSync: () => Promise.resolve({}),
      runFullRefresh: () => Promise.resolve({}),
      refreshConnectionToken: () => Promise.resolve({}),
      getGoogleCalendarFor: () => Promise.resolve(calendar),
      resolveReconnectAlert: () => Promise.resolve(),
    },
  });
}

describe("GET /api/google", () => {
  it("reports not_connected before the owner has ever consented", async () => {
    const dto = await json<GoogleAccountDto>(await owner().get("/api/google"));

    expect(dto.status).toBe("not_connected");
    expect(dto.accountLabel).toBeNull();
    expect(dto.connectedAt).toBeNull();
    expect(dto.calendarId).toBe("primary");
  });

  it("masks the account label and never returns the address", async () => {
    await connectGoogle();

    const response = await owner().get("/api/google");
    const body = await response.text();
    const dto = JSON.parse(body) as GoogleAccountDto;

    expect(dto.status).toBe("connected");
    expect(dto.accountLabel).toBe("p…n@example.test");
    expect(body).not.toContain(EMAIL);
    expect(body).not.toContain("google-access-token");
    expect(body).not.toContain("google-refresh-token");
    expect(body).not.toMatch(/[a-z]_enc/);
  });

  it("distinguishes a deliberate disconnect from never having connected", async () => {
    await connectGoogle();
    await testRepos().google.disconnect();

    // The row keeps its history, so the status is `disconnected`, not
    // `not_connected` -- the UI shows those differently.
    const dto = await json<GoogleAccountDto>(await owner().get("/api/google"));
    expect(dto.status).toBe("disconnected");
  });

  it("reflects the configured calendar id", async () => {
    await owner().send("PUT", "/api/settings", { calendarId: "work@group.calendar.google.com" });

    const dto = await json<GoogleAccountDto>(await owner().get("/api/google"));
    expect(dto.calendarId).toBe("work@group.calendar.google.com");
  });
});

describe("GET /api/google/calendars and /colors", () => {
  it("lists the owned calendars, normalising an absent time zone to null", async () => {
    await connectGoogle();
    withCalendar(stubCalendar());

    const calendars = await json<CalendarOptionDto[]>(await owner().get("/api/google/calendars"));

    expect(calendars).toHaveLength(2);
    expect(calendars[0]?.primary).toBe(true);
    expect(calendars[0]?.timeZone).toBe("America/New_York");
    expect(calendars[1]?.timeZone).toBeNull();
  });

  it("lists the live colour palette", async () => {
    await connectGoogle();
    withCalendar(stubCalendar());

    const colors = await json<ColorOptionDto[]>(await owner().get("/api/google/colors"));

    expect(colors.map((color) => color.id)).toStrictEqual(["1", "8"]);
    expect(colors[0]?.background).toBe("#a4bdfc");
  });

  it("answers 409 rather than a 502 when Google is not connected", async () => {
    withCalendar(stubCalendar());

    const response = await owner().get("/api/google/calendars");

    const body = await json<ApiError>(response);
    expect(response.status).toBe(409);
    expect(body.error).toBe("not_connected");
  });
});

describe("DELETE /api/google", () => {
  it("revokes the grant at Google and destroys the stored tokens", async () => {
    await connectGoogle();
    const stub = stubFetch([{ match: "oauth2.googleapis.com/revoke", method: "POST", body: {} }]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("DELETE", "/api/google");

    expect(response.status).toBe(200);
    // The refresh token is what was revoked: that invalidates the whole grant.
    expect(stub.requests[0]?.body).toContain("google-refresh-token");
    const row = await testRepos().google.get();
    expect(row.status).toBe("disconnected");
    expect(row.refresh_token_enc).toBeNull();
    expect(row.email_enc).toBeNull();
  });

  it("destroys the local tokens even when Google refuses the revocation", async () => {
    await connectGoogle();
    const stub = stubFetch([
      { match: "oauth2.googleapis.com/revoke", method: "POST", status: 400, body: {} },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("DELETE", "/api/google");

    expect(response.status).toBe(200);
    const row = await testRepos().google.get();
    expect(row.refresh_token_enc).toBeNull();
  });

  it("completes the open reconnect card, so a disconnect does not leave a stale one", async () => {
    await connectGoogle();
    const repos = testRepos();
    const alert = await repos.alerts.openOrGet("google");
    await repos.alerts.setCard(alert.alert.id, "card-7");
    const stub = stubFetch([
      { match: "oauth2.googleapis.com/revoke", method: "POST", body: {} },
      { match: "api.trello.com/1/cards/card-7", method: "PUT", body: {} },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    await owner().send("DELETE", "/api/google");

    expect(await repos.alerts.getOpen("google")).toBeNull();
    expect(stub.requests.some((request) => request.url.includes("idList=done-list"))).toBe(true);
  });

  it("is a no-op that still succeeds when nothing was connected", async () => {
    const response = await owner().send("DELETE", "/api/google");

    expect(response.status).toBe(200);
  });
});
