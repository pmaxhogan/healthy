// Wire shapes for the two Google APIs this Worker talks to, plus the one
// internal shape (`CalendarEventModel`) that the sync engine hands to
// `buildEventBody`.
//
// These are deliberately narrow: only the fields the sync engine reads or
// writes are declared, so a field appearing in a Google response that nobody
// asked for cannot silently become part of the contract. Google omits most
// optional event fields entirely rather than sending null, so the response
// shapes use `?` and the normalised `EventRecord` uses `null` for "absent".

/** Tokens as they come back from an authorization-code exchange. */
export interface GoogleTokens {
  accessToken: string;
  /** Unix milliseconds. Absolute, so it survives being stored. */
  expiresAt: number;
  refreshToken: string;
  /** Space-separated list exactly as Google returned it. */
  scope: string;
}

/**
 * A refresh yields no new refresh token (Google keeps the original valid), so
 * this is `GoogleTokens` minus that field rather than a partial of it.
 */
export type GoogleRefreshedTokens = Omit<GoogleTokens, "refreshToken">;

/** An owned calendar, as the admin UI's calendar picker needs it. */
export interface CalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
  timeZone: string;
  /** Only present when `colorRgbFormat` calendars are in play; null otherwise. */
  backgroundColor: string | null;
}

/** One entry of the live event colour palette (`colors.get` → `event`). */
export interface ColorOption {
  /** The `colorId` to send on an event. */
  id: string;
  background: string;
  foreground: string;
}

/** A timed event boundary. All-day events are never written by this app. */
export interface EventDateTime {
  /** RFC3339 with offset. */
  dateTime: string;
  /** IANA zone name. */
  timeZone: string;
}

/**
 * The private extended properties every event this app owns carries.
 *
 * `healthy: "1"` is the invariant: the sync engine only ever lists, patches or
 * considers events that carry it, so an event the owner created by hand can
 * never be touched. The other three exist so a sync run can diff without
 * re-reading anything else: `key` identifies the appointment, `fp` is the
 * fingerprint of the mapped fields, `health_system` says which connection produced
 * it.
 */
interface HealthyEventProperties {
  healthy: "1";
  key: string;
  fp: string;
  healthSystem: string;
  [extra: string]: string;
}

type EventTransparency = "opaque" | "transparent";
type EventStatus = "confirmed" | "tentative" | "cancelled";

/** The body sent to `events.insert` / `events.patch`. */
export interface CalendarEventBody {
  summary: string;
  description?: string;
  location?: string;
  start: EventDateTime;
  end: EventDateTime;
  /** Always "private": these events describe medical appointments. */
  visibility: "private";
  transparency: EventTransparency;
  colorId?: string;
  status?: EventStatus;
  extendedProperties: { private: HealthyEventProperties };
  /** Calendar defaults, never a per-event override. */
  reminders: { useDefault: true };
}

/** An event as read back from `events.list` / `events.get` / a write response. */
export interface EventRecord {
  id: string;
  status: string;
  summary: string | null;
  start: EventDateTime | null;
  end: EventDateTime | null;
  colorId: string | null;
  transparency: string | null;
  extendedProperties: { private: Record<string, string> } | null;
  /** RFC3339 last-modified stamp Google maintains. */
  updated: string | null;
  etag: string | null;
}

/**
 * What the sync engine produces from a FHIR Encounter, and the only input to
 * `buildEventBody`. Kept minimal on purpose: the mapping layer owns titles,
 * descriptions and arrival offsets, and this type is the seam between it and
 * the Google wire format.
 */
export interface CalendarEventModel {
  /**
   * The blinded event key (`blindEventKey`). Stable for the life of the
   * appointment; the row's primary key and the Google marker alike.
   */
  key: string;
  /**
   * The logical upstream id the key was blinded from: an Encounter id, or
   * `csn:<csn>` for a portal visit. Never sent to Google -- `buildEventBody` picks
   * its fields explicitly -- and only read by the row writer, which blinds it.
   */
  encounterId: string;
  /** Health system id, for per-health system diffing and cleanup. */
  healthSystem: string;
  title: string;
  description: string;
  location?: string;
  /** RFC3339. */
  start: string;
  /** RFC3339. */
  end: string;
  /** IANA zone the two boundaries above are expressed in. */
  timeZone: string;
  colorId?: string;
  /** Ghosted (vanished or cancelled) appointments do not block time. */
  transparent: boolean;
  fingerprint: string;
}
