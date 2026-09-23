// Google Calendar v3 client.
//
// Pure module: no D1, no Env. The caller injects `getAccessToken`, which owns
// the stored tokens, the refresh lease and the single-flight behaviour; this
// file only knows when to ask for a fresh one.
//
// Two upstream behaviours shape the whole error handling here:
//
//   1. A 401 means the access token died mid-run (early expiry, a revoked grant,
//      a clock skew). Every call retries exactly once after asking for a forced
//      refresh. Twice would mean the refresh is not working, which is a
//      `needs_reauth` question for the token owner, not something to loop on.
//
//   2. Google returns **403, not 429**, for most quota exhaustion, with the real
//      cause buried in `error.errors[].reason`. `classifyStatus` in lib/retry.ts
//      classes 403 as auth -- correctly, for every other API -- so quota has to
//      be detected from the body and backed off here. Getting this wrong means a
//      rate-limited sync is reported as an auth failure and opens a spurious
//      reconnect alert.
//
// Everything else (429, 5xx, network) is left to `retriedFetch`, and a 404 or
// 410 on a single event is returned as `null` so the sync engine can re-insert
// an event the owner deleted by hand instead of failing the run.

import { AppError } from "../lib/errors.ts";
import { noopLogger } from "../lib/log.ts";
import {
  computeDelayMs,
  parseRetryAfter,
  PermanentError,
  retriedFetch,
  TransientError,
} from "../lib/retry.ts";

import type {
  CalendarEventBody,
  CalendarEventModel,
  CalendarSummary,
  ColorOption,
  EventDateTime,
  EventRecord,
} from "./types.ts";
import type { Logger } from "../lib/log.ts";
import type { RetryOpts } from "../lib/retry.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
const JSON_CONTENT_TYPE = "application/json";

/** Page size for both list calls. 250 is Google's documented maximum. */
const PAGE_SIZE = "250";

/**
 * `reason` values Google uses for quota exhaustion on a 403. These are
 * transient: the same request succeeds later.
 */
const QUOTA_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

/** Statuses that mean "this event is not there any more", not "this failed". */
const GONE_STATUSES = new Set([404, 410]);

export interface CalendarClientOptions {
  /**
   * Returns a usable access token. `forceRefresh` is passed when a 401 proved
   * the cached one is dead, so the implementation must bypass its own cache.
   */
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Passed through to `retriedFetch`, and used for the 403-quota backoff. */
  retry?: RetryOpts;
}

export interface CalendarClient {
  /** Owned calendars only -- the picker must not offer a read-only calendar. */
  listCalendars(): Promise<CalendarSummary[]>;
  /** The live event palette, so the UI shows the colours Google actually uses. */
  getColors(): Promise<ColorOption[]>;
  /** Every event this app owns in the window, following all pages. */
  listSyncedEvents(opts: {
    calendarId: string;
    timeMin: string;
    timeMax?: string;
  }): Promise<EventRecord[]>;
  getEvent(calendarId: string, eventId: string): Promise<EventRecord | null>;
  insertEvent(calendarId: string, body: CalendarEventBody): Promise<EventRecord>;
  /** `null` when the event is gone, so the caller can re-insert it. */
  patchEvent(
    calendarId: string,
    eventId: string,
    body: Partial<CalendarEventBody>,
  ): Promise<EventRecord | null>;
  /**
   * Move a tracked event to a different calendar, keeping its event id and
   * everything else about it -- including `extendedProperties`, so the moved
   * event is still ours by the `healthy=1` invariant on the calendar it lands
   * on. An event id is only ever valid on the calendar it was created on, so
   * this is what a sync target change has to do instead of a plain patch, which
   * would 404 against the new calendar. `null` when the event is gone from the
   * source calendar too -- genuinely deleted, not merely relocated.
   */
  moveEvent(
    sourceCalendarId: string,
    eventId: string,
    destinationCalendarId: string,
  ): Promise<EventRecord | null>;
  /**
   * Admin cleanup, plus exactly one sync path. Vanished and cancelled
   * appointments are ghosted (title prefix + transparent + grey), never
   * deleted, so that a cancelled visit stays visible in the owner's history.
   *
   * The one exception is a *duplicate*: a portal event for a visit that a
   * higher-precedence copy (another organisation's own record, or a FHIR
   * Encounter) already has an event for. That visit is not cancelled -- it is
   * on the calendar, once -- so a grey "Cancelled:" twin beside it would be
   * wrong, and the portal pass deletes it instead. It deletes only an event it
   * has just seen carrying `extendedProperties.private.healthy = "1"` and the
   * row's own key. See `removeDuplicates` in `worker/sync/portal-sync.ts`.
   */
  deleteEvent(calendarId: string, eventId: string): Promise<boolean>;
}

interface GoogleErrorBody {
  error?: { status?: unknown; message?: unknown; errors?: { reason?: unknown }[] };
}

/** Per-call switches for the shared request helper. */
interface CallOptions {
  /** JSON request body. Its presence is what adds the content-type header. */
  body?: unknown;
  /** Treat 404 and 410 as `null` instead of an error. */
  gone?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * True when a 403 body says "you are going too fast" rather than "you may not
 * do this". `RESOURCE_EXHAUSTED` is the newer google.rpc spelling of the same
 * thing and appears alongside, or instead of, the legacy `reason`.
 */
function isQuotaError(body: string): boolean {
  let parsed: GoogleErrorBody;
  try {
    parsed = JSON.parse(body) as GoogleErrorBody;
  } catch {
    return false;
  }
  const error = parsed.error ?? {};
  return (
    error.status === "RESOURCE_EXHAUSTED" ||
    (error.errors ?? []).some(
      (entry) => typeof entry.reason === "string" && QUOTA_REASONS.has(entry.reason),
    )
  );
}

/**
 * Translate a throw from `retriedFetch` into this app's taxonomy.
 *
 * Returns `null` -- the "it is simply not there" answer -- only for a 404/410 on
 * a call that asked for it. Every other outcome throws.
 */
function transportFailure(error: unknown, method: string, gone: boolean): null {
  if (error instanceof TransientError) {
    // retriedFetch already exhausted its own retries for 429/5xx and network
    // failures, so this is as transient as it is going to get.
    throw new AppError(
      "upstream_unavailable",
      `google calendar ${method}: ${error.message}`,
      { status: error.lastStatus ?? 0 },
      {
        cause: error,
        ...(error.retryAfterMs !== undefined && { retryAfterMs: error.retryAfterMs }),
      },
    );
  }
  if (error instanceof PermanentError) {
    if (gone && error.status !== undefined && GONE_STATUSES.has(error.status)) return null;
    throw new AppError("upstream_error", `google calendar ${method}: ${error.message}`, {
      status: error.status ?? 0,
    });
  }
  throw error;
}

/** Parse a 2xx body. An empty body (204 from delete) reads as `null`. */
async function successBody(response: Response, method: string): Promise<unknown> {
  const body = await readBody(response);
  if (body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError("upstream_error", `google calendar ${method}: response was not JSON`);
  }
}

function toEventDateTime(value: unknown): EventDateTime | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { dateTime?: unknown; date?: unknown; timeZone?: unknown };
  // All-day events carry `date` instead of `dateTime`. This app never writes
  // one, but the owner's calendar may contain one that somehow carries our
  // marker, and it must not crash the diff.
  const dateTime = asString(raw.dateTime) ?? asString(raw.date);
  return dateTime === null ? null : { dateTime, timeZone: asString(raw.timeZone) ?? "" };
}

function toExtendedProperties(value: unknown): { private: Record<string, string> } | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as { private?: unknown }).private;
  if (!raw || typeof raw !== "object") return null;
  return {
    private: Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

/** Normalise one events.* response object. Returns null when it has no id. */
function toEventRecord(value: unknown): EventRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  if (id === null) return null;
  return {
    id,
    status: asString(raw.status) ?? "confirmed",
    summary: asString(raw.summary),
    start: toEventDateTime(raw.start),
    end: toEventDateTime(raw.end),
    colorId: asString(raw.colorId),
    transparency: asString(raw.transparency),
    extendedProperties: toExtendedProperties(raw.extendedProperties),
    updated: asString(raw.updated),
    etag: asString(raw.etag),
  };
}

/**
 * Build the `events.insert` / `events.patch` body for a mapped appointment.
 *
 * Three fields are not configurable and are the app's contract:
 *   - `visibility: "private"` -- these are medical appointments, and the owner's
 *     calendar may be shared with free/busy or full detail.
 *   - `reminders.useDefault: true` -- the owner's calendar defaults win; this
 *     app never invents notification timings.
 *   - `extendedProperties.private.healthy: "1"` -- the invariant that makes an
 *     event ours. Without it the sync can neither find nor touch the event.
 */
export function buildEventBody(model: CalendarEventModel): CalendarEventBody {
  return {
    summary: model.title,
    description: model.description,
    ...(model.location !== undefined && { location: model.location }),
    start: { dateTime: model.start, timeZone: model.timeZone },
    end: { dateTime: model.end, timeZone: model.timeZone },
    visibility: "private",
    // A ghosted (cancelled or vanished) appointment must not block time, a live
    // one must.
    transparency: model.transparent ? "transparent" : "opaque",
    ...(model.colorId !== undefined && { colorId: model.colorId }),
    extendedProperties: {
      private: {
        healthy: "1",
        key: model.key,
        fp: model.fingerprint,
        healthSystem: model.healthSystem,
      },
    },
    reminders: { useDefault: true },
  };
}

export function createCalendarClient(options: CalendarClientOptions): CalendarClient {
  const { getAccessToken } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.logger ?? noopLogger;
  const retry = options.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? 4;
  const baseDelayMs = retry.baseDelayMs ?? 200;
  const maxDelayMs = retry.maxDelayMs ?? 5000;
  const random = retry.random ?? Math.random;
  const sleep = retry.sleep ?? defaultSleep;
  const now = retry.now ?? Date.now;

  const send = async (
    method: string,
    url: string,
    token: string,
    body: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: JSON_CONTENT_TYPE,
    };
    if (body !== undefined) headers["content-type"] = JSON_CONTENT_TYPE;
    const outcome = await retriedFetch(
      url,
      { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) },
      { ...retry, fetchImpl },
    );
    return outcome.value;
  };

  /** Back off once for a 403 that turned out to be quota, or give up. */
  const quotaBackoff = async (
    method: string,
    response: Response,
    quotaRetries: number,
  ): Promise<void> => {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now) ?? undefined;
    if (quotaRetries >= maxAttempts - 1) {
      log.warn("google.calendar.quota_exhausted", { attempts: maxAttempts });
      throw new AppError(
        "upstream_unavailable",
        `google calendar ${method}: quota exhausted after ${String(maxAttempts)} attempts`,
        { status: 403 },
        retryAfterMs === undefined ? undefined : { retryAfterMs },
      );
    }
    const delay = computeDelayMs(quotaRetries, { baseDelayMs, maxDelayMs, random }, retryAfterMs);
    log.debug("google.calendar.quota_backoff", { attempt: quotaRetries + 1, delayMs: delay });
    await sleep(delay);
  };

  /**
   * One authorized JSON call. Resolves to the parsed body, or null when the
   * event is gone (404/410 with `gone`) or the response had no body (204).
   */
  const request = async (method: string, url: string, init: CallOptions = {}): Promise<unknown> => {
    let forceRefresh = false;
    let refreshed = false;
    let quotaRetries = 0;

    for (;;) {
      const token = await getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;

      let response: Response;
      try {
        response = await send(method, url, token, init.body);
      } catch (error) {
        return transportFailure(error, method, init.gone === true);
      }
      if (response.ok) return await successBody(response, method);

      // Only 401 and 403 reach here: retriedFetch hands auth responses back
      // untouched and deals with (or throws for) everything else.
      const body = await readBody(response);

      if (response.status === 401) {
        if (refreshed) {
          throw new AppError(
            "upstream_auth",
            `google calendar ${method}: 401 after a forced refresh`,
            {
              status: 401,
            },
          );
        }
        refreshed = true;
        forceRefresh = true;
        log.debug("google.calendar.token_refresh");
        continue;
      }

      if (!isQuotaError(body)) {
        // A genuine 403: the grant is missing a scope, or this account cannot
        // write to the calendar. Not retryable, and not a quota problem.
        throw new AppError("upstream_auth", `google calendar ${method}: 403 forbidden`, {
          status: 403,
        });
      }
      await quotaBackoff(method, response, quotaRetries);
      quotaRetries += 1;
    }
  };

  /**
   * Follow `nextPageToken` until Google stops sending one. No page ceiling: the
   * owner's calendar is whatever size it is. The one thing that stops this early
   * is Google handing back a token it already gave us -- a genuine upstream bug,
   * not a large calendar -- which is reported loudly rather than looped on.
   */
  const listAll = async (
    build: (pageToken: string | null) => string,
    label: string,
  ): Promise<unknown[]> => {
    const collected: unknown[] = [];
    const visited = new Set<string>();
    let pageToken: string | null = null;
    for (;;) {
      const body = (await request("GET", build(pageToken))) as {
        items?: unknown;
        nextPageToken?: unknown;
      } | null;
      const items = body?.items;
      if (Array.isArray(items)) collected.push(...(items as unknown[]));
      pageToken = asString(body?.nextPageToken);
      if (pageToken === null) break;
      if (visited.has(pageToken)) {
        throw new AppError("upstream_error", "google calendar repeated a page token", { label });
      }
      visited.add(pageToken);
    }
    log.debug(`google.calendar.${label}`, { count: collected.length });
    return collected;
  };

  return {
    async listCalendars() {
      const raw = await listAll((pageToken) => {
        const params = new URLSearchParams({
          // Google filters server-side; the accessRole check below is belt and
          // braces in case a calendar is downgraded between the two.
          minAccessRole: "owner",
          maxResults: PAGE_SIZE,
          showHidden: "true",
        });
        if (pageToken !== null) params.set("pageToken", pageToken);
        return `${BASE}/users/me/calendarList?${params.toString()}`;
      }, "calendar_list");

      const calendars: CalendarSummary[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const id = asString(item.id);
        if (id === null || item.accessRole !== "owner") continue;
        calendars.push({
          id,
          summary: asString(item.summary) ?? id,
          primary: item.primary === true,
          timeZone: asString(item.timeZone) ?? "",
          backgroundColor: asString(item.backgroundColor),
        });
      }
      return calendars;
    },

    async getColors() {
      const body = (await request("GET", `${BASE}/colors`)) as { event?: unknown } | null;
      const palette = body?.event;
      if (!palette || typeof palette !== "object") return [];
      const colors: ColorOption[] = [];
      for (const [id, value] of Object.entries(palette as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const entry = value as { background?: unknown; foreground?: unknown };
        colors.push({
          id,
          background: asString(entry.background) ?? "",
          foreground: asString(entry.foreground) ?? "",
        });
      }
      // Google keys the palette "1".."11", and the UI shows the swatches in
      // that order rather than the object's insertion order.
      // eslint-disable-next-line unicorn/no-array-sort -- `toSorted` is ES2023; the Worker project's lib is ES2022. `colors` is local, so sorting in place is safe.
      return colors.sort((a, b) => Number(a.id) - Number(b.id));
    },

    async listSyncedEvents({ calendarId, timeMin, timeMax }) {
      const raw = await listAll((pageToken) => {
        const params = new URLSearchParams({
          // THE invariant. Only events carrying our marker are ever listed, so
          // nothing the sync does can reach an event the owner created.
          privateExtendedProperty: "healthy=1",
          // Recurrence is expanded: an appointment is a single instance, and a
          // recurring series would otherwise diff against its master.
          singleEvents: "true",
          maxResults: PAGE_SIZE,
          showDeleted: "false",
          timeMin,
        });
        if (timeMax !== undefined) params.set("timeMax", timeMax);
        if (pageToken !== null) params.set("pageToken", pageToken);
        return `${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      }, "events_list");

      const events: EventRecord[] = [];
      for (const entry of raw) {
        const record = toEventRecord(entry);
        if (record !== null) events.push(record);
      }
      return events;
    },

    async getEvent(calendarId, eventId) {
      const body = await request(
        "GET",
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { gone: true },
      );
      return body === null ? null : toEventRecord(body);
    },

    async insertEvent(calendarId, body) {
      const created = await request(
        "POST",
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          body,
        },
      );
      const record = toEventRecord(created);
      if (record === null) {
        throw new AppError("upstream_error", "google calendar insert: response had no event id");
      }
      return record;
    },

    async patchEvent(calendarId, eventId, body) {
      const patched = await request(
        "PATCH",
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { body, gone: true },
      );
      // 404/410: the owner deleted it by hand, or it was already purged. The
      // caller re-inserts instead of treating the run as failed.
      return patched === null ? null : toEventRecord(patched);
    },

    async moveEvent(sourceCalendarId, eventId, destinationCalendarId) {
      const params = new URLSearchParams({ destination: destinationCalendarId });
      const moved = await request(
        "POST",
        `${BASE}/calendars/${encodeURIComponent(sourceCalendarId)}/events/${encodeURIComponent(eventId)}/move?${params.toString()}`,
        { gone: true },
      );
      // 404/410: gone from the source calendar too, not merely moved already --
      // the caller treats this exactly like a patch on a deleted event.
      return moved === null ? null : toEventRecord(moved);
    },

    async deleteEvent(calendarId, eventId) {
      // See the interface comment: admin cleanup, and the sync's duplicates only.
      await request(
        "DELETE",
        `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { gone: true },
      );
      // A successful delete answers 204 and a missing event answers 404, both
      // of which `request` reports as null. Either way the event is gone, which
      // is all an admin cleanup caller needs to know; a real failure has
      // already been thrown.
      return true;
    },
  };
}
