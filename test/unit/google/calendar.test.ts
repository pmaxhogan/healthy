import { describe, expect, it, vi } from "vitest";

import { buildEventBody, createCalendarClient } from "../../../worker/google/calendar.ts";

import { appErrorFrom, jsonResponse, recordingFetch } from "./helpers.ts";

import type { CalendarClient, CalendarClientOptions } from "../../../worker/google/calendar.ts";
import type { CalendarEventModel } from "../../../worker/google/types.ts";

const CALENDAR_ID = "abc123@group.calendar.google.com";

// Deterministic and instant: no real sleeping, no jitter, and few enough
// attempts that an exhausted retry loop can be asserted on exactly.
const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  random: () => 0.5,
  sleep: () => Promise.resolve(),
};

const fixedToken: CalendarClientOptions["getAccessToken"] = () => Promise.resolve("at-1");

function client(fetchImpl: typeof fetch, getAccessToken = fixedToken): CalendarClient {
  return createCalendarClient({ getAccessToken, fetchImpl, retry: RETRY });
}

const MODEL: CalendarEventModel = {
  key: "prov-1:enc-1",
  provider: "prov-1",
  title: "Follow-up",
  description: "Synced by Healthy",
  start: "2026-10-01T15:00:00Z",
  end: "2026-10-01T15:30:00Z",
  timeZone: "Etc/UTC",
  transparent: false,
  fingerprint: "fp-abc",
};

function quotaBody(reason: string): unknown {
  return {
    error: {
      code: 403,
      message: "Rate Limit Exceeded",
      errors: [{ domain: "usageLimits", reason, message: "Rate Limit Exceeded" }],
    },
  };
}

describe("buildEventBody", () => {
  it("pins visibility, reminders and the healthy marker", () => {
    const body = buildEventBody(MODEL);

    expect(body.visibility).toBe("private");
    expect(body.reminders).toEqual({ useDefault: true });
    // The exact key set is the contract that the diff engine and the
    // privateExtendedProperty list filter both depend on.
    expect(body.extendedProperties.private).toEqual({
      healthy: "1",
      key: "prov-1:enc-1",
      fp: "fp-abc",
      provider: "prov-1",
    });
    expect(
      Object.keys(body.extendedProperties.private).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["fp", "healthy", "key", "provider"]);
  });

  it("carries start and end with the model's time zone", () => {
    const body = buildEventBody(MODEL);

    expect(body.start).toEqual({ dateTime: "2026-10-01T15:00:00Z", timeZone: "Etc/UTC" });
    expect(body.end).toEqual({ dateTime: "2026-10-01T15:30:00Z", timeZone: "Etc/UTC" });
    expect(body.summary).toBe("Follow-up");
    expect(body.description).toBe("Synced by Healthy");
  });

  it("sets transparency from the flag", () => {
    expect(buildEventBody(MODEL).transparency).toBe("opaque");
    expect(buildEventBody({ ...MODEL, transparent: true }).transparency).toBe("transparent");
  });

  it("omits location and colorId rather than sending undefined", () => {
    const bare = buildEventBody(MODEL);
    expect(bare).not.toHaveProperty("location");
    expect(bare).not.toHaveProperty("colorId");

    const full = buildEventBody({ ...MODEL, location: "Video visit", colorId: "8" });
    expect(full.location).toBe("Video visit");
    expect(full.colorId).toBe("8");
  });
});

describe("listCalendars", () => {
  it("asks for owned calendars and drops anything not owned", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: CALENDAR_ID,
            summary: "Healthy Test",
            primary: true,
            timeZone: "Etc/UTC",
            backgroundColor: "#123456",
            accessRole: "owner",
          },
          { id: "shared@group.calendar.google.com", summary: "Shared", accessRole: "reader" },
          { id: "writable@group.calendar.google.com", summary: "Writable", accessRole: "writer" },
        ],
      }),
    );

    const calendars = await client(fetchImpl).listCalendars();

    expect(calls[0]?.url.pathname).toBe("/calendar/v3/users/me/calendarList");
    expect(calls[0]?.url.searchParams.get("minAccessRole")).toBe("owner");
    expect(calendars).toEqual([
      {
        id: CALENDAR_ID,
        summary: "Healthy Test",
        primary: true,
        timeZone: "Etc/UTC",
        backgroundColor: "#123456",
      },
    ]);
  });
});

describe("getColors", () => {
  it("returns the event palette in numeric order", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        calendar: { "1": { background: "#ac725e", foreground: "#1d1d1d" } },
        event: {
          "11": { background: "#dc2127", foreground: "#1d1d1d" },
          "8": { background: "#e1e1e1", foreground: "#1d1d1d" },
        },
      }),
    );

    const colors = await client(fetchImpl).getColors();

    expect(calls[0]?.url.pathname).toBe("/calendar/v3/colors");
    // The event palette only -- calendar colours are a different id space.
    expect(colors).toEqual([
      { id: "8", background: "#e1e1e1", foreground: "#1d1d1d" },
      { id: "11", background: "#dc2127", foreground: "#1d1d1d" },
    ]);
  });
});

describe("listSyncedEvents", () => {
  it("filters on the healthy marker and follows every page", async () => {
    const firstPage = {
      nextPageToken: "page-2",
      items: [
        {
          id: "ev-1",
          status: "confirmed",
          summary: "Follow-up",
          start: { dateTime: "2026-10-01T15:00:00Z", timeZone: "Etc/UTC" },
          end: { dateTime: "2026-10-01T15:30:00Z", timeZone: "Etc/UTC" },
          colorId: "5",
          transparency: "opaque",
          updated: "2026-09-20T00:00:00.000Z",
          etag: '"1"',
          extendedProperties: { private: { healthy: "1", key: "prov-1:enc-1", fp: "fp-abc" } },
        },
      ],
    };
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      jsonResponse(200, index === 0 ? firstPage : { items: [{ id: "ev-2", status: "confirmed" }] }),
    );

    const events = await client(fetchImpl).listSyncedEvents({
      calendarId: CALENDAR_ID,
      timeMin: "2026-06-01T00:00:00Z",
      timeMax: "2027-01-01T00:00:00Z",
    });

    expect(calls).toHaveLength(2);
    const first = calls[0]!.url;
    expect(first.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`);
    expect(first.searchParams.get("privateExtendedProperty")).toBe("healthy=1");
    expect(first.searchParams.get("singleEvents")).toBe("true");
    expect(first.searchParams.get("maxResults")).toBe("250");
    expect(first.searchParams.get("showDeleted")).toBe("false");
    expect(first.searchParams.get("timeMin")).toBe("2026-06-01T00:00:00Z");
    expect(first.searchParams.get("timeMax")).toBe("2027-01-01T00:00:00Z");
    expect(first.searchParams.get("pageToken")).toBeNull();
    // The marker filter is repeated on every page, not just the first.
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("page-2");
    expect(calls[1]?.url.searchParams.get("privateExtendedProperty")).toBe("healthy=1");

    expect(events.map((event) => event.id)).toEqual(["ev-1", "ev-2"]);
    expect(events[0]?.extendedProperties?.private.key).toBe("prov-1:enc-1");
    expect(events[0]?.etag).toBe('"1"');
    // A page entry with no start normalises to null rather than throwing.
    expect(events[1]?.start).toBeNull();
  });

  it("omits timeMax when the caller does not bound the window", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, { items: [] }));

    await client(fetchImpl).listSyncedEvents({
      calendarId: CALENDAR_ID,
      timeMin: "2026-06-01T00:00:00Z",
    });

    expect(calls[0]?.url.searchParams.has("timeMax")).toBe(false);
  });
});

describe("token handling", () => {
  it("forces a refresh once on 401 and retries with the new token", async () => {
    const getAccessToken = vi.fn((opts?: { forceRefresh?: boolean }) =>
      Promise.resolve(opts?.forceRefresh === true ? "at-fresh" : "at-stale"),
    );
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      index === 0
        ? jsonResponse(401, { error: { code: 401, message: "Invalid Credentials" } })
        : jsonResponse(200, { items: [] }),
    );

    await client(fetchImpl, getAccessToken).listCalendars();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe("Bearer at-stale");
    expect(calls[1]?.headers.authorization).toBe("Bearer at-fresh");
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, undefined);
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it("gives up as upstream_auth when a forced refresh still yields 401", async () => {
    const getAccessToken = vi.fn(() => Promise.resolve("at-1"));
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(401, { error: { code: 401 } }));

    const error = await appErrorFrom(client(fetchImpl, getAccessToken).listCalendars());

    expect(error.code).toBe("upstream_auth");
    // Exactly one retry: looping would hide a broken refresh.
    expect(calls).toHaveLength(2);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
});

describe("quota handling", () => {
  it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
    "treats a 403 %s as transient, retries, then reports upstream_unavailable",
    async (reason) => {
      const { fetchImpl, calls } = recordingFetch(() =>
        jsonResponse(403, quotaBody(reason), { "retry-after": "7" }),
      );

      const error = await appErrorFrom(client(fetchImpl).listCalendars());

      expect(error.code).toBe("upstream_unavailable");
      expect(error.retryAfterMs).toBe(7000);
      // Retried up to maxAttempts, not failed on the first 403.
      expect(calls).toHaveLength(RETRY.maxAttempts);
    },
  );

  it("succeeds when the quota clears on a later attempt", async () => {
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      index === 0
        ? jsonResponse(403, quotaBody("quotaExceeded"))
        : jsonResponse(200, { items: [] }),
    );

    await expect(client(fetchImpl).listCalendars()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 403 that is a real permission failure", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(403, {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          errors: [{ domain: "global", reason: "insufficientPermissions" }],
        },
      }),
    );

    const error = await appErrorFrom(client(fetchImpl).listCalendars());

    expect(error.code).toBe("upstream_auth");
    expect(calls).toHaveLength(1);
  });

  it("still routes a plain 429 through the transport retry", async () => {
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      index === 0 ? jsonResponse(429, { error: { code: 429 } }) : jsonResponse(200, { items: [] }),
    );

    await expect(client(fetchImpl).listCalendars()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("maps an exhausted 5xx transport retry to upstream_unavailable", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(500, { error: { code: 500 } }));

    const error = await appErrorFrom(client(fetchImpl).listCalendars());

    expect(error.code).toBe("upstream_unavailable");
    expect(calls).toHaveLength(RETRY.maxAttempts);
  });
});

describe("single event operations", () => {
  it("inserts an event as JSON and returns the created record", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, { id: "ev-new", status: "confirmed", etag: '"2"' }),
    );

    const created = await client(fetchImpl).insertEvent(CALENDAR_ID, buildEventBody(MODEL));

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      visibility: "private",
      reminders: { useDefault: true },
      extendedProperties: { private: { healthy: "1" } },
    });
    expect(created.id).toBe("ev-new");
    expect(created.etag).toBe('"2"');
  });

  it("returns null from patch on 404 so the caller can re-insert", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(404, { error: { code: 404, message: "Not Found" } }),
    );

    await expect(
      client(fetchImpl).patchEvent(CALENDAR_ID, "ev-gone", { summary: "x" }),
    ).resolves.toBeNull();
    // Permanent, so not retried.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
  });

  it("returns null from patch on 410 gone", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(410, { error: { code: 410 } }));

    await expect(
      client(fetchImpl).patchEvent(CALENDAR_ID, "ev-gone", { summary: "x" }),
    ).resolves.toBeNull();
  });

  it("patches and returns the updated record", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        id: "ev-1",
        status: "confirmed",
        transparency: "transparent",
        colorId: "8",
      }),
    );

    const patched = await client(fetchImpl).patchEvent(CALENDAR_ID, "ev-1", {
      transparency: "transparent",
    });

    expect(calls[0]?.url.pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/ev-1`,
    );
    expect(patched?.transparency).toBe("transparent");
    expect(patched?.colorId).toBe("8");
  });

  it("moves an event to another calendar, as a bodyless POST to the destination query param", async () => {
    const destination = "other@group.calendar.google.com";
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(200, {
        id: "ev-1",
        status: "confirmed",
        extendedProperties: { private: { healthy: "1", key: "prov-1:enc-1" } },
      }),
    );

    const moved = await client(fetchImpl).moveEvent(CALENDAR_ID, "ev-1", destination);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe(
      `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/ev-1/move`,
    );
    expect(calls[0]?.url.searchParams.get("destination")).toBe(destination);
    // No body: `events.move` takes the destination as a query param only.
    expect(calls[0]?.body).toBeNull();
    expect(moved?.id).toBe("ev-1");
    expect(moved?.extendedProperties?.private.key).toBe("prov-1:enc-1");
  });

  it("returns null from move on 404, like a patch on a deleted event", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse(404, { error: { code: 404, message: "Not Found" } }),
    );

    await expect(
      client(fetchImpl).moveEvent(CALENDAR_ID, "ev-gone", "other-cal"),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns null from move on 410 gone", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(410, { error: { code: 410 } }));

    await expect(
      client(fetchImpl).moveEvent(CALENDAR_ID, "ev-gone", "other-cal"),
    ).resolves.toBeNull();
  });

  it("returns null from getEvent when the event is gone", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(404, { error: { code: 404 } }));

    await expect(client(fetchImpl).getEvent(CALENDAR_ID, "ev-gone")).resolves.toBeNull();
  });

  it("reads a single event", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(200, { id: "ev-1", status: "cancelled" }),
    );

    const event = await client(fetchImpl).getEvent(CALENDAR_ID, "ev-1");

    expect(event).toMatchObject({ id: "ev-1", status: "cancelled" });
  });

  it("deletes for admin cleanup, tolerating an already-missing event", async () => {
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      index === 0
        ? new Response(null, { status: 204 })
        : jsonResponse(404, { error: { code: 404 } }),
    );
    const calendar = client(fetchImpl);

    await expect(calendar.deleteEvent(CALENDAR_ID, "ev-1")).resolves.toBe(true);
    await expect(calendar.deleteEvent(CALENDAR_ID, "ev-missing")).resolves.toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
  });
});
