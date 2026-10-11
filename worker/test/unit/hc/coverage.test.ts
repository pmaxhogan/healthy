import { describe, expect, it } from "vitest";

import {
  HC_STALE_AFTER_SECONDS,
  coverageResourceType,
  deviceCoverage,
  deviceSourceId,
  deviceStatus,
} from "../../../src/hc/coverage.ts";

import type { CoverageSyncRow } from "../../../src/hc/coverage.ts";

const NOW = 1_790_000_000;
const DEVICE = { id: "DEV1", name: "Example phone", revokedAt: null, lastUploadAt: NOW - 60 };

function row(overrides: Partial<CoverageSyncRow> = {}): CoverageSyncRow {
  return {
    recordType: "HeartRate",
    permissionState: "granted",
    recordCount: 42,
    lastUploadAt: NOW - 60,
    ...overrides,
  };
}

/** The device's status when its last upload was `age` seconds ago. */
function statusAfter(age: number) {
  return deviceStatus({ revokedAt: null, lastUploadAt: NOW - age }, NOW);
}

function only(entries: ReturnType<typeof deviceCoverage>) {
  expect(entries).toHaveLength(1);
  const [entry] = entries;
  if (entry === undefined) throw new Error("no entry");
  return entry;
}

/** The one coverage entry of a granted type whose device last uploaded `age` seconds ago. */
function entryAfter(age: number) {
  return only(
    deviceCoverage({ device: { ...DEVICE, lastUploadAt: NOW - age }, rows: [row()], now: NOW }),
  );
}

describe("deviceStatus", () => {
  it("is never before the first upload and active after it", () => {
    expect(deviceStatus({ revokedAt: null, lastUploadAt: null }, NOW)).toBe("never");
    expect(deviceStatus({ revokedAt: null, lastUploadAt: NOW }, NOW)).toBe("active");
  });

  it("reads a revoked phone that never uploaded as revoked", () => {
    expect(deviceStatus({ revokedAt: NOW - 1, lastUploadAt: null }, NOW)).toBe("revoked");
  });

  it("is revoked whatever else is true", () => {
    expect(deviceStatus({ revokedAt: NOW - 1, lastUploadAt: NOW }, NOW)).toBe("revoked");
    expect(deviceStatus({ revokedAt: NOW - 1, lastUploadAt: null }, NOW)).toBe("revoked");
  });

  it("turns stale one second after six hours, not at six hours", () => {
    expect(HC_STALE_AFTER_SECONDS).toBe(6 * 3600);
    expect(statusAfter(HC_STALE_AFTER_SECONDS - 1)).toBe("active");
    expect(statusAfter(HC_STALE_AFTER_SECONDS)).toBe("active");
    expect(statusAfter(HC_STALE_AFTER_SECONDS + 1)).toBe("stale");
  });
});

describe("deviceCoverage", () => {
  it("joins the MCP coverage array under device:<id> and hc:<Type>", () => {
    const entry = only(deviceCoverage({ device: DEVICE, rows: [row()], now: NOW }));

    expect(entry.healthSystemId).toBe("device:DEV1");
    expect(entry.healthSystemId).toBe(deviceSourceId("DEV1"));
    expect(entry.healthSystem).toBe("Example phone");
    expect(entry.resourceType).toBe("hc:HeartRate");
    expect(entry.resourceType).toBe(coverageResourceType("HeartRate"));
  });

  it("reports a granted type with data as ok", () => {
    const entry = only(deviceCoverage({ device: DEVICE, rows: [row()], now: NOW }));

    expect(entry.status).toBe("ok");
    expect(entry.recordCount).toBe(42);
    expect(entry.lastOkAt).toBe(new Date((NOW - 60) * 1000).toISOString());
  });

  it("reports a granted type with no records as ok with a zero count: permitted, no data", () => {
    const entry = only(
      deviceCoverage({ device: DEVICE, rows: [row({ recordCount: 0 })], now: NOW }),
    );

    expect(entry.status).toBe("ok");
    expect(entry.recordCount).toBe(0);
  });

  it("calls a denied type unsupported, with a notice saying it is not permitted", () => {
    const entry = only(
      deviceCoverage({ device: DEVICE, rows: [row({ permissionState: "denied" })], now: NOW }),
    );

    expect(entry.status).toBe("unsupported");
    expect(entry.notices?.[0]?.meaning).toContain("not permitted");
    expect(entry.recordCount).toBeUndefined();
  });

  it("calls an unavailable type unsupported, with a notice saying it is not available on this phone", () => {
    const entry = only(
      deviceCoverage({
        device: DEVICE,
        rows: [row({ permissionState: "unavailable" })],
        now: NOW,
      }),
    );

    expect(entry.status).toBe("unsupported");
    expect(entry.notices?.[0]?.meaning).toContain("not available on this phone");
  });

  it("keeps a denied type unsupported even when the device is stale or revoked", () => {
    const revoked = { ...DEVICE, revokedAt: NOW - 5 };

    const entry = only(
      deviceCoverage({ device: revoked, rows: [row({ permissionState: "denied" })], now: NOW }),
    );

    expect(entry.status).toBe("unsupported");
  });

  it("turns stale exactly after six hours without an upload", () => {
    expect(entryAfter(HC_STALE_AFTER_SECONDS).status).toBe("ok");
    const stale = entryAfter(HC_STALE_AFTER_SECONDS + 1);
    expect(stale.status).toBe("stale");
    expect(stale.ageHours).toBe(6);
    expect(stale.recordCount).toBe(42);
  });

  it("reports ageHours rounded down", () => {
    const entry = only(
      deviceCoverage({
        device: { ...DEVICE, lastUploadAt: NOW - (9 * 3600 + 3599) },
        rows: [row()],
        now: NOW,
      }),
    );

    expect(entry.ageHours).toBe(9);
  });

  it("calls every type of a revoked device stale, however fresh its last upload", () => {
    const entry = only(
      deviceCoverage({ device: { ...DEVICE, revokedAt: NOW - 5 }, rows: [row()], now: NOW }),
    );

    expect(entry.status).toBe("stale");
  });

  it("is never for a row whose permission has not been reported", () => {
    const entry = only(
      deviceCoverage({ device: DEVICE, rows: [row({ permissionState: "unknown" })], now: NOW }),
    );

    expect(entry.status).toBe("never");
  });

  it("calls a revoked phone that never uploaded stale, not never", () => {
    const entry = only(
      deviceCoverage({
        device: { ...DEVICE, lastUploadAt: null, revokedAt: NOW - 5 },
        rows: [row({ lastUploadAt: null })],
        now: NOW,
      }),
    );

    expect(entry.status).toBe("stale");
  });

  it("never produces a row for ExerciseRoute, reported or expected", () => {
    const entries = deviceCoverage({
      device: DEVICE,
      rows: [row({ recordType: "ExerciseRoute" }), row()],
      now: NOW,
      expectedTypes: ["ExerciseRoute"],
    });

    expect(entries.map((entry) => entry.resourceType)).toStrictEqual(["hc:HeartRate"]);
  });

  it("is never for a device that has not uploaded", () => {
    const entry = only(
      deviceCoverage({
        device: { ...DEVICE, lastUploadAt: null },
        rows: [row({ lastUploadAt: null })],
        now: NOW,
      }),
    );

    expect(entry.status).toBe("never");
  });

  it("reports expected types the phone has not sent a row for as never, sorted with the rest", () => {
    const entries = deviceCoverage({
      device: DEVICE,
      rows: [row({ recordType: "Steps" })],
      now: NOW,
      expectedTypes: ["Weight", "HeartRate", "Steps"],
    });

    expect(entries.map((entry) => [entry.resourceType, entry.status])).toStrictEqual([
      ["hc:HeartRate", "never"],
      ["hc:Steps", "ok"],
      ["hc:Weight", "never"],
    ]);
  });
});
