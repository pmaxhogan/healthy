import { describe, expect, it } from "vitest";

import {
  isoFromMs,
  toDeviceCoverageRowDto,
  toDeviceDto,
  toDeviceIngestSummaryDto,
} from "../../../src/api/dto.ts";

describe("isoFromMs", () => {
  it("formats an instant", () => {
    expect(isoFromMs(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("is null for null and for anything that is not a representable instant", () => {
    for (const bad of [null, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, -8.64e15 - 1]) {
      expect(isoFromMs(bad)).toBeNull();
    }
  });
});

describe("device projections are total", () => {
  const device = {
    id: "d",
    name: "n",
    createdAt: 1_790_000_000,
    rotatedAt: Number.MAX_SAFE_INTEGER,
    revokedAt: null,
    lastSeenAt: NaN,
    lastUploadAt: null,
    appVersion: null,
  };

  it("maps bad stored seconds to null and a revoked, never-uploaded phone to revoked", () => {
    const dto = toDeviceDto({
      device: { ...device, revokedAt: 1_790_000_100 },
      now: 1_790_001_000,
      queue: { batches: 0, bytes: 0 },
      parked: { batches: 0, bytes: 0, errorCodes: [] },
      parkedMarks: 0,
      report: null,
      totals: { recordCount: 0, typesGranted: 0, typesDenied: 0, typesBackfilled: 0 },
    });

    expect(dto.rotatedAt).toBeNull();
    expect(dto.lastSeenAt).toBeNull();
    expect(dto.status).toBe("revoked");
  });

  it("maps bad stored milliseconds in a coverage row to null", () => {
    const dto = toDeviceCoverageRowDto(
      {
        recordType: "Steps",
        permissionState: "granted",
        firstMs: Number.MAX_SAFE_INTEGER,
        lastMs: NaN,
        recordCount: 1,
        lastUploadAt: null,
        tokenAgeS: null,
        backlog: null,
        backfillComplete: false,
        backfillOldestMs: Infinity,
      },
      { status: "ok" },
    );

    expect([dto.firstAt, dto.lastAt, dto.backfillOldestAt]).toStrictEqual([null, null, null]);
  });
});

describe("toDeviceIngestSummaryDto", () => {
  const summary = {
    queued: 132,
    applying: 1,
    applied: 40,
    failed: 2,
    appliedRecently: 12,
    lastAppliedAt: 1_790_000_000,
    applyMsMedian: 1800,
    applySample: 20,
  };

  it("totals the states, carries the parked count and formats the instant", () => {
    expect(toDeviceIngestSummaryDto(summary, 2)).toStrictEqual({
      total: 175,
      queued: 132,
      applying: 1,
      applied: 40,
      failed: 2,
      parked: 2,
      appliedLastHour: 12,
      lastAppliedAt: "2026-09-21T14:13:20.000Z",
      applyMsMedian: 1800,
      applySample: 20,
    });
  });

  it("is total over a log with nothing applied and a bad stored instant", () => {
    const empty = { ...summary, applied: 0, appliedRecently: 0, applyMsMedian: null };

    expect(toDeviceIngestSummaryDto({ ...empty, lastAppliedAt: null }, 0).lastAppliedAt).toBeNull();
    expect(toDeviceIngestSummaryDto({ ...empty, lastAppliedAt: NaN }, 0).lastAppliedAt).toBeNull();
  });
});
