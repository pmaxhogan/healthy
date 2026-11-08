// `/api/google-health` -- what the admin UI shows about the Google Health side of
// the Google grant (bookkeeping only, never a value), and the button that
// starts a read.

import { afterEach, describe, expect, it } from "vitest";

import { GOOGLE_HEALTH_SCOPES } from "../../../src/google/health.ts";

import { freshOwner, json, resetPorts, testRepos, usePorts } from "./helpers.ts";

import type { GoogleHealthDto } from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

function recordingSync(): unknown[] {
  const runs: unknown[] = [];
  usePorts({
    sync: {
      runCalendarSync: () => Promise.resolve({}),
      startFullRefresh: () => Promise.resolve({ started: true }),
      refreshConnectionToken: () => Promise.resolve({}),
      runGoogleHealthSync: (_ctx, options) => {
        runs.push(options);
        return Promise.resolve({});
      },
      getGoogleCalendarFor: () => Promise.reject(new Error("not used")),
      resolveReconnectAlert: () => Promise.resolve(),
    },
  });
  return runs;
}

describe("GET /api/google-health", () => {
  it("says nothing is granted before Google is connected", async () => {
    const dto = await json<GoogleHealthDto>(await owner().get("/api/google-health"));

    expect(dto.googleStatus).toBe("not_connected");
    expect(dto.granted).toBe(false);
    expect(dto.connectPath).toBe("/oauth/google/start?health=1");
    expect(dto.types.every((row) => !row.scopeGranted && row.days === 0)).toBe(true);
  });

  it("reports each metric's days and last read, and no value", async () => {
    const repos = testRepos();
    await repos.google.upsertTokens({
      accessToken: "access",
      accessExpiresAt: 2_000_000_000,
      refreshToken: "refresh",
      scope: GOOGLE_HEALTH_SCOPES.join(" "),
      status: "connected",
    });
    await repos.google.markConnected();
    await repos.googleHealth.replaceWindow(
      "DailyOxygenSaturation",
      [
        { date: "2026-03-01", values: { averagePct: 95.25 } },
        { date: "2026-03-02", values: { averagePct: 96.75 } },
      ],
      { start: null, endExclusive: "2026-03-03" },
    );
    await repos.googleHealth.recordAttempt("DailyOxygenSaturation", { ok: true, backfilled: true });
    await repos.googleHealth.recordAttempt("DailyVo2Max", {
      ok: false,
      code: "google_health_not_linked",
    });

    const response = await owner().get("/api/google-health");
    const body = await response.text();
    const dto = JSON.parse(body) as GoogleHealthDto;

    expect(dto.googleStatus).toBe("connected");
    expect(dto.granted).toBe(true);
    const spo2 = dto.types.find((row) => row.type === "DailyOxygenSaturation");
    expect(spo2).toMatchObject({
      scopeGranted: true,
      days: 2,
      firstDate: "2026-03-01",
      lastDate: "2026-03-02",
      lastErrorCode: null,
      historyRead: true,
    });
    expect(spo2?.lastOkAt).not.toBeNull();
    expect(dto.types.find((row) => row.type === "DailyVo2Max")?.lastErrorCode).toBe(
      "google_health_not_linked",
    );
    expect(body).not.toContain("95.25");
  });
});

describe("POST /api/google-health/sync", () => {
  it("starts a read after the response, recent or full", async () => {
    const runs = recordingSync();

    const recent = await owner().send("POST", "/api/google-health/sync");
    const full = await owner().send("POST", "/api/google-health/sync", { full: true });

    expect(recent.status).toBe(202);
    expect(full.status).toBe(202);
    expect(runs).toStrictEqual([{ full: false }, { full: true }]);
  });

  it("refuses an unknown field", async () => {
    recordingSync();

    const response = await owner().send("POST", "/api/google-health/sync", { everything: true });

    expect(response.status).toBe(400);
  });
});
