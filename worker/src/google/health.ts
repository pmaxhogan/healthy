/**
The Google Health API (v4): the owner's wearable data, read with the same
Google grant the calendar uses.

Fitbit's own Web API was switched off in 2026; Google Health is where a Fitbit
or Pixel Watch's data is served now. Health Connect, which the companion app
reads, never receives some of it -- blood-oxygen saturation above all -- so
this module reads exactly the metrics the phone path cannot supply, and no
others:

  - five daily summaries, each one value per calendar day, read with
    `dataPoints.list` and a `<type>.date` filter (`GH_DAILY_TYPES`);
  - two interval types summed per day by `dataPoints:dailyRollUp`, at most 90
    days a request (`GH_ROLLUP_TYPES`).

Pure, like `oauth.ts`: no D1, no Env. The caller hands in a token getter (the
calendar's, which refreshes under the account lease), a fetch and a logger,
and gets back plain `{ date, values }` days with every value already in the
units and names the MCP tool serves. Two facts about the API that are easy to
get wrong:

  - int64 fields (`nonRemHeartRateBeatsPerMinute`, the AZM sums, a zone's
    bpm bounds) arrive as JSON strings. `num` reads both.
  - An account that has not been moved to Google Health answers 400
    FAILED_PRECONDITION with reason `ACCOUNT_NOT_LINKED`; a grant without the
    scope answers 403. Each maps to its own stable code
    (`googleHealthErrorCode`), because the fixes differ: the owner signs in to
    the Fitbit app once, or grants the scope again. Neither is retried.

A response body is read to classify a failure and never logged or carried in
an error: it can quote the request, and the request names dates.
*/

import { AppError, isAppError } from "../lib/errors.ts";
import { noopLogger } from "../lib/log.ts";
import { computeDelayMs, parseRetryAfter } from "../lib/retry.ts";

import type { Logger } from "../lib/log.ts";

const API_BASE = "https://health.googleapis.com/v4/users/me/dataTypes";

/**
What the MCP tags this source's rows with, in the place a health system's id
goes: a `health_system` deny rule on it withholds every Google Health row,
and a `field` rule may be scoped to it.
*/
export const GOOGLE_HEALTH_SOURCE_ID = "google_health";
/** The display name those rows carry. */
export const GOOGLE_HEALTH_SOURCE_NAME = "Google Health";
/** What a metric's `resourceType` is prefixed with. */
export const GOOGLE_HEALTH_TYPE_PREFIX = "gh:";

/**
Only the Fitbit and Google trackers' own data: not values the owner typed in,
and not what other apps wrote through Health Connect (the phone path has
those already).
*/
const DATA_SOURCE_FAMILY = "users/me/dataSourceFamilies/google-wearables";

/** Read scope for SpO2, HRV, skin temperature and heart-rate zones. */
export const GOOGLE_HEALTH_METRICS_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly";
/** Read scope for VO2 max, active zone minutes and time in heart-rate zones. */
export const GOOGLE_HEALTH_ACTIVITY_SCOPE =
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";

/** Both, in the order the consent screen lists them. */
export const GOOGLE_HEALTH_SCOPES: readonly string[] = [
  GOOGLE_HEALTH_METRICS_SCOPE,
  GOOGLE_HEALTH_ACTIVITY_SCOPE,
];

/** The most days one `dailyRollUp` request may span for these types. */
const ROLLUP_MAX_DAYS = 90;
/** Data points per page of a `list`. The API allows up to 10000; a page of this is small. */
const LIST_PAGE_SIZE = 1000;
const ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;

/** One normalized value set. Numbers, short strings, booleans, or a zone list. */
export type GhValues = Readonly<Record<string, unknown>>;

/** One day of one metric. */
export interface GhDay {
  /** `YYYY-MM-DD`, the calendar date Google gives the value. */
  date: string;
  values: GhValues;
}

interface GhTypeBase {
  /** This app's name for the metric; the `gh:<Type>` a row is tagged with. */
  type: string;
  /** Google's data type id, the path segment. */
  dataType: string;
  /** The scope Google requires to read it. */
  scope: string;
}

/** A daily summary type, read with `list`. */
export interface GhDailyType extends GhTypeBase {
  kind: "daily";
  /** The snake_case name the `.date` filter uses. */
  filterField: string;
  /** The key the value sits under in a data point. */
  pointKey: string;
  normalize: (value: Record<string, unknown>) => GhValues | null;
}

/** An interval type, summed per day with `dailyRollUp`. */
export interface GhRollupType extends GhTypeBase {
  kind: "rollup";
  /** The key the day's sum sits under in a rollup point. */
  pointKey: string;
  normalize: (value: Record<string, unknown>) => GhValues | null;
}

export type GhType = GhDailyType | GhRollupType;

// --- reading values --------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A number from a double or an int64-as-string; undefined for anything else. */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A protobuf Duration (`"3600s"`, `"12.5s"`) as seconds. */
function durationSeconds(value: unknown): number | undefined {
  return typeof value !== "string" || !value.endsWith("s") ? undefined : num(value.slice(0, -1));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `{year, month, day}` as `YYYY-MM-DD`, or null when it is not a whole date. */
export function civilDate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const year = num(field(value, "year")) ?? 0;
  const month = num(field(value, "month")) ?? 0;
  const day = num(field(value, "day")) ?? 0;
  const whole = year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
  return whole ? `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` : null;
}

/** Keep only the keys that have a value; null when none does. */
function present(values: Record<string, unknown>): GhValues | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** An enum value as this app writes it: lower case, the unspecified value dropped. */
function enumWord(value: unknown, unspecified: string): string | undefined {
  return typeof value === "string" && value !== "" && value !== unspecified
    ? value.toLowerCase()
    : undefined;
}

const ZONE_UNSPECIFIED = "HEART_RATE_ZONE_TYPE_UNSPECIFIED";

// --- the metrics -----------------------------------------------------------

const DAILY_OXYGEN_SATURATION: GhDailyType = {
  kind: "daily",
  type: "DailyOxygenSaturation",
  dataType: "daily-oxygen-saturation",
  filterField: "daily_oxygen_saturation",
  pointKey: "dailyOxygenSaturation",
  scope: GOOGLE_HEALTH_METRICS_SCOPE,
  normalize: (value) =>
    present({
      averagePct: num(field(value, "averagePercentage")),
      lowerBoundPct: num(field(value, "lowerBoundPercentage")),
      upperBoundPct: num(field(value, "upperBoundPercentage")),
      stdDevPct: num(field(value, "standardDeviationPercentage")),
    }),
};

const DAILY_HEART_RATE_VARIABILITY: GhDailyType = {
  kind: "daily",
  type: "DailyHeartRateVariability",
  dataType: "daily-heart-rate-variability",
  filterField: "daily_heart_rate_variability",
  pointKey: "dailyHeartRateVariability",
  scope: GOOGLE_HEALTH_METRICS_SCOPE,
  normalize: (value) =>
    present({
      averageRmssdMs: num(field(value, "averageHeartRateVariabilityMilliseconds")),
      deepSleepRmssdMs: num(
        field(value, "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds"),
      ),
      nonRemHeartRateBpm: num(field(value, "nonRemHeartRateBeatsPerMinute")),
      entropy: num(field(value, "entropy")),
    }),
};

const DAILY_VO2_MAX: GhDailyType = {
  kind: "daily",
  type: "DailyVo2Max",
  dataType: "daily-vo2-max",
  filterField: "daily_vo2_max",
  pointKey: "dailyVo2Max",
  scope: GOOGLE_HEALTH_ACTIVITY_SCOPE,
  normalize: (value) => {
    const estimated = field(value, "estimated");
    return present({
      vo2Max: num(field(value, "vo2Max")),
      vo2MaxCovariance: num(field(value, "vo2MaxCovariance")),
      cardioFitnessLevel: enumWord(
        field(value, "cardioFitnessLevel"),
        "CARDIO_FITNESS_LEVEL_UNSPECIFIED",
      ),
      estimated: typeof estimated === "boolean" ? estimated : undefined,
    });
  },
};

const DAILY_SLEEP_TEMPERATURE: GhDailyType = {
  kind: "daily",
  type: "DailySleepTemperatureDerivations",
  dataType: "daily-sleep-temperature-derivations",
  filterField: "daily_sleep_temperature_derivations",
  pointKey: "dailySleepTemperatureDerivations",
  scope: GOOGLE_HEALTH_METRICS_SCOPE,
  normalize: (value) => {
    const nightly = num(field(value, "nightlyTemperatureCelsius"));
    const baseline = num(field(value, "baselineTemperatureCelsius"));
    return present({
      nightlyTempC: nightly,
      baselineTempC: baseline,
      // What Fitbit called the nightly relative temperature.
      nightlyDeltaC:
        nightly === undefined || baseline === undefined ? undefined : round(nightly - baseline, 3),
      relativeNightlyStddev30dC: num(field(value, "relativeNightlyStddev30dCelsius")),
    });
  },
};

const DAILY_HEART_RATE_ZONES: GhDailyType = {
  kind: "daily",
  type: "DailyHeartRateZones",
  dataType: "daily-heart-rate-zones",
  filterField: "daily_heart_rate_zones",
  pointKey: "dailyHeartRateZones",
  scope: GOOGLE_HEALTH_METRICS_SCOPE,
  normalize: (value) => {
    const zones = field(value, "heartRateZones");
    if (!Array.isArray(zones)) return null;
    const out = zones.filter(isRecord).flatMap((zone) => {
      const name = enumWord(field(zone, "heartRateZoneType"), ZONE_UNSPECIFIED);
      if (name === undefined) return [];
      const entry = present({
        zone: name,
        minBpm: num(field(zone, "minBeatsPerMinute")),
        maxBpm: num(field(zone, "maxBeatsPerMinute")),
      });
      return entry === null ? [] : [entry];
    });
    return out.length === 0 ? null : { zones: out };
  },
};

const ACTIVE_ZONE_MINUTES: GhRollupType = {
  kind: "rollup",
  type: "ActiveZoneMinutes",
  dataType: "active-zone-minutes",
  pointKey: "activeZoneMinutes",
  scope: GOOGLE_HEALTH_ACTIVITY_SCOPE,
  normalize: (value) => {
    const fatBurn = num(field(value, "sumInFatBurnHeartZone"));
    const cardio = num(field(value, "sumInCardioHeartZone"));
    const peak = num(field(value, "sumInPeakHeartZone"));
    const parts = [fatBurn, cardio, peak].filter((part) => part !== undefined);
    return present({
      fatBurnMin: fatBurn,
      cardioMin: cardio,
      peakMin: peak,
      totalMin: parts.length === 0 ? undefined : parts.reduce((sum, part) => sum + part, 0),
    });
  },
};

/** Zone enum -> the key its minutes go under. */
const TIME_IN_ZONE_KEYS = new Map([
  ["LIGHT", "lightMin"],
  ["MODERATE", "moderateMin"],
  ["VIGOROUS", "vigorousMin"],
  ["PEAK", "peakMin"],
]);

const TIME_IN_HEART_RATE_ZONE: GhRollupType = {
  kind: "rollup",
  type: "TimeInHeartRateZone",
  dataType: "time-in-heart-rate-zone",
  pointKey: "timeInHeartRateZone",
  scope: GOOGLE_HEALTH_ACTIVITY_SCOPE,
  normalize: (value) => {
    const zones = field(value, "timeInHeartRateZones");
    if (!Array.isArray(zones)) return null;
    const out = new Map<string, number>();
    for (const zone of zones) {
      if (!isRecord(zone)) continue;
      const name = field(zone, "heartRateZone");
      const key = typeof name === "string" ? TIME_IN_ZONE_KEYS.get(name) : undefined;
      const seconds = durationSeconds(field(zone, "duration"));
      if (key === undefined || seconds === undefined) continue;
      out.set(key, round((out.get(key) ?? 0) + seconds / 60, 2));
    }
    return out.size === 0 ? null : Object.fromEntries(out);
  },
};

/** The daily summaries, in the order the tool lists them. */
export const GH_DAILY_TYPES: readonly GhDailyType[] = [
  DAILY_OXYGEN_SATURATION,
  DAILY_HEART_RATE_VARIABILITY,
  DAILY_VO2_MAX,
  DAILY_SLEEP_TEMPERATURE,
  DAILY_HEART_RATE_ZONES,
];

/** The interval types read as daily sums. */
export const GH_ROLLUP_TYPES: readonly GhRollupType[] = [
  ACTIVE_ZONE_MINUTES,
  TIME_IN_HEART_RATE_ZONE,
];

/** Every metric this app reads from Google Health. */
export const GH_TYPES: readonly GhType[] = [...GH_DAILY_TYPES, ...GH_ROLLUP_TYPES];

/** Every metric's name, in `GH_TYPES` order. */
export const GH_TYPE_NAMES: readonly string[] = GH_TYPES.map((spec) => spec.type);

/** The metrics a granted scope string lets this app read. */
export function grantedTypes(scope: string | null): GhType[] {
  const parts = scope === null ? [] : scope.split(/\s+/u);
  const granted = new Set(parts.filter((part) => part !== ""));
  return GH_TYPES.filter((spec) => granted.has(spec.scope));
}

/** True when a scope string carries any Google Health read scope. */
export function hasHealthScope(scope: string | null): boolean {
  return grantedTypes(scope).length > 0;
}

// --- dates -------------------------------------------------------------------

/** `YYYY-MM-DD` plus `days`, in UTC. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  return { year, month, day };
}

// --- failures ------------------------------------------------------------------

/** The stable codes a Google Health failure is recorded under. */
type GoogleHealthReason =
  | "google_health_not_linked"
  | "google_health_scope_missing"
  | "google_health_api_disabled"
  | "google_health_unauthorized";

function failureFor(status: number, body: string, operation: string): AppError {
  const message = `google health ${operation}: HTTP ${String(status)}`;
  if (body.includes("ACCOUNT_NOT_LINKED")) {
    return new AppError("upstream_error", `${message} (account not linked)`, {
      status,
      reason: "google_health_not_linked" satisfies GoogleHealthReason,
    });
  }
  if (body.includes("SERVICE_DISABLED")) {
    return new AppError("upstream_error", `${message} (API not enabled)`, {
      status,
      reason: "google_health_api_disabled" satisfies GoogleHealthReason,
    });
  }
  if (status === 403) {
    return new AppError("upstream_auth", `${message} (scope not granted)`, {
      status,
      reason: "google_health_scope_missing" satisfies GoogleHealthReason,
    });
  }
  if (status === 401) {
    return new AppError("upstream_auth", `${message} after a forced refresh`, {
      status,
      reason: "google_health_unauthorized" satisfies GoogleHealthReason,
    });
  }
  const transient = status === 429 || status >= 500;
  return new AppError(transient ? "upstream_unavailable" : "upstream_error", message, { status });
}

/**
The stable code a failed read is recorded under: one of the Google Health
reasons above, else the error's own code (`needs_reauth`, `not_connected`,
`upstream_unavailable`, ...), else `internal`.
*/
export function googleHealthErrorCode(error: unknown): string {
  if (!isAppError(error)) return "internal";
  const reason = error.details?.reason;
  return typeof reason === "string" ? reason : error.code;
}

// --- the client ------------------------------------------------------------------

/** Resolves an access token; `forceRefresh` after a 401. The calendar's getter fits. */
type AccessTokenGetter = (options?: { forceRefresh?: boolean }) => Promise<string>;

export interface GoogleHealthClientOptions {
  getAccessToken: AccessTokenGetter;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface GoogleHealthClient {
  /**
  Every day of a daily summary type before `endExclusive`, and on or after
  `start` when one is given (none: the whole history). Pages to the end.
  */
  listDaily(
    spec: GhDailyType,
    range: { start: string | null; endExclusive: string },
  ): Promise<GhDay[]>;
  /** The daily sums of an interval type over [start, endExclusive), 90 days a request. */
  rollUpDaily(spec: GhRollupType, start: string, endExclusive: string): Promise<GhDay[]>;
}

interface PageBody {
  dataPoints?: unknown;
  rollupDataPoints?: unknown;
  nextPageToken?: unknown;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** One point per date: Google lists newest first, and the first one seen is kept. */
function byDate(days: readonly GhDay[], log: Logger, type: string): GhDay[] {
  const seen = new Map<string, GhDay>();
  let duplicates = 0;
  for (const day of days) {
    if (seen.has(day.date)) duplicates += 1;
    else seen.set(day.date, day);
  }
  if (duplicates > 0) log.info("google.health.duplicate_days", { type, duplicates });
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray() needs a lib newer than the ES2022 one this Worker compiles against (see `mergeCoverage` in `worker/src/mcp/coverage.ts`).
  const out: GhDay[] = [...seen.values()];
  // eslint-disable-next-line unicorn/no-array-sort -- `toSorted` is ES2023 and the Worker's lib is ES2022; `out` is local, so sorting in place is safe.
  return out.sort((left, right) => left.date.localeCompare(right.date));
}

/** A successful body, parsed. */
async function parseBody(response: Response, operation: string): Promise<PageBody> {
  const text = await readText(response);
  try {
    const parsed: unknown = JSON.parse(text === "" ? "{}" : text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new AppError("upstream_error", `google health ${operation}: response was not JSON`);
  }
}

/** Follow `nextPageToken` to the end. A token handed back twice is a loop, not more data. */
async function allPages(
  operation: string,
  fetchPage: (pageToken: string | null) => Promise<PageBody>,
): Promise<PageBody[]> {
  const out: PageBody[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (;;) {
    const page = await fetchPage(pageToken);
    out.push(page);
    const next = typeof page.nextPageToken === "string" ? page.nextPageToken : "";
    if (next === "") return out;
    if (seen.has(next)) {
      throw new AppError("upstream_error", `google health ${operation}: a page token repeated`);
    }
    seen.add(next);
    pageToken = next;
  }
}

/** The days in `list` pages. */
function listDays(pages: readonly PageBody[], spec: GhDailyType): GhDay[] {
  const days: GhDay[] = [];
  for (const page of pages) {
    const points: unknown[] = Array.isArray(page.dataPoints) ? page.dataPoints : [];
    for (const point of points) {
      const value = isRecord(point) ? field(point, spec.pointKey) : undefined;
      if (!isRecord(value)) continue;
      const date = civilDate(field(value, "date"));
      const values = spec.normalize(value);
      if (date !== null && values !== null) days.push({ date, values });
    }
  }
  return days;
}

/** One `dailyRollUp` point as a day, or null when it carries no date or no value. */
function rollupDay(point: unknown, spec: GhRollupType): GhDay | null {
  if (!isRecord(point)) return null;
  const civil = field(point, "civilStartTime");
  const date = isRecord(civil) ? civilDate(field(civil, "date")) : null;
  const value = field(point, spec.pointKey);
  const values = isRecord(value) ? spec.normalize(value) : null;
  return date === null || values === null ? null : { date, values };
}

/** The days in `dailyRollUp` pages. */
function rollupDays(pages: readonly PageBody[], spec: GhRollupType): GhDay[] {
  const days: GhDay[] = [];
  for (const page of pages) {
    const points: unknown[] = Array.isArray(page.rollupDataPoints) ? page.rollupDataPoints : [];
    for (const point of points) {
      const day = rollupDay(point, spec);
      if (day !== null) days.push(day);
    }
  }
  return days;
}

/** The [start, end) windows of at most `ROLLUP_MAX_DAYS` days that cover a range. */
function rollupWindows(start: string, endExclusive: string): [string, string][] {
  const windows: [string, string][] = [];
  for (let from = start; from < endExclusive;) {
    const capped = addDays(from, ROLLUP_MAX_DAYS);
    const to = capped < endExclusive ? capped : endExclusive;
    windows.push([from, to]);
    from = to;
  }
  return windows;
}

interface Sender {
  fetchImpl: typeof fetch;
  getAccessToken: AccessTokenGetter;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

/** One request, once. A network failure resolves to null. */
async function sendOnce(
  sender: Sender,
  url: string,
  body: unknown,
  forceRefresh: boolean,
): Promise<Response | null> {
  const token = await sender.getAccessToken(forceRefresh ? { forceRefresh: true } : undefined);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await sender.fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
One JSON call: a forced refresh after a 401, backoff on 429, 5xx and network
failures, nothing else retried.
*/
async function call(
  sender: Sender,
  operation: string,
  url: string,
  body?: unknown,
): Promise<PageBody> {
  const backoff = { baseDelayMs: 500, maxDelayMs: 8000, random: sender.random };
  let refreshed = false;
  let forceRefresh = false;
  let attempt = 0;
  for (;;) {
    const response = await sendOnce(sender, url, body, forceRefresh);
    forceRefresh = false;
    if (response?.ok === true) return parseBody(response, operation);
    const status = response?.status ?? 0;
    const text = response === null ? "" : await readText(response);
    if (status === 401 && !refreshed) {
      refreshed = true;
      forceRefresh = true;
      continue;
    }
    attempt += 1;
    const transient = status === 0 || status === 429 || status >= 500;
    if (transient && attempt < ATTEMPTS) {
      const header = response?.headers.get("retry-after") ?? null;
      await sender.sleep(
        computeDelayMs(attempt - 1, backoff, parseRetryAfter(header) ?? undefined),
      );
      continue;
    }
    sender.log.warn("google.health.request_failed", { operation, status });
    if (status === 0) {
      throw new AppError("upstream_unavailable", `google health ${operation}: request failed`);
    }
    throw failureFor(status, text, operation);
  }
}

export function createGoogleHealthClient(options: GoogleHealthClientOptions): GoogleHealthClient {
  const {
    getAccessToken,
    fetchImpl = fetch,
    logger: log = noopLogger,
    sleep = defaultSleep,
    random = Math.random,
  } = options;
  const sender: Sender = { fetchImpl, getAccessToken, log, sleep, random };

  return {
    async listDaily(spec, range) {
      const operation = `list ${spec.dataType}`;
      const upper = `${spec.filterField}.date < "${range.endExclusive}"`;
      const lower = range.start === null ? "" : `${spec.filterField}.date >= "${range.start}" AND `;
      const pages = await allPages(operation, (pageToken) => {
        const query = new URLSearchParams({
          filter: `${lower}${upper}`,
          pageSize: String(LIST_PAGE_SIZE),
          dataSourceFamily: DATA_SOURCE_FAMILY,
        });
        if (pageToken !== null) query.set("pageToken", pageToken);
        return call(
          sender,
          operation,
          `${API_BASE}/${spec.dataType}/dataPoints?${query.toString()}`,
        );
      });
      return byDate(listDays(pages, spec), log, spec.type);
    },

    async rollUpDaily(spec, start, endExclusive) {
      const operation = `rollup ${spec.dataType}`;
      const url = `${API_BASE}/${spec.dataType}/dataPoints:dailyRollUp`;
      const days: GhDay[] = [];
      for (const [from, to] of rollupWindows(start, endExclusive)) {
        const pages = await allPages(operation, (pageToken) =>
          call(sender, operation, url, {
            range: { start: { date: dateParts(from) }, end: { date: dateParts(to) } },
            windowSizeDays: 1,
            pageSize: ROLLUP_MAX_DAYS,
            dataSourceFamily: DATA_SOURCE_FAMILY,
            ...(pageToken !== null && { pageToken }),
          }),
        );
        days.push(...rollupDays(pages, spec));
      }
      return byDate(days, log, spec.type);
    },
  };
}
