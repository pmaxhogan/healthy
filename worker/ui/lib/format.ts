// Display helpers. Every function that needs "now" takes it as an argument so
// the tests are deterministic, and every function that formats an absolute time
// takes the timezone explicitly -- the owner's timezone is a setting read from
// the API at runtime, never a default in source.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parses an ISO string the API handed us, or null if it is absent/unparseable. */
export function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "just now", "12 min ago", "in 3 h", "5 d ago".
 *
 * Deliberately not `Intl.RelativeTimeFormat`: the unit thresholds below are the
 * ones this dashboard wants (minutes up to an hour, hours up to two days), and
 * the short forms line up in a table where "in 3 hours" would not.
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const date = parseIso(iso);
  if (!date) return "never";

  const deltaMs = date.getTime() - now;
  const abs = Math.abs(deltaMs);
  if (abs < 45_000) return "just now";

  const future = deltaMs > 0;
  let amount: string;
  if (abs < HOUR) amount = `${String(Math.round(abs / MINUTE))} min`;
  else if (abs < 2 * DAY) amount = `${String(Math.round(abs / HOUR))} h`;
  else if (abs < 60 * DAY) amount = `${String(Math.round(abs / DAY))} d`;
  else amount = `${String(Math.round(abs / (30 * DAY)))} mo`;

  return future ? `in ${amount}` : `${amount} ago`;
}

/** True when the instant is in the past. Used to call an expired token expired. */
export function isPast(iso: string | null | undefined, now: number = Date.now()): boolean {
  const date = parseIso(iso);
  return date !== null && date.getTime() < now;
}

function formatIn(
  iso: string | null | undefined,
  timezone: string | null,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = parseIso(iso);
  if (!date) return "—";
  // A null timezone means the owner has not chosen one yet; the browser's own
  // zone is the only honest fallback and it never reaches the server.
  const resolved = timezone ?? undefined;
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: resolved }).format(date);
}

/** "21 Sep 2026, 14:05" in the given zone. */
export function formatDateTime(iso: string | null | undefined, timezone: string | null): string {
  return formatIn(iso, timezone, { dateStyle: "medium", timeStyle: "short" });
}

/** "21 Sep 2026" in the given zone. */
export function formatDate(iso: string | null | undefined, timezone: string | null): string {
  return formatIn(iso, timezone, { dateStyle: "medium" });
}

/** "14:05" in the given zone. */
export function formatTime(iso: string | null | undefined, timezone: string | null): string {
  return formatIn(iso, timezone, { timeStyle: "short" });
}

/** "412 ms" / "1.8 s" -- audit durations span both. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Masks an account label for display: `o…r@example.test`.
 *
 * The Worker already masks what it sends, so this is belt-and-braces for
 * anything that arrives unmasked -- and it means a screenshot of this UI never
 * carries a whole address.
 */
export function maskAccount(label: string | null): string {
  if (!label) return "—";
  const at = label.lastIndexOf("@");
  if (at < 1) return label.length <= 2 ? label : `${label[0] ?? ""}…`;
  const local = label.slice(0, at);
  const domain = label.slice(at);
  return local.length <= 2
    ? `${local}${domain}`
    : `${local[0] ?? ""}…${local.at(-1) ?? ""}${domain}`;
}

/**
 * Masks a calendar id for display when it looks like an email address.
 *
 * A primary Google calendar's id *is* the account's address, so without this
 * the same address that `maskAccount` hides under "Account" reappears in plain
 * text a few lines down as "Calendar" -- on the same screen. An id that is not
 * an address (a real calendar id, "primary", a human-chosen name) is shown
 * unchanged: `maskAccount` mangles non-address input (see its own tests), and
 * there is nothing sensitive in a calendar id that is not the owner's email.
 */
export function maskCalendarId(id: string): string {
  return id.includes("@") ? maskAccount(id) : id;
}

/** Sentence-cases a snake_case status or error code for display. */
export function humanizeCode(code: string | null): string {
  return code ? code.replaceAll("_", " ") : "—";
}

/** "412 B" / "3.1 KB" -- the size of one MCP tool call's request or result JSON. */
export function formatBytes(bytes: number): string {
  return bytes < 1000 ? `${String(bytes)} B` : `${(bytes / 1000).toFixed(1)} KB`;
}
