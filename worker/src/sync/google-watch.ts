/**
Knowing, at the end of a run, whether Google Calendar was what failed.

The calendar is written from inside each health system's pass, so a write
Google refuses surfaces as *that health system's* pass throwing. Counted
there, a calendar that has gone read-only would be reported as every health
system failing at once, on cards that each say nothing needs reconnecting,
while Google's own streak was cleared every hour by a listing that still
works. So the client a run uses is wrapped here: every call that throws is
remembered, and the error itself is marked, which lets the code that catches
it say whose failure it is (`isCalendarFault`) and lets the run report on
Google once, at its end (`failure`).

A call that fails here has already been through the client's own retries, so
one failure is as settled as that call is going to get in this run. Codes
only: nothing from a response is kept.
*/

import type { CalendarClient } from "../google/calendar.ts";

/** Errors a watched client threw. Weak: an error is only ever looked up while it is in flight. */
const faults = new WeakSet();

/** True when the error was thrown by a call to Google Calendar in a watched client. */
export function isCalendarFault(error: unknown): boolean {
  return typeof error === "object" && error !== null && faults.has(error);
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "internal";
}

export interface WatchedCalendar {
  /** The same client, with every call watched. */
  client: CalendarClient;
  /** The code of the first call that failed since the watch began, or null. */
  failure(): string | null;
}

export function watchCalendar(inner: CalendarClient): WatchedCalendar {
  let first: string | null = null;
  const watch = async <T>(call: Promise<T>): Promise<T> => {
    try {
      return await call;
    } catch (error) {
      first ??= codeOf(error);
      if (typeof error === "object" && error !== null) faults.add(error);
      throw error;
    }
  };
  return {
    failure: () => first,
    // Method by method, so a call added to the client cannot go unwatched
    // without the compiler saying so.
    client: {
      listCalendars: () => watch(inner.listCalendars()),
      getColors: () => watch(inner.getColors()),
      listSyncedEvents: (opts) => watch(inner.listSyncedEvents(opts)),
      getEvent: (calendarId, eventId) => watch(inner.getEvent(calendarId, eventId)),
      insertEvent: (calendarId, body) => watch(inner.insertEvent(calendarId, body)),
      patchEvent: (calendarId, eventId, body) => watch(inner.patchEvent(calendarId, eventId, body)),
      moveEvent: (source, eventId, destination) =>
        watch(inner.moveEvent(source, eventId, destination)),
      deleteEvent: (calendarId, eventId) => watch(inner.deleteEvent(calendarId, eventId)),
    },
  };
}
