/**
 * The Health Connect lines of `get_health_summary`: for each paired phone,
 * when it last uploaded, its newest blood-pressure reading and last night's
 * sleep. Enough to tell a model the phone data exists and is current, and
 * which tool to call for more; never a second copy of those tools.
 *
 * Phone data stays separate from the health systems' records: these are items
 * of their own (`kind: "phone"`), tagged `device:<id>` and `hc:<Type>` so the
 * exposure policy reaches them like any other, and nothing here is merged into
 * the FHIR sections.
 */

import { deviceStatus, hoursSince } from "../../hc/coverage.ts";
import { dedupeBloodPressure } from "../../hc/rules.ts";
import { recordStartMs } from "../../hc/wire.ts";

import { groupSessions } from "./sessions.ts";
import {
  availabilityByType,
  beginHcCall,
  coverageResourceType,
  deviceCoverageFor,
  deviceSourceId,
  rowTags,
  typeAllowed,
} from "./sources.ts";
import { HOUR_MS, SECOND_MS } from "./time.ts";

import type { HcDevice } from "./reads.ts";
import type { HcCall } from "./sources.ts";
import type { PolicyRules } from "../../policy/rules.ts";
import type { CoverageEntry } from "../coverage.ts";
import type { ToolDeps } from "../deps.ts";

const TYPE_BLOOD_PRESSURE = "BloodPressure";
const TYPE_SLEEP = "SleepSession";

/**
 * "Last night" is looked for among the sleep that ended within this long
 * before now: the stretch that ended on the latest local date, and the longest
 * of those when several ended that day.
 */
const LAST_NIGHT_WINDOW_MS = 36 * HOUR_MS;

export interface PhoneSummary {
  items: Record<string, unknown>[];
  coverage: CoverageEntry[];
  /** `device:<id>` of every phone read, for the audit row. */
  sourceIds: string[];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function latestPressure(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
): Promise<Record<string, unknown> | null> {
  const rows = await deps.hc.syncRows(device.id);
  const lastMs = rows.find((row) => row.recordType === TYPE_BLOOD_PRESSURE)?.lastMs ?? null;
  if (lastMs === null) return null;
  const records = await deps.hc.records({
    deviceId: device.id,
    type: TYPE_BLOOD_PRESSURE,
    startMs: lastMs,
    endMs: lastMs + 1,
  });
  const newest = dedupeBloodPressure(records).kept.at(-1);
  if (newest === undefined) return null;
  return {
    kind: "phone",
    section: "latest_blood_pressure",
    healthSystem: device.name,
    ...rowTags(device, TYPE_BLOOD_PRESSURE),
    time: call.clock.iso(recordStartMs(newest)),
    systolic: finite(newest.data.systolic),
    diastolic: finite(newest.data.diastolic),
    origin: newest.origin,
  };
}

async function lastNight(
  deps: ToolDeps,
  call: HcCall,
  device: HcDevice,
): Promise<Record<string, unknown> | null> {
  const nights = await deps.hc.sleepNights({
    deviceId: device.id,
    startMs: call.nowMs - LAST_NIGHT_WINDOW_MS,
    endMs: call.nowMs,
  });
  const groups = groupSessions(
    TYPE_SLEEP,
    nights.map(({ id, night }) => ({ id, summary: night })),
  );
  // The window is a day and a half, so it can hold two nights. "Last night" is
  // the one that ended on the LATEST local date, not the longest of the two;
  // length only chooses among the stretches that ended on that date, where a
  // nap after the night is not "last night".
  const endDay = (group: (typeof groups)[number]): string =>
    call.clock.day(group.primary.summary.endMs);
  let main = groups[0];
  for (const group of groups) {
    if (main === undefined) break;
    // ISO dates order as text.
    const [ended, best] = [endDay(group), endDay(main)];
    const longer = group.primary.summary.asleepMin > main.primary.summary.asleepMin;
    if (ended > best || (ended === best && longer)) main = group;
  }
  if (main === undefined) return null;
  const night = main.primary.summary;
  return {
    kind: "phone",
    section: "last_night_sleep",
    healthSystem: device.name,
    ...rowTags(device, TYPE_SLEEP),
    date: call.clock.day(night.endMs),
    start: call.clock.iso(night.startMs),
    end: call.clock.iso(night.endMs),
    inBedMin: night.inBedMin,
    asleepMin: night.asleepMin,
    origin: night.origin,
  };
}

/** The summary's phone items, for the phones `wanted` selects (all when omitted). */
export async function phoneSummary(
  deps: ToolDeps,
  run: { rules: PolicyRules; now: number },
  wanted: readonly string[] | undefined,
): Promise<PhoneSummary> {
  const call = await beginHcCall(deps, run, {
    devices: wanted === undefined ? undefined : [...wanted],
  });
  // Only what the phone holds: the summary asks for nothing by name.
  const coverage = await deviceCoverageFor(deps, call, {
    types: [TYPE_BLOOD_PRESSURE, TYPE_SLEEP],
  });
  const items: Record<string, unknown>[] = [];
  for (const device of call.devices) {
    const availability = availabilityByType(coverage, device.id);
    items.push({
      kind: "phone",
      section: "sync",
      healthSystem: device.name,
      healthSystemId: deviceSourceId(device.id),
      status: deviceStatus(device, call.now),
      // In the answer's zone, with its offset, like every other phone instant.
      lastUploadAt: call.clock.isoOrNull(
        device.lastUploadAt === null ? null : device.lastUploadAt * SECOND_MS,
      ),
      hoursSinceUpload:
        device.lastUploadAt === null ? null : hoursSince(call.now, device.lastUploadAt),
    });
    const readable = (type: string): boolean =>
      typeAllowed(call.rules, type) && availability.has(coverageResourceType(type));
    const pressure = readable(TYPE_BLOOD_PRESSURE)
      ? await latestPressure(deps, call, device)
      : null;
    if (pressure !== null) items.push(pressure);
    const sleep = readable(TYPE_SLEEP) ? await lastNight(deps, call, device) : null;
    if (sleep !== null) items.push(sleep);
  }
  return {
    items,
    coverage,
    sourceIds: call.devices.map((device) => deviceSourceId(device.id)),
  };
}
