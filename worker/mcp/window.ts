/**
 * What a caller's `from` and `to` mean, in one place: which strings are
 * accepted (`args.ts` validates with {@link isIsoDateOrInstant}) and what
 * instant each one bounds (`collect.ts` windows with {@link windowBound}).
 * docs/mcp.md ("Date windows") describes the same rules for a caller.
 *
 * UTC throughout, on purpose: nothing here knows the owner's timezone, and must
 * not. A caller who means a local day passes instants with their own offset.
 */

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`: a whole UTC period rather than an instant. */
const DATE_ONLY = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u;

/** The time of day after the `T`, once any offset is taken off. */
const TIME_OF_DAY = /^\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?$/u;

/** A trailing `Z` or `+HH:MM` / `-HH:MM`. */
const OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Whether a value is an ISO-8601 date (`2026`, `2026-01`, `2026-01-31`) or a
 * date-time (`2026-01-31T09:00`, with optional seconds, fraction and offset)
 * naming a real point in time. Anything else -- "last March", a US-style date
 * `Date.parse` would guess at -- is not, so a window is always the one the
 * tool's description promises.
 */
export function isIsoDateOrInstant(value: string): boolean {
  const [date = "", time, ...rest] = value.split("T");
  if (rest.length > 0) return false;
  const day = DATE_ONLY.exec(date);
  if (day === null) return false;
  if (time === undefined)
    return !Number.isNaN(Date.parse(day[2] === undefined ? `${date}-01` : date));
  return (
    day[3] !== undefined &&
    TIME_OF_DAY.test(time.replace(OFFSET, "")) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** The first millisecond after the UTC period a date-only value names. */
function periodEnd(year: number, month: number | undefined, day: number | undefined): number {
  if (month === undefined) return Date.UTC(year + 1, 0, 1);
  return day === undefined ? Date.UTC(year, month + 1, 1) : Date.UTC(year, month, day + 1);
}

/**
 * A caller's `from` (`end: false`) or `to` (`end: true`) as a comparable
 * millisecond value; both ends are inclusive (`collect.ts`'s `inWindow`
 * compares with `>=` and `<=`).
 *
 * A date without a time is a whole UTC period: as a lower bound it starts at
 * the period's first millisecond and as an upper bound it runs to its last, or
 * `to: "2026-01-31"` would silently drop everything after midnight on the last
 * day (and `to: "2026-01"` all of January but its first instant). A date-time
 * without an offset is read as UTC -- explicitly, because `Date.parse` would
 * otherwise use the host's zone, which is UTC in workerd but not in every test
 * runner.
 */
export function windowBound(value: string | undefined, end: boolean): number | undefined {
  if (value === undefined) return undefined;
  const date = DATE_ONLY.exec(value);
  if (date !== null) {
    const year = Number(date[1]);
    const month = date[2] === undefined ? undefined : Number(date[2]) - 1;
    const day = date[3] === undefined ? undefined : Number(date[3]);
    return end ? periodEnd(year, month, day) - 1 : Date.UTC(year, month ?? 0, day ?? 1);
  }
  const ms = Date.parse(OFFSET.test(value) ? value : `${value}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}
