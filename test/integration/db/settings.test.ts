import { beforeEach, describe, expect, it } from "vitest";

import { SETTING_DEFAULTS } from "../../../worker/db/schemas.ts";
import {
  FALLBACK_TIMEZONE,
  clearSyncBackoff,
  getAllSettings,
  getCalendarId,
  getSetting,
  getTimezone,
  isSyncBackedOff,
  resetTimezoneWarning,
  setSetting,
  setSettings,
  setSyncBackoff,
} from "../../../worker/db/settings.ts";
import { AppError } from "../../../worker/lib/errors.ts";

import { T0, clock, recordingLog, resetDb, testCtx } from "./helpers.ts";

beforeEach(resetDb);

describe("settings", () => {
  it("returns defaults for an empty table, without writing anything", async () => {
    const ctx = testCtx();

    expect(await getAllSettings(ctx)).toStrictEqual(SETTING_DEFAULTS);
    expect(await getSetting(ctx, "calendar_id")).toBe("primary");
    expect(await getCalendarId(ctx)).toBe("primary");
    expect(
      await ctx.db.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>(),
    ).toStrictEqual({ n: 0 });
  });

  it("round-trips a value of every stored type", async () => {
    const ctx = testCtx();

    await setSetting(ctx, "timezone", "Europe/Paris");
    await setSetting(ctx, "window_past_days", 30);
    await setSetting(ctx, "mcp_enabled", false);
    await setSetting(ctx, "default_color_id", null);

    expect(await getSetting(ctx, "timezone")).toBe("Europe/Paris");
    expect(await getSetting(ctx, "window_past_days")).toBe(30);
    expect(await getSetting(ctx, "mcp_enabled")).toBe(false);
    expect(await getSetting(ctx, "default_color_id")).toBeNull();
  });

  it("upserts rather than duplicating, and stamps updated_at from the clock", async () => {
    const time = clock();
    const ctx = testCtx({ now: time.now });

    await setSetting(ctx, "calendar_id", "first@group.calendar.example.test");
    time.advance(60);
    await setSetting(ctx, "calendar_id", "second@group.calendar.example.test");

    const row = await ctx.db
      .prepare("SELECT value_json, updated_at FROM settings WHERE key = 'calendar_id'")
      .first<{ value_json: string; updated_at: number }>();

    expect(row?.value_json).toBe('"second@group.calendar.example.test"');
    expect(row?.updated_at).toBe(T0 + 60);
    expect(
      await ctx.db.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>(),
    ).toStrictEqual({ n: 1 });
  });

  it("refuses an invalid value instead of storing it", async () => {
    const ctx = testCtx();

    await expect(setSetting(ctx, "window_past_days", -5)).rejects.toThrow(AppError);
    expect(await getSetting(ctx, "window_past_days")).toBe(90);
  });

  it("fills defaults around whatever rows exist", async () => {
    const ctx = testCtx();

    await setSetting(ctx, "ghost_color_id", "11");

    expect(await getAllSettings(ctx)).toStrictEqual({
      ...SETTING_DEFAULTS,
      ghost_color_id: "11",
    });
  });

  it("warns about a key it does not recognise and leaves the row alone", async () => {
    const { log, lines } = recordingLog();
    const ctx = testCtx({ log });
    await ctx.db
      .prepare(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('from_the_future', '1', 0)",
      )
      .run();

    expect(await getAllSettings(ctx)).toStrictEqual(SETTING_DEFAULTS);
    expect(lines.join("\n")).toContain("settings.unknown_key");
    expect(
      await ctx.db.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>(),
    ).toStrictEqual({ n: 1 });
  });
});

describe("setSettings", () => {
  it("writes several keys in one batch", async () => {
    const ctx = testCtx();

    await setSettings(ctx, { calendar_id: "primary", window_past_days: 14, mcp_enabled: false });

    expect(await getAllSettings(ctx)).toStrictEqual({
      ...SETTING_DEFAULTS,
      window_past_days: 14,
      mcp_enabled: false,
    });
  });

  it("validates everything before writing anything", async () => {
    // Half-applying a settings PUT is worse than rejecting it: the owner cannot
    // tell which half landed.
    const ctx = testCtx();

    await expect(setSettings(ctx, { calendar_id: "primary", ghost_color_id: "" })).rejects.toThrow(
      AppError,
    );
    expect(
      await ctx.db.prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>(),
    ).toStrictEqual({ n: 0 });
  });

  it("ignores keys that are absent rather than resetting them", async () => {
    const ctx = testCtx();

    await setSetting(ctx, "window_past_days", 7);
    await setSettings(ctx, { mcp_enabled: false });

    expect(await getSetting(ctx, "window_past_days")).toBe(7);
  });
});

describe("getTimezone", () => {
  it("returns the stored zone", async () => {
    const ctx = testCtx();

    await setSetting(ctx, "timezone", "Europe/Paris");

    expect(await getTimezone(ctx)).toBe("Europe/Paris");
  });

  it("falls back to UTC and warns once when nothing is stored", async () => {
    // There is deliberately no timezone default in source, so an unset zone is a
    // real state the app has to work in -- loudly, but only once per isolate.
    resetTimezoneWarning();
    const { log, lines } = recordingLog();
    const ctx = testCtx({ log });

    expect(await getTimezone(ctx)).toBe(FALLBACK_TIMEZONE);
    expect(await getTimezone(ctx)).toBe("UTC");
    expect(await getTimezone(ctx)).toBe("UTC");

    expect(lines.filter((line) => line.includes("settings.timezone_unset"))).toHaveLength(1);
  });
});

describe("the sync backoff", () => {
  it("is off until set, and expires by the clock rather than by a sweeper", async () => {
    const time = clock();
    const ctx = testCtx({ now: time.now });

    expect(await isSyncBackedOff(ctx)).toBe(false);

    await setSyncBackoff(ctx, T0 + 7200);

    expect(await isSyncBackedOff(ctx)).toBe(true);
    time.advance(7199);
    expect(await isSyncBackedOff(ctx)).toBe(true);
    time.advance(2);
    expect(await isSyncBackedOff(ctx)).toBe(false);
  });

  it("keeps the later of two backoffs, so a short one cannot shorten a long one", async () => {
    const ctx = testCtx();

    await setSyncBackoff(ctx, T0 + 7200);
    await setSyncBackoff(ctx, T0 + 60);

    expect(await getSetting(ctx, "sync_backoff_until")).toBe(T0 + 7200);
  });

  it("clears on demand", async () => {
    const ctx = testCtx();

    await setSyncBackoff(ctx, T0 + 7200);
    await clearSyncBackoff(ctx);

    expect(await isSyncBackedOff(ctx)).toBe(false);
    expect(await getSetting(ctx, "sync_backoff_until")).toBeNull();
  });
});
