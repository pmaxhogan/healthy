// `sync_health_systems`: the one tool that acts, and every way it says no.
//
// Driven over the SDK's in-memory transport against the real `McpServer`, the
// real schema and the real decision (`worker/src/mcp/sync-request.ts`); only
// the sync engine behind `ToolDeps.sync` is faked, and the fake records every
// run a call would have queued. So "nothing was started" below is a fact about
// what reached the engine, not about what the answer claimed.
//
// Every health system here is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { previewDraft, sampleStructure } from "../../../src/mcp/policy-sample.ts";
import { SYNC_LIMITS, decideSync } from "../../../src/mcp/sync-request.ts";
import { buildRules } from "../../../src/policy/rules.ts";

import {
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  NAME_A,
  NAME_B,
  NOW,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { HealthSystemInfo } from "../../../src/mcp/deps.ts";
import type { SyncFacts } from "../../../src/mcp/sync-request.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const TOOL = "sync_health_systems";

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

/** Change one of the two fake health systems in place. */
function patch(id: string, change: Partial<HealthSystemInfo>): void {
  world.state.healthSystems = world.state.healthSystems.map((healthSystem) =>
    healthSystem.id === id ? { ...healthSystem, ...change } : healthSystem,
  );
}

/** The fake world's default portal account, with some fields changed. */
function portal(change: Partial<NonNullable<HealthSystemInfo["portal"]>>) {
  return {
    state: "active" as const,
    hasCredentials: true,
    lastOkAt: NOW - 3600,
    lastErrorCode: null,
    needsReauthSince: null,
    ...change,
  };
}

/** Whether anything at all reached the sync engine. */
function nothingStarted(): boolean {
  const { sync } = world.state;
  return sync.calendarStarts.length === 0 && sync.fullStarts.length === 0;
}

/** One item of an answer, by health system id. */
function row(
  items: readonly Record<string, unknown>[],
  healthSystemId: string,
): Record<string, unknown> {
  const found = items.find((item) => item.healthSystemId === healthSystemId);
  if (found === undefined) throw new Error(`no row for ${healthSystemId}`);
  return found;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe("saying which health systems", () => {
  it("refuses a call that names none and does not say all", async () => {
    const answer = await callTool(world.client, TOOL, { kind: "ordinary" });

    expect(answer.isError).toBe(true);
    expect(answer.error).toBe("invalid_target");
    expect(nothingStarted()).toBe(true);
  });

  it("refuses `all: false` with no names, rather than reading it as everything", async () => {
    const answer = await callTool(world.client, TOOL, { kind: "ordinary", all: false });

    expect(answer.error).toBe("invalid_target");
    expect(nothingStarted()).toBe(true);
  });

  it("refuses a call that both names some and says all", async () => {
    const answer = await callTool(world.client, TOOL, {
      kind: "ordinary",
      all: true,
      healthSystems: [HEALTH_SYSTEM_A],
    });

    expect(answer.error).toBe("invalid_target");
    expect(nothingStarted()).toBe(true);
  });

  it("refuses an empty list of names at the schema", async () => {
    const answer = await callTool(world.client, TOOL, { kind: "ordinary", healthSystems: [] });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Invalid arguments");
    expect(nothingStarted()).toBe(true);
  });

  it("syncs only the health system named, by id or by a piece of its name", async () => {
    const byId = await callTool(world.client, TOOL, {
      kind: "ordinary",
      healthSystems: [HEALTH_SYSTEM_A],
    });
    const byName = await callTool(world.client, TOOL, { kind: "full", healthSystems: ["other"] });

    expect(byId.items.map((item) => item.healthSystemId)).toStrictEqual([HEALTH_SYSTEM_A]);
    expect(byName.items.map((item) => item.healthSystem)).toStrictEqual([NAME_B]);
    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_A], portalOnly: false },
    ]);
    expect(world.state.sync.fullStarts).toStrictEqual([HEALTH_SYSTEM_B]);
  });

  it("answers no rows, and says so, when the name matches nothing", async () => {
    const answer = await callTool(world.client, TOOL, {
      kind: "ordinary",
      healthSystems: ["no such place"],
    });

    expect(answer.isError).toBe(false);
    expect(answer.items).toStrictEqual([]);
    expect(answer.warnings).toContain("no_health_system_matched");
    expect(nothingStarted()).toBe(true);
  });
});

describe("saying which sync", () => {
  it("has no default kind: a call without one is refused at the schema", async () => {
    const answer = await callTool(world.client, TOOL, { all: true });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Invalid arguments");
    expect(nothingStarted()).toBe(true);
  });

  it("refuses a kind it does not know", async () => {
    const answer = await callTool(world.client, TOOL, { all: true, kind: "everything" });

    expect(answer.isError).toBe(true);
    expect(nothingStarted()).toBe(true);
  });

  it("queues the ordinary sync as one calendar run over every health system", async () => {
    const answer = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(answer.items.map((item) => item.outcome)).toStrictEqual(["started", "started"]);
    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_A, HEALTH_SYSTEM_B], portalOnly: false },
    ]);
    expect(world.state.sync.fullStarts).toStrictEqual([]);
  });

  it("queues a full refresh per health system, and only when full was asked for", async () => {
    const answer = await callTool(world.client, TOOL, { all: true, kind: "full" });

    expect(answer.items.map((item) => item.outcome)).toStrictEqual(["started", "started"]);
    expect(world.state.sync.fullStarts).toStrictEqual([HEALTH_SYSTEM_A, HEALTH_SYSTEM_B]);
    expect(world.state.sync.calendarStarts).toStrictEqual([]);
  });

  it("queues the portal pass alone as a portal-only calendar run", async () => {
    await callTool(world.client, TOOL, { healthSystems: [HEALTH_SYSTEM_A], kind: "portal" });

    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_A], portalOnly: true },
    ]);
  });
});

describe("the per-health-system result", () => {
  it("carries the same fields for every outcome", async () => {
    patch(HEALTH_SYSTEM_B, { enabled: false, portal: null });

    const answer = await callTool(world.client, TOOL, { all: true, kind: "full" });

    const started = row(answer.items, HEALTH_SYSTEM_A);
    expect(started).toStrictEqual({
      kind: "sync_request",
      healthSystem: NAME_A,
      healthSystemId: HEALTH_SYSTEM_A,
      sync: "full",
      outcome: "started",
      code: "started",
      nextAllowedAt: iso(NOW + SYNC_LIMITS.full.cooldownSeconds),
      lastCompletedAt: iso(NOW - 86_400),
      lastRequestedAt: iso(NOW),
      requestsToday: 1,
      dailyLimit: SYNC_LIMITS.full.dailyLimit,
      cooldownSeconds: SYNC_LIMITS.full.cooldownSeconds,
    });
    const skipped = row(answer.items, HEALTH_SYSTEM_B);
    expect(Object.keys(skipped)).toStrictEqual(Object.keys(started));
    expect(skipped).toMatchObject({
      outcome: "skipped",
      code: "disabled",
      nextAllowedAt: null,
      lastRequestedAt: null,
      requestsToday: 0,
    });
  });

  it("uses the usual envelope and says the sync runs in the background", async () => {
    const answer = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });
    const parsed = JSON.parse(answer.text) as Record<string, unknown>;

    expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "generatedAt",
      "items",
      "matched",
      "total",
      "truncated",
      "warnings",
    ]);
    expect(answer.warnings).toStrictEqual(["sync_runs_in_background_read_get_sync_status_later"]);
  });

  it("answers nothing but ids, names, fixed words, counts and instants", async () => {
    world.state.sync.startThrows = true;
    patch(HEALTH_SYSTEM_A, { portalUrl: "https://portal.example.test/secret-path" });

    const answer = await callTool(world.client, TOOL, { all: true, kind: "portal" });

    expect(answer.text).not.toContain("portal.example.test");
    expect(answer.text).not.toContain("unreachable");
    expect(answer.items.map((item) => item.code)).toStrictEqual(["start_failed", "start_failed"]);
  });

  it("writes one audit row naming the health systems by id", async () => {
    await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(world.state.audits).toHaveLength(1);
    expect(world.state.audits[0]).toMatchObject({
      tool: TOOL,
      ok: true,
      resultCount: 2,
      healthSystemIds: [HEALTH_SYSTEM_A, HEALTH_SYSTEM_B],
    });
  });
});

describe("a dry run", () => {
  it("starts nothing, takes no cooldown slot, and says what would happen", async () => {
    const answer = await callTool(world.client, TOOL, { all: true, kind: "full", dryRun: true });

    expect(nothingStarted()).toBe(true);
    expect(world.state.sync.history).toStrictEqual([]);
    expect(answer.warnings).toStrictEqual(["dry_run_nothing_was_started"]);
    for (const item of answer.items) {
      expect(item).toMatchObject({
        outcome: "would_start",
        code: "dry_run",
        nextAllowedAt: null,
        lastRequestedAt: null,
        requestsToday: 0,
      });
    }
  });

  it("reports the refusal a real call would get, with when to ask again", async () => {
    await callTool(world.client, TOOL, { healthSystems: [HEALTH_SYSTEM_A], kind: "full" });
    world.state.sync.fullStarts.length = 0;

    const answer = await callTool(world.client, TOOL, { all: true, kind: "full", dryRun: true });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({
      outcome: "refused",
      code: "cooldown",
      nextAllowedAt: iso(NOW + SYNC_LIMITS.full.cooldownSeconds),
    });
    expect(row(answer.items, HEALTH_SYSTEM_B)).toMatchObject({ outcome: "would_start" });
    expect(nothingStarted()).toBe(true);
  });
});

describe("the cooldown", () => {
  it("refuses a second request inside it, per health system and per kind", async () => {
    await callTool(world.client, TOOL, { healthSystems: [HEALTH_SYSTEM_A], kind: "ordinary" });
    world.state.now = NOW + 60;

    const again = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(row(again.items, HEALTH_SYSTEM_A)).toMatchObject({
      outcome: "refused",
      code: "cooldown",
      nextAllowedAt: iso(NOW + SYNC_LIMITS.ordinary.cooldownSeconds),
      lastRequestedAt: iso(NOW),
      requestsToday: 1,
    });
    // The other health system has its own clock, and so does another kind.
    expect(row(again.items, HEALTH_SYSTEM_B)).toMatchObject({ outcome: "started" });
    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_A], portalOnly: false },
      { healthSystemIds: [HEALTH_SYSTEM_B], portalOnly: false },
    ]);
    const otherKind = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "full",
    });
    expect(otherKind.items[0]).toMatchObject({ outcome: "started" });
  });

  it("does not queue a refused request for later", async () => {
    await callTool(world.client, TOOL, { all: true, kind: "portal" });
    const starts = world.state.sync.calendarStarts.length;

    await callTool(world.client, TOOL, { all: true, kind: "portal" });
    await callTool(world.client, TOOL, { all: true, kind: "portal" });

    expect(world.state.sync.calendarStarts).toHaveLength(starts);
  });

  it("lets the request through again once it has passed", async () => {
    await callTool(world.client, TOOL, { healthSystems: [HEALTH_SYSTEM_A], kind: "ordinary" });
    world.state.now = NOW + SYNC_LIMITS.ordinary.cooldownSeconds;
    // The fake's `lastSyncAt` does not move; only the caller's own history does.

    const again = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "ordinary",
    });

    expect(again.items[0]).toMatchObject({ outcome: "started", requestsToday: 2 });
    expect(world.state.sync.calendarStarts).toHaveLength(2);
  });

  it("stops at the daily limit even when each request waited out the cooldown", async () => {
    const { cooldownSeconds, dailyLimit } = SYNC_LIMITS.full;
    // A UTC day that starts at the fake clock, so every request lands inside it
    // only while the limit is small enough -- which the first assertion checks.
    const dayStart = Math.floor(NOW / 86_400) * 86_400;
    world.state.sync.history.push({
      healthSystemId: HEALTH_SYSTEM_A,
      kind: "full",
      requestedAt: dayStart,
      day: dayStart / 86_400,
      dayCount: dailyLimit,
    });
    world.state.now = dayStart + cooldownSeconds + 1;
    patch(HEALTH_SYSTEM_A, { lastFullRefreshAt: dayStart });

    const answer = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "full",
    });

    expect(answer.items[0]).toMatchObject({
      outcome: "refused",
      code: "daily_limit",
      nextAllowedAt: iso(dayStart + 86_400),
      requestsToday: dailyLimit,
    });
    expect(nothingStarted()).toBe(true);
  });

  it("gives the slot to one of two calls that both found it free", async () => {
    // What the single-statement claim is for: both calls decide "ready" from the
    // same history, and only the claim tells them apart.
    const deps = fakeDeps(world.state);
    const claim = deps.sync.claim.bind(deps.sync);
    let taken = false;
    deps.sync.claim = async (...args) => {
      if (taken) return false;
      taken = true;
      return claim(...args);
    };
    const client = await connectTools(deps);

    const answer = await callTool(client, TOOL, { all: true, kind: "full" });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({ outcome: "started" });
    expect(row(answer.items, HEALTH_SYSTEM_B)).toMatchObject({
      outcome: "refused",
      code: "cooldown",
      nextAllowedAt: iso(NOW + SYNC_LIMITS.full.cooldownSeconds),
    });
    expect(world.state.sync.fullStarts).toStrictEqual([HEALTH_SYSTEM_A]);
  });
});

describe("a run already in flight", () => {
  it("reports any open sync run instead of stacking another", async () => {
    world.state.sync.runInFlight = true;

    const answer = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    for (const item of answer.items) {
      expect(item).toMatchObject({ outcome: "already_running", code: "run_in_flight" });
    }
    expect(nothingStarted()).toBe(true);
    // Being told a run is in flight does not spend the cooldown.
    expect(world.state.sync.history).toStrictEqual([]);
  });

  it("reports a full refresh in flight for that health system only", async () => {
    world.state.sync.fullRefreshInFlight.add(HEALTH_SYSTEM_A);

    const answer = await callTool(world.client, TOOL, { all: true, kind: "full" });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({
      outcome: "already_running",
      code: "full_refresh_in_flight",
    });
    expect(row(answer.items, HEALTH_SYSTEM_B)).toMatchObject({ outcome: "started" });
    expect(world.state.sync.fullStarts).toStrictEqual([HEALTH_SYSTEM_B]);
  });

  it("stays out of the way of a portal sign-in in progress", async () => {
    world.state.sync.portalSignInInFlight.add(HEALTH_SYSTEM_A);

    const answer = await callTool(world.client, TOOL, { all: true, kind: "portal" });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({
      outcome: "already_running",
      code: "portal_sign_in_in_flight",
    });
    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_B], portalOnly: true },
    ]);
  });

  it("reports a run that was queued between the check and the start", async () => {
    world.state.sync.startAnswers = false;

    const answer = await callTool(world.client, TOOL, { all: true, kind: "full" });

    for (const item of answer.items) {
      expect(item).toMatchObject({ outcome: "already_running", code: "full_refresh_in_flight" });
    }
  });
});

describe("the other refusals", () => {
  it("refuses every kind while a health system is rate limiting this app", async () => {
    world.state.sync.backoffUntil = NOW + 7200;

    for (const kind of ["ordinary", "full", "portal"]) {
      const answer = await callTool(world.client, TOOL, { all: true, kind });
      for (const item of answer.items) {
        expect(item, kind).toMatchObject({
          outcome: "refused",
          code: "backed_off",
          nextAllowedAt: iso(NOW + 7200),
        });
      }
    }
    expect(nothingStarted()).toBe(true);
  });

  it("refuses to repeat a sync that has only just finished, whoever started it", async () => {
    patch(HEALTH_SYSTEM_A, { lastSyncAt: NOW - 60 });

    const answer = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({
      outcome: "refused",
      code: "recently_synced",
      nextAllowedAt: iso(NOW - 60 + SYNC_LIMITS.ordinary.freshSeconds),
      lastCompletedAt: iso(NOW - 60),
    });
    expect(row(answer.items, HEALTH_SYSTEM_B)).toMatchObject({ outcome: "started" });
  });

  it("is switched off by a `tool` deny rule, and by the MCP switch", async () => {
    world.state.rules = buildRules([{ rule_type: "tool", target: TOOL, enabled: 1 }]);
    const denied = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });
    world.state.rules = buildRules([]);
    world.state.enabled = false;
    const disabled = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(denied.error).toBe("policy_denied");
    expect(disabled.error).toBe("mcp_disabled");
    expect(nothingStarted()).toBe(true);
  });

  it("never syncs a health system the policy denies, by name or by `all`", async () => {
    world.state.rules = buildRules([
      { rule_type: "health_system", target: HEALTH_SYSTEM_B, enabled: 1 },
    ]);

    const all = await callTool(world.client, TOOL, { all: true, kind: "full" });
    const named = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_B],
      kind: "ordinary",
    });

    expect(all.items.map((item) => item.healthSystemId)).toStrictEqual([HEALTH_SYSTEM_A]);
    expect(named.items).toStrictEqual([]);
    expect(world.state.sync.fullStarts).toStrictEqual([HEALTH_SYSTEM_A]);
    expect(world.state.sync.calendarStarts).toStrictEqual([]);
  });
});

describe("a health system there is nothing to sync for", () => {
  it.each([
    ["disabled", { enabled: false, portal: null }],
    ["not_connected", { status: "not_connected" as const, portal: null }],
    ["not_connected", { status: "disconnected" as const, portal: null }],
    ["needs_reauth", { status: "needs_reauth" as const, portal: null }],
  ])("skips the API sync as %s", async (code, change) => {
    patch(HEALTH_SYSTEM_A, change);

    for (const kind of ["ordinary", "full"]) {
      const answer = await callTool(world.client, TOOL, {
        healthSystems: [HEALTH_SYSTEM_A],
        kind,
      });
      expect(answer.items[0], kind).toMatchObject({ outcome: "skipped", code });
    }
    expect(nothingStarted()).toBe(true);
    expect(world.state.sync.history).toStrictEqual([]);
  });

  it("still runs the ordinary sync for a portal-only health system that is signed in", async () => {
    patch(HEALTH_SYSTEM_A, { status: "not_connected", lastSyncAt: null });

    const ordinary = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "ordinary",
    });
    const full = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "full",
    });

    expect(ordinary.items[0]).toMatchObject({ outcome: "started" });
    expect(full.items[0]).toMatchObject({ outcome: "skipped", code: "not_connected" });
  });
});

describe("the patient portal", () => {
  it.each([
    ["portal_not_configured", null],
    ["portal_no_credentials", portal({ hasCredentials: false })],
    ["portal_no_credentials", portal({ hasCredentials: false, state: "none" })],
    ["portal_needs_reauth", portal({ state: "needs_reauth", needsReauthSince: NOW - 60 })],
    ["portal_not_signed_in", portal({ state: "none", lastOkAt: null })],
  ])("is skipped as %s and nothing reaches the engine", async (code, account) => {
    patch(HEALTH_SYSTEM_A, { portal: account });

    const real = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "portal",
    });
    const dry = await callTool(world.client, TOOL, {
      healthSystems: [HEALTH_SYSTEM_A],
      kind: "portal",
      dryRun: true,
    });

    expect(real.items[0]).toMatchObject({ outcome: "skipped", code, nextAllowedAt: null });
    expect(dry.items[0]).toMatchObject({ outcome: "skipped", code });
    expect(nothingStarted()).toBe(true);
    expect(world.state.sync.history).toStrictEqual([]);
  });

  it("runs for a signed-in account, and for that one only", async () => {
    patch(HEALTH_SYSTEM_B, { portal: portal({ state: "needs_reauth" }) });

    const answer = await callTool(world.client, TOOL, { all: true, kind: "portal" });

    expect(row(answer.items, HEALTH_SYSTEM_A)).toMatchObject({ outcome: "started" });
    expect(row(answer.items, HEALTH_SYSTEM_B)).toMatchObject({
      outcome: "skipped",
      code: "portal_needs_reauth",
    });
    expect(world.state.sync.calendarStarts).toStrictEqual([
      { healthSystemIds: [HEALTH_SYSTEM_A], portalOnly: true },
    ]);
  });
});

describe("when the engine cannot be reached", () => {
  it("answers `failed`, keeps the slot, and leaks nothing of the error", async () => {
    world.state.sync.startThrows = true;

    const answer = await callTool(world.client, TOOL, { all: true, kind: "ordinary" });

    expect(answer.isError).toBe(false);
    for (const item of answer.items) {
      expect(item).toMatchObject({ outcome: "failed", code: "start_failed" });
    }
    // The cautious reading: something is wrong, so the cooldown still applies.
    expect(world.state.sync.history).toHaveLength(2);
  });
});

describe("the rule builder's preview", () => {
  it("never runs the tool: its sample is made up, and nothing is started or claimed", async () => {
    const deps = fakeDeps(world.state);

    const structure = await sampleStructure(deps, TOOL);
    const preview = await previewDraft(deps, [], {
      tool: TOOL,
      field: {
        tool: TOOL,
        resourceType: null,
        healthSystemId: null,
        effect: "hide",
        paths: ["nextAllowedAt"],
      },
    });

    expect(structure).toStrictEqual({ tool: TOOL, items: 0, item: [], raw: [] });
    expect(preview.tools).toHaveLength(1);
    expect(preview.tools[0]).toMatchObject({ tool: TOOL, synthetic: true, affected: 1 });
    expect(nothingStarted()).toBe(true);
    expect(world.state.sync.history).toStrictEqual([]);
    expect(world.state.audits).toStrictEqual([]);
  });

  it("is not among the tools an unscoped draft is previewed on", async () => {
    const preview = await previewDraft(fakeDeps(world.state), [], {
      field: {
        tool: null,
        resourceType: null,
        healthSystemId: null,
        effect: "hide",
        paths: ["healthSystem"],
      },
    });

    expect(preview.tools.map((tool) => tool.tool)).not.toContain(TOOL);
    expect(nothingStarted()).toBe(true);
    expect(world.state.sync.history).toStrictEqual([]);
  });
});

/** The fake world's first health system: connected, with a signed-in portal. */
function healthSystem(): HealthSystemInfo {
  const [first] = fakeState().healthSystems;
  if (first === undefined) throw new Error("the fake world has no health system");
  return first;
}

/** An idle world at the fake clock, with some facts changed. */
function facts(change: Partial<SyncFacts> = {}): SyncFacts {
  return {
    now: NOW,
    backoffUntil: null,
    runInFlight: false,
    fullRefreshInFlight: new Set(),
    portalSignInInFlight: new Set(),
    history: new Map(),
    ...change,
  };
}

describe("decideSync", () => {
  it("puts what cannot work before every limit, so a skip spends nothing", () => {
    const decision = decideSync(
      "portal",
      { ...healthSystem(), portal: null },
      facts({ backoffUntil: NOW + 60, runInFlight: true }),
    );

    expect(decision).toStrictEqual({
      outcome: "skipped",
      code: "portal_not_configured",
      nextAllowedAt: null,
    });
  });

  it("reports the later of the cooldown and the daily limit", () => {
    const { cooldownSeconds, dailyLimit } = SYNC_LIMITS.full;
    // The last request of the day, an hour before it ends: the day turns before
    // the cooldown does, and the answer has to be the cooldown's.
    const dayEnd = (Math.floor(NOW / 86_400) + 1) * 86_400;
    const requestedAt = dayEnd - 3600;
    const history = new Map([
      [
        HEALTH_SYSTEM_A,
        {
          healthSystemId: HEALTH_SYSTEM_A,
          kind: "full" as const,
          requestedAt,
          day: Math.floor(requestedAt / 86_400),
          dayCount: dailyLimit,
        },
      ],
    ]);

    const decision = decideSync("full", healthSystem(), facts({ now: requestedAt + 60, history }));

    expect(decision).toStrictEqual({
      outcome: "refused",
      code: "cooldown",
      nextAllowedAt: requestedAt + cooldownSeconds,
    });
  });

  it("does not let a portal sign-in block a full refresh, or a full refresh the portal", () => {
    const busy = facts({
      fullRefreshInFlight: new Set([HEALTH_SYSTEM_A]),
      portalSignInInFlight: new Set([HEALTH_SYSTEM_A]),
    });

    expect(decideSync("full", healthSystem(), busy).code).toBe("full_refresh_in_flight");
    expect(decideSync("portal", healthSystem(), busy).code).toBe("portal_sign_in_in_flight");
    expect(decideSync("ordinary", healthSystem(), busy).code).toBe("full_refresh_in_flight");
  });

  it("holds the kinds to their own numbers", () => {
    expect(SYNC_LIMITS).toStrictEqual({
      ordinary: { cooldownSeconds: 900, dailyLimit: 12, freshSeconds: 300 },
      full: { cooldownSeconds: 14_400, dailyLimit: 3, freshSeconds: 1800 },
      portal: { cooldownSeconds: 1800, dailyLimit: 8, freshSeconds: 600 },
    });
  });
});
