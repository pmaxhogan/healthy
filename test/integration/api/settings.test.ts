// `GET` and `PUT /api/settings`.
//
// The timezone is what this file mostly guards. It has no default in source, the
// sync's local-day window is computed from it, and a value that formats but is not a
// zone would be stored happily by a naive check -- so the rejection cases matter
// more than the acceptance ones.

import { describe, expect, it } from "vitest";

import { getAllSettings } from "../../../worker/db/settings.ts";

import { freshOwner, json, testCtx } from "./helpers.ts";

import type { ApiError, SettingsDto } from "@shared/types.ts";

const owner = freshOwner();

describe("GET /api/settings", () => {
  it("answers with the defaults on a freshly migrated database", async () => {
    const dto = await json<SettingsDto>(await owner().get("/api/settings"));

    expect(dto).toStrictEqual({
      // No default in source: a real one would disclose where the owner lives.
      timezone: null,
      calendarId: "primary",
      defaultTitleTemplate: "{visitType} · {practitioner}",
      defaultColorId: null,
      ghostColorId: "8",
      defaultArrivalOffsetMin: 0,
      windowPastDays: 90,
      syncBackoffUntil: null,
      mcpEnabled: true,
      portalLoginAttemptLimit: 3,
      portalApiBasePath: null,
    });
  });

  it("is never cached", async () => {
    const response = await owner().get("/api/settings");

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("PUT /api/settings", () => {
  it("stores a patch and answers with the stored state", async () => {
    const response = await owner().send("PUT", "/api/settings", {
      timezone: "Europe/London",
      windowPastDays: 30,
      mcpEnabled: false,
    });

    expect(response.status).toBe(200);
    const dto = await json<SettingsDto>(response);
    expect(dto.timezone).toBe("Europe/London");
    expect(dto.windowPastDays).toBe(30);
    expect(dto.mcpEnabled).toBe(false);
    // Untouched keys keep their defaults.
    expect(dto.calendarId).toBe("primary");

    const stored = await getAllSettings(testCtx());
    expect(stored.timezone).toBe("Europe/London");
    expect(stored.window_past_days).toBe(30);
  });

  it("accepts an empty patch as a no-op", async () => {
    const response = await owner().send("PUT", "/api/settings", {});
    expect(response.status).toBe(200);
  });

  it("rejects a timezone that is not a zone, and writes nothing", async () => {
    await owner().send("PUT", "/api/settings", { timezone: "Europe/London" });

    const response = await owner().send("PUT", "/api/settings", {
      timezone: "Mars/Phobos",
      windowPastDays: 7,
    });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(400);
    expect(body.error).toBe("bad_request");
    // The whole payload is rejected: the valid field alongside it must not land.
    const stored = await getAllSettings(testCtx());
    expect(stored.timezone).toBe("Europe/London");
    expect(stored.window_past_days).toBe(90);
  });

  it("rejects a fixed offset, which has no daylight-saving rules", async () => {
    const response = await owner().send("PUT", "/api/settings", { timezone: "+05:00" });
    expect(response.status).toBe(400);
  });

  it("unsets the timezone with an explicit null", async () => {
    await owner().send("PUT", "/api/settings", { timezone: "Europe/London" });

    const dto = await json<SettingsDto>(
      await owner().send("PUT", "/api/settings", { timezone: null }),
    );

    expect(dto.timezone).toBeNull();
  });

  it("rejects an unknown key rather than silently dropping it", async () => {
    const response = await owner().send("PUT", "/api/settings", { tiemzone: "UTC" });

    const body = await json<ApiError>(response);
    expect(response.status).toBe(400);
    expect(JSON.stringify(body.details)).toContain("unrecognized");
  });

  it("rejects an out-of-range window and an empty calendar id", async () => {
    const window = await owner().send("PUT", "/api/settings", { windowPastDays: 5000 });
    const calendar = await owner().send("PUT", "/api/settings", { calendarId: "" });

    expect(window.status).toBe(400);
    expect(calendar.status).toBe(400);
  });

  it("ignores syncBackoffUntil, which only the sync engine owns", async () => {
    // The SPA round-trips the whole DTO, so the field has to be accepted -- but a
    // stale form must not be able to re-impose a backoff that had expired.
    const response = await owner().send("PUT", "/api/settings", {
      syncBackoffUntil: "2030-01-01T00:00:00.000Z",
    });

    const dto = await json<SettingsDto>(response);
    const stored = await getAllSettings(testCtx());

    expect(response.status).toBe(200);
    expect(dto.syncBackoffUntil).toBeNull();
    expect(stored.sync_backoff_until).toBeNull();
  });

  it("renders a stored backoff as an ISO instant", async () => {
    await testCtx()
      .db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)")
      .bind("sync_backoff_until", "1893456000", 0)
      .run();

    const dto = await json<SettingsDto>(await owner().get("/api/settings"));

    expect(dto.syncBackoffUntil).toBe("2030-01-01T00:00:00.000Z");
  });
});
