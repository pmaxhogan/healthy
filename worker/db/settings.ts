/**
 * Typed accessors over the `settings` table.
 *
 * Every read falls back to `SETTING_DEFAULTS` when the row is absent, so the app
 * works on a freshly migrated database with an empty table.
 *
 * `timezone` is the exception worth reading twice. It has no default in source --
 * a real one would disclose where the owner lives, which this repository must not
 * do -- so the stored value is the only correct answer. When it is unset,
 * `getTimezone` returns "UTC" and warns once per isolate: the sync still runs, and
 * its local-day window is simply a UTC day until the owner sets the zone in the UI.
 *
 * ### Sealed keys
 *
 * Four keys name the owner or where they get care, so their `value_json` is
 * sealed (padded, `v2:`) against `settings.value_json.<key>` rather than stored
 * as JSON: `calendar_id` (usually the owner's email address), `timezone` (where
 * they live), `mail_sender_allowlist` (the health systems' mail domains) and
 * `portal_api_base_path` (a portal deployment's path, which names the
 * organisation). No query filters or orders on a setting's value, so sealing
 * costs one decrypt per sealed key per read -- `getAllSettings` is one query and
 * at most four decrypts per run or request.
 */

import { all, batch, one, run } from "./client.ts";
import { aadFor, open, sealShort } from "./crypto.ts";
import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  encodeSetting,
  isSettingKey,
  parseSetting,
} from "./schemas.ts";

import type { Ctx } from "./client.ts";
import type { SettingRow } from "./rows.ts";
import type { SettingKey, Settings } from "./schemas.ts";

/** The zone used when nothing is stored. Not a default -- a last resort. */
export const FALLBACK_TIMEZONE = "UTC";

// Once per isolate, not once per call: the hourly sync would otherwise emit the
// same warning for every provider on every run. A one-field object rather than a
// bare `let`, because a module-level `let` reassigned from inside a function is
// exactly the pattern that makes state like this hard to find.
const warned = { timezone: false };

/** Reset the once-per-isolate warning latch. Tests only. */
export function resetTimezoneWarning(): void {
  warned.timezone = false;
}

/** The keys whose stored value is sealed. See the module comment. */
const SEALED_SETTING_KEYS: ReadonlySet<SettingKey> = new Set<SettingKey>([
  "calendar_id",
  "timezone",
  "mail_sender_allowlist",
  "portal_api_base_path",
]);

const settingAad = (key: string): string => aadFor("settings", "value_json", key);

/** `value_json` as stored: sealed for a sealed key, plain JSON otherwise. */
async function storedSettingValue<K extends SettingKey>(
  ctx: Pick<Ctx, "env">,
  key: K,
  value: Settings[K],
): Promise<string> {
  const json = encodeSetting(key, value);
  return SEALED_SETTING_KEYS.has(key) ? sealShort(ctx.env, json, settingAad(key)) : json;
}

/** The inverse: opens a sealed key's value and parses it. */
async function readStored<K extends SettingKey>(
  ctx: Pick<Ctx, "env">,
  key: K,
  stored: string,
): Promise<Settings[K]> {
  const json = SEALED_SETTING_KEYS.has(key) ? await open(ctx.env, stored, settingAad(key)) : stored;
  return parseSetting(key, json);
}

export async function getSetting<K extends SettingKey>(ctx: Ctx, key: K): Promise<Settings[K]> {
  const row = await one<Pick<SettingRow, "value_json">>(
    ctx.db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key),
  );
  // `SETTING_DEFAULTS[key]`: `K extends SettingKey`, so the index is one of a
  // closed set of literals checked at compile time -- not a sink.
  return row === null ? SETTING_DEFAULTS[key] : readStored(ctx, key, row.value_json);
}

export async function setSetting<K extends SettingKey>(
  ctx: Ctx,
  key: K,
  value: Settings[K],
): Promise<void> {
  await run(
    ctx.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .bind(key, await storedSettingValue(ctx, key, value), ctx.now()),
  );
}

/** Every setting, defaults filled in for the rows that are not there. */
export async function getAllSettings(ctx: Ctx): Promise<Settings> {
  const rows = await all<SettingRow>(ctx.db.prepare("SELECT * FROM settings"));
  const settings: Settings = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (!isSettingKey(row.key)) {
      // A key no version of the code knows: left in place, not deleted, but not
      // guessed at either.
      ctx.log.warn("settings.unknown_key", { settingKey: row.key });
      continue;
    }
    assign(settings, row.key, await readStored(ctx, row.key, row.value_json));
  }
  return settings;
}

/**
 * Write several settings at once, validating all of them before writing any.
 *
 * That ordering is what stops a half-applied PUT /api/settings: one bad field
 * rejects the whole payload.
 */
export async function setSettings(ctx: Ctx, values: Partial<Settings>): Promise<void> {
  const at = ctx.now();
  const statements: D1PreparedStatement[] = [];
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    // `Object.hasOwn` does not narrow Partial<Settings>[K] to Settings[K]; the
    // guard above is the proof, and `encodeSetting` validates the value anyway.
    const value = values[key] as Settings[typeof key];
    statements.push(
      ctx.db
        .prepare(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        )
        .bind(key, await storedSettingValue(ctx, key, value), at),
    );
  }
  await batch(ctx.db, statements);
}

/**
 * The display and windowing zone.
 *
 * Returns the stored value, or "UTC" with a one-time warning when nothing is
 * stored. Never a guess at the owner's real zone.
 */
export async function getTimezone(ctx: Ctx): Promise<string> {
  const stored = await getSetting(ctx, "timezone");
  if (stored !== null) return stored;
  if (!warned.timezone) {
    warned.timezone = true;
    ctx.log.warn("settings.timezone_unset", { using: FALLBACK_TIMEZONE });
  }
  return FALLBACK_TIMEZONE;
}

/** The calendar the sync writes to. */
export async function getCalendarId(ctx: Ctx): Promise<string> {
  return getSetting(ctx, "calendar_id");
}

/** True when a 429 backoff is still in force at `ctx.now()`. */
export async function isSyncBackedOff(ctx: Ctx): Promise<boolean> {
  const until = await getSetting(ctx, "sync_backoff_until");
  return until !== null && until > ctx.now();
}

/** Back every sync off until `until` (a unix second), keeping the later of the two. */
export async function setSyncBackoff(ctx: Ctx, until: number): Promise<void> {
  const current = await getSetting(ctx, "sync_backoff_until");
  await setSetting(ctx, "sync_backoff_until", Math.max(until, current ?? 0));
}

/** Clear the backoff, e.g. when the owner presses "sync now". */
export async function clearSyncBackoff(ctx: Ctx): Promise<void> {
  await setSetting(ctx, "sync_backoff_until", null);
}

/**
 * Write one key of `Settings` without widening the whole object to `any`.
 *
 * `settings[key] = value` does not narrow for a generic K, because TypeScript
 * cannot prove the value matches the slot it is going into; the generic here is
 * what supplies that proof.
 */
function assign<K extends SettingKey>(settings: Settings, key: K, value: Settings[K]): void {
  settings[key] = value;
}
