import { describe, expect, it } from "vitest";

import { AppError } from "../../../src/lib/errors.ts";
import { isCalendarFault, watchCalendar } from "../../../src/sync/google-watch.ts";

import type { CalendarClient } from "../../../src/google/calendar.ts";

/** A client whose every call answers, bar the ones a test replaces. */
function client(overrides: Partial<CalendarClient> = {}): CalendarClient {
  return {
    listCalendars: () => Promise.resolve([]),
    getColors: () => Promise.resolve([]),
    listSyncedEvents: () => Promise.resolve([]),
    getEvent: () => Promise.resolve(null),
    insertEvent: () => Promise.reject(new Error("not used")),
    patchEvent: () => Promise.resolve(null),
    moveEvent: () => Promise.resolve(null),
    deleteEvent: () => Promise.resolve(true),
    ...overrides,
  };
}

describe("watchCalendar", () => {
  it("reports nothing while every call works, and passes answers through", async () => {
    const watched = watchCalendar(client({ deleteEvent: () => Promise.resolve(false) }));

    await expect(
      watched.client.listSyncedEvents({ calendarId: "c", timeMin: "t" }),
    ).resolves.toEqual([]);
    await expect(watched.client.deleteEvent("c", "e")).resolves.toBe(false);
    expect(watched.failure()).toBeNull();
  });

  it("remembers the code of the first call that failed, and rethrows the same error", async () => {
    const refused = new AppError("upstream_auth", "refused");
    const watched = watchCalendar(
      client({
        patchEvent: () => Promise.reject(refused),
        getEvent: () => Promise.reject(new AppError("upstream_unavailable", "later")),
      }),
    );

    await expect(watched.client.patchEvent("c", "e", {})).rejects.toBe(refused);
    await expect(watched.client.getEvent("c", "e")).rejects.toMatchObject({
      code: "upstream_unavailable",
    });

    expect(watched.failure()).toBe("upstream_auth");
  });

  it("marks what it threw, and nothing else, as the calendar's failure", async () => {
    const refused = new AppError("upstream_auth", "refused");
    const watched = watchCalendar(client({ insertEvent: () => Promise.reject(refused) }));
    await expect(
      watched.client.insertEvent("c", {} as Parameters<CalendarClient["insertEvent"]>[1]),
    ).rejects.toBe(refused);

    expect(isCalendarFault(refused)).toBe(true);
    expect(isCalendarFault(new AppError("upstream_auth", "from somewhere else"))).toBe(false);
    expect(isCalendarFault("upstream_auth")).toBe(false);
    expect(isCalendarFault(null)).toBe(false);
  });

  it("calls a failure with no code internal", async () => {
    const watched = watchCalendar(
      client({ listCalendars: () => Promise.reject(new Error("boom")) }),
    );

    await expect(watched.client.listCalendars()).rejects.toThrow("boom");
    expect(watched.failure()).toBe("internal");
  });
});
