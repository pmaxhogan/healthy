// `sync_health_systems` against a real D1, real settings, real `run_log` and
// the real Durable Objects' "is a job stored" answers.
//
// The unit suite walks every branch of the decision with a faked engine. What
// this file adds is the half that cannot be faked: the cooldown is really a row
// claimed by one SQL statement and really outlives the MCP session that took
// it; a run in flight is really an open `run_log` row; a missing portal login is
// really the sealed columns being NULL; and the tool's switch is really a
// `mcp_policy` row.
//
// The sync engine's two *starters* are stood in for, so nothing here can reach a
// health system, a portal or Google: a test asserts what would have been queued.
// The last block runs with nothing stood in for, against health systems that
// have no connection and no portal session, where the real engine has nothing
// to call.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeCtx } from "../../../src/db/client.ts";
import { makeRepos } from "../../../src/db/index.ts";
import { setSetting } from "../../../src/db/settings.ts";
import { makeToolDeps } from "../../../src/mcp/deps-d1.ts";
import { SYNC_LIMITS } from "../../../src/mcp/sync-request.ts";
import { registerTools } from "../../../src/mcp/tools/index.ts";
import {
  calendarSyncBusy,
  fullRefreshBusy,
  portalSignInState,
  startCalendarSync,
} from "../../../src/sync/index.ts";
import { resetDb } from "../db/helpers.ts";

import type { Repos } from "../../../src/db/index.ts";
import type { Env } from "../../../src/env.ts";
import type { SyncEngine } from "../../../src/mcp/deps-d1.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const TOOL = "sync_health_systems";

/** 2026-06-01T00:00:00Z: midnight UTC, so a test knows where the day turns. */
const NOW = 1_780_272_000;

function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

const TEST_ENV = { ...env, DATA_KEY: randomDataKey() } as unknown as Env;

/** The clock the repos and the tool share. A test moves it. */
const time = { now: NOW };

function repos(): Repos {
  return makeRepos(makeCtx(env.DB, TEST_ENV, { now: () => time.now }));
}

/** What a call would have queued, had the starters been real. */
interface Recorded {
  calendar: { healthSystemIds: string[]; portalOnly: boolean }[];
  full: string[];
}

/**
The real engine's readers, and starters that only write down what they were
asked for. The readers are real on purpose: `busy()` on the runners and the
sign-in phase are part of what is under test.
*/
function recordingEngine(recorded: Recorded): SyncEngine {
  return {
    calendarSyncBusy,
    fullRefreshBusy,
    portalSignInState,
    startCalendarSync: (_ctx, options) => {
      recorded.calendar.push({
        healthSystemIds: [...options.healthSystemIds],
        portalOnly: options.portalOnly,
      });
      return Promise.resolve({ started: true });
    },
    startFullRefresh: (_ctx, options) => {
      recorded.full.push(options.healthSystemId);
      return Promise.resolve({ started: true });
    },
  };
}

/** A fresh server and client: a new MCP session, as a reconnecting client is. */
async function connect(engine?: SyncEngine, clientId = "client-int"): Promise<Client> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({
      env: TEST_ENV,
      caller: { clientId, grantId: "grant-int" },
      now: () => time.now,
      ...(engine !== undefined && { syncEngine: engine }),
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

interface Answer {
  text: string;
  isError: boolean;
  items: Record<string, unknown>[];
  warnings: string[];
  error?: string;
}

async function call(client: Client, args: Record<string, unknown>): Promise<Answer> {
  const result = (await client.callTool({ name: TOOL, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A schema rejection is plain text, not an envelope.
  }
  return {
    text,
    isError: result.isError === true,
    items: (parsed.items ?? []) as Record<string, unknown>[],
    warnings: (parsed.warnings ?? []) as string[],
    ...(typeof parsed.error === "string" && { error: parsed.error }),
  };
}

function rowFor(answer: Answer, healthSystemId: string): Record<string, unknown> {
  const found = answer.items.find((item) => item.healthSystemId === healthSystemId);
  if (found === undefined) throw new Error(`no row for ${healthSystemId}: ${answer.text}`);
  return found;
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

interface Seeded {
  /** FHIR-connected, with a signed-in portal that has a stored login. */
  both: string;
  /** FHIR-connected, no portal account at all. */
  fhirOnly: string;
}

/** Two synthetic health systems. Nothing here names a real organisation. */
async function seed(): Promise<Seeded> {
  const db = repos();
  const both = await db.healthSystems.create({
    vendor: "epic",
    displayName: "Example Health",
    fhirBaseUrl: "https://a.fhir.example.test/R4",
    environment: "sandbox",
  });
  const fhirOnly = await db.healthSystems.create({
    vendor: "epic",
    displayName: "Other Clinic",
    fhirBaseUrl: "https://b.fhir.example.test/R4",
    environment: "sandbox",
  });
  for (const healthSystem of [both, fhirOnly]) {
    await db.connections.upsertTokens(healthSystem.id, {
      patientFhirId: "synthetic-patient",
      accessToken: "seeded-access-token",
      accessExpiresAt: NOW + 3600,
      refreshToken: "seeded-refresh-token",
      scope: "patient/Encounter.rs",
      status: "connected",
    });
  }
  await db.portalAccounts.setCredentials(both.id, {
    username: "synthetic-user",
    password: "synthetic-password",
    baseUrl: "https://portal.example.test",
    mountPath: "/portal/",
  });
  await db.portalAccounts.markActive(both.id);
  return { both: both.id, fhirOnly: fhirOnly.id };
}

const world: { seeded: Seeded; recorded: Recorded; client: Client } = {
  seeded: { both: "", fhirOnly: "" },
  recorded: { calendar: [], full: [] },
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  await resetDb();
  time.now = NOW;
  world.seeded = await seed();
  // The seed stamped the portal as proven good "now"; a test that wants the
  // portal pass to be due starts later than that.
  time.now = NOW + 3600;
  world.recorded = { calendar: [], full: [] };
  world.client = await connect(recordingEngine(world.recorded));
});

describe("what must be said explicitly", () => {
  it("refuses a call with no target and one with both, and starts nothing", async () => {
    const neither = await call(world.client, { kind: "ordinary" });
    const both = await call(world.client, {
      kind: "ordinary",
      all: true,
      healthSystems: [world.seeded.both],
    });

    expect(neither.error).toBe("invalid_target");
    expect(both.error).toBe("invalid_target");
    expect(world.recorded).toStrictEqual({ calendar: [], full: [] });
    expect(await repos().mcpSyncRequests.list("ordinary")).toStrictEqual([]);
  });

  it("refuses a call that does not say which kind, so full is never a default", async () => {
    const answer = await call(world.client, { all: true });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("Invalid arguments");
    expect(world.recorded).toStrictEqual({ calendar: [], full: [] });
  });

  it("starts every health system only when `all: true` says so", async () => {
    const answer = await call(world.client, { all: true, kind: "full" });

    expect(answer.items.map((item) => item.outcome)).toStrictEqual(["started", "started"]);
    expect(world.recorded.full).toHaveLength(2);
    expect(new Set(world.recorded.full)).toStrictEqual(
      new Set([world.seeded.both, world.seeded.fhirOnly]),
    );
  });
});

describe("the cooldown, in D1", () => {
  it("outlives the MCP session that took it", async () => {
    const first = await call(world.client, { healthSystems: [world.seeded.both], kind: "full" });
    // A client that reconnects gets a new server, new dependencies and no memory.
    const reconnected = await connect(recordingEngine(world.recorded), "another-client");
    time.now += 60;

    const again = await call(reconnected, { healthSystems: [world.seeded.both], kind: "full" });

    expect(first.items[0]).toMatchObject({ outcome: "started", requestsToday: 1 });
    expect(again.items[0]).toMatchObject({
      kind: "sync_request",
      healthSystem: "Example Health",
      healthSystemId: world.seeded.both,
      sync: "full",
      outcome: "refused",
      code: "cooldown",
      nextAllowedAt: iso(NOW + 3600 + SYNC_LIMITS.full.cooldownSeconds),
      lastRequestedAt: iso(NOW + 3600),
      requestsToday: 1,
      dailyLimit: SYNC_LIMITS.full.dailyLimit,
      cooldownSeconds: SYNC_LIMITS.full.cooldownSeconds,
    });
    expect(world.recorded.full).toStrictEqual([world.seeded.both]);
  });

  it("is per health system and per kind, and records the client that asked", async () => {
    await call(world.client, { healthSystems: [world.seeded.both], kind: "ordinary" });

    const other = await call(world.client, { all: true, kind: "ordinary" });
    const otherKind = await call(world.client, {
      healthSystems: [world.seeded.both],
      kind: "portal",
    });

    expect(rowFor(other, world.seeded.both)).toMatchObject({ code: "cooldown" });
    expect(rowFor(other, world.seeded.fhirOnly)).toMatchObject({ outcome: "started" });
    expect(otherKind.items[0]).toMatchObject({ outcome: "started" });
    const { results } = await env.DB.prepare(
      "SELECT kind, client_id FROM mcp_sync_requests WHERE health_system_id = ? ORDER BY kind",
    )
      .bind(world.seeded.both)
      .all<{ kind: string; client_id: string | null }>();
    expect(results).toStrictEqual([
      { kind: "ordinary", client_id: "client-int" },
      { kind: "portal", client_id: "client-int" },
    ]);
  });

  it("lets the request through again after it, until the day's limit", async () => {
    const { cooldownSeconds, dailyLimit } = SYNC_LIMITS.full;
    const outcomes: unknown[] = [];
    for (let request = 0; request <= dailyLimit; request += 1) {
      const answer = await call(world.client, {
        healthSystems: [world.seeded.fhirOnly],
        kind: "full",
      });
      outcomes.push(answer.items[0]?.code);
      time.now += cooldownSeconds;
    }

    expect(outcomes).toStrictEqual([
      ...Array.from({ length: dailyLimit }, () => "started"),
      "daily_limit",
    ]);
    expect(world.recorded.full).toHaveLength(dailyLimit);
  });

  it("is not spent by a dry run", async () => {
    const dry = await call(world.client, { all: true, kind: "full", dryRun: true });
    const real = await call(world.client, { all: true, kind: "full" });

    expect(dry.items.map((item) => item.outcome)).toStrictEqual(["would_start", "would_start"]);
    expect(dry.warnings).toContain("dry_run_nothing_was_started");
    expect(real.items.map((item) => item.outcome)).toStrictEqual(["started", "started"]);
  });
});

describe("a run in flight", () => {
  it("is reported from an open run_log row, and nothing is queued behind it", async () => {
    await repos().runLog.start("calendar");

    const answer = await call(world.client, { all: true, kind: "ordinary" });

    for (const item of answer.items) {
      expect(item).toMatchObject({ outcome: "already_running", code: "run_in_flight" });
    }
    expect(world.recorded).toStrictEqual({ calendar: [], full: [] });
    expect(await repos().mcpSyncRequests.list("ordinary")).toStrictEqual([]);
  });

  it("ignores a run row left open by an invocation that died long ago", async () => {
    await repos().runLog.start("calendar");
    time.now += 2 * 3600;

    const answer = await call(world.client, {
      healthSystems: [world.seeded.fhirOnly],
      kind: "full",
    });

    expect(answer.items[0]).toMatchObject({ outcome: "started" });
  });

  it("is reported from a full refresh job stored on that health system's runner", async () => {
    const stub = env.FULL_REFRESH.getByName(world.seeded.both);
    // Stored directly, with no alarm armed, so it cannot run under the test.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("job", {
        pending: [world.seeded.both],
        cycleStartedAt: 0,
        runId: null,
        state: null,
        chunks: 0,
      }),
    );

    const answer = await call(world.client, { all: true, kind: "full" });
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());

    expect(rowFor(answer, world.seeded.both)).toMatchObject({
      outcome: "already_running",
      code: "full_refresh_in_flight",
    });
    expect(rowFor(answer, world.seeded.fhirOnly)).toMatchObject({ outcome: "started" });
    expect(world.recorded.full).toStrictEqual([world.seeded.fhirOnly]);
  });

  it("is reported while a portal sign-in is in progress for that health system", async () => {
    const stub = env.PORTAL_SIGNIN.getByName(world.seeded.both);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put("phase", {
        phase: "awaiting_code",
        code: null,
        startedAt: time.now - 30,
        updatedAt: time.now - 10,
      }),
    );

    const answer = await call(world.client, { healthSystems: [world.seeded.both], kind: "portal" });
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());

    expect(answer.items[0]).toMatchObject({
      outcome: "already_running",
      code: "portal_sign_in_in_flight",
    });
    expect(world.recorded.calendar).toStrictEqual([]);
  });
});

describe("the other guardrails, from real rows", () => {
  it("refuses while the rate-limit backoff setting is in the future", async () => {
    await setSetting(repos().ctx, "sync_backoff_until", time.now + 7200);

    const answer = await call(world.client, { all: true, kind: "full" });

    for (const item of answer.items) {
      expect(item).toMatchObject({
        outcome: "refused",
        code: "backed_off",
        nextAllowedAt: iso(time.now + 7200),
      });
    }
    expect(world.recorded.full).toStrictEqual([]);
  });

  it("refuses to repeat a sync the connection finished moments ago", async () => {
    const db = repos();
    const connection = await db.connections.getForHealthSystem(world.seeded.fhirOnly);
    if (connection === null) throw new Error("the seed lost a connection");
    await db.connections.recordSync(connection.id, "full");

    const answer = await call(world.client, { all: true, kind: "full" });

    expect(rowFor(answer, world.seeded.fhirOnly)).toMatchObject({
      outcome: "refused",
      code: "recently_synced",
      lastCompletedAt: iso(time.now),
    });
    expect(rowFor(answer, world.seeded.both)).toMatchObject({ outcome: "started" });
  });

  it("is switched off by a `tool` deny rule in mcp_policy", async () => {
    await repos().mcpPolicy.add("tool", TOOL);

    const answer = await call(world.client, { all: true, kind: "ordinary" });

    expect(answer.error).toBe("policy_denied");
    expect(world.recorded).toStrictEqual({ calendar: [], full: [] });
  });

  it("cannot sync a health system a `health_system` rule denies", async () => {
    await repos().mcpPolicy.add("health_system", world.seeded.both);

    const answer = await call(world.client, { all: true, kind: "full" });

    expect(answer.items.map((item) => item.healthSystemId)).toStrictEqual([world.seeded.fhirOnly]);
    expect(world.recorded.full).toStrictEqual([world.seeded.fhirOnly]);
  });

  it("writes an audit row with ids and counts, and nothing else", async () => {
    await call(world.client, { all: true, kind: "ordinary" });

    const { results } = await env.DB.prepare(
      "SELECT tool, ok, result_count, client_id FROM mcp_audit",
    ).all();
    expect(results).toStrictEqual([
      { tool: TOOL, ok: 1, result_count: 2, client_id: "client-int" },
    ]);
  });
});

describe("the patient portal", () => {
  it("runs the portal pass for a signed-in account with a stored login", async () => {
    const answer = await call(world.client, { healthSystems: [world.seeded.both], kind: "portal" });

    expect(answer.items[0]).toMatchObject({ outcome: "started", lastCompletedAt: iso(NOW) });
    expect(world.recorded.calendar).toStrictEqual([
      { healthSystemIds: [world.seeded.both], portalOnly: true },
    ]);
  });

  it("skips a health system with no portal account", async () => {
    const answer = await call(world.client, {
      healthSystems: [world.seeded.fhirOnly],
      kind: "portal",
    });

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code: "portal_not_configured" });
    expect(world.recorded.calendar).toStrictEqual([]);
  });

  it("skips an account with no stored login, however its session reads", async () => {
    // A portal row with an endpoint and no credentials: what the admin API's own
    // portal sync refuses with a 409.
    await repos().portalAccounts.setEndpoint(world.seeded.fhirOnly, {
      baseUrl: "https://portal.example.test",
      mountPath: "/portal/",
      endpoint: { baseUrl: "https://portal.example.test", mountPath: "/portal/" },
    });

    const answer = await call(world.client, {
      healthSystems: [world.seeded.fhirOnly],
      kind: "portal",
    });

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code: "portal_no_credentials" });
    expect(world.recorded.calendar).toStrictEqual([]);
    expect(await repos().mcpSyncRequests.list("portal")).toStrictEqual([]);
  });

  it("skips an account that needs re-authorising: only the owner signs in", async () => {
    await repos().portalAccounts.markNeedsReauth(world.seeded.both, "portal_locked");

    const answer = await call(world.client, { healthSystems: [world.seeded.both], kind: "portal" });

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code: "portal_needs_reauth" });
    expect(world.recorded.calendar).toStrictEqual([]);
  });

  it("skips an account whose login is stored but has never signed in", async () => {
    await repos().portalAccounts.setCredentials(world.seeded.fhirOnly, {
      username: "synthetic-user",
      password: "synthetic-password",
    });

    const answer = await call(world.client, {
      healthSystems: [world.seeded.fhirOnly],
      kind: "portal",
    });

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code: "portal_not_signed_in" });
    expect(world.recorded.calendar).toStrictEqual([]);
  });

  it("answers no login, URL or portal identifier", async () => {
    const answer = await call(world.client, { all: true, kind: "portal" });

    expect(answer.text).not.toContain("synthetic-user");
    expect(answer.text).not.toContain("synthetic-password");
    expect(answer.text).not.toContain("portal.example.test");
    expect(answer.text).not.toContain("fhir.example.test");
  });
});

/**
One health system with no connection and no portal, and a client over the
real engine. Every kind is skipped for it before the engine is asked for
anything, which is what makes it safe to run with nothing stood in for.
*/
async function unconnected(): Promise<{ id: string; client: Client }> {
  await resetDb();
  const created = await repos().healthSystems.create({
    vendor: "epic",
    displayName: "Example Health",
    fhirBaseUrl: "https://a.fhir.example.test/R4",
    environment: "sandbox",
  });
  return { id: created.id, client: await connect() };
}

describe("with the real engine and nothing to reach", () => {
  it("skips every kind for a health system that was never connected", async () => {
    const { id, client } = await unconnected();

    const codes: unknown[] = [];
    for (const kind of ["ordinary", "full", "portal"]) {
      const answer = await call(client, { healthSystems: [id], kind });
      codes.push(answer.items[0]?.code);
      expect(answer.items[0], kind).toMatchObject({ outcome: "skipped" });
    }

    expect(codes).toStrictEqual(["not_connected", "not_connected", "portal_not_configured"]);
    expect(await calendarSyncBusy(repos().ctx)).toBe(false);
    expect(await fullRefreshBusy(repos().ctx, { healthSystemId: id })).toBe(false);
    const { results } = await env.DB.prepare("SELECT id FROM run_log").all();
    expect(results).toStrictEqual([]);
  });

  it("queues a real calendar job, runs it once, and leaves nothing behind", async () => {
    // A portal-only request over a health system the engine has no account for:
    // the job runs end to end -- its own run row, opened and closed -- and finds
    // nothing to call. Queued through the engine's own entry point rather than
    // the tool, which would (rightly) have skipped it.
    //
    // Seeded under the Worker's own key, not this file's: the job runs inside the
    // Durable Object, which opens rows with the key it was started with.
    await resetDb();
    const ctx = makeCtx(env.DB, env);
    const { id } = await makeRepos(ctx).healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://a.fhir.example.test/R4",
      environment: "sandbox",
    });
    const stub = env.FULL_REFRESH.getByName("mcp-calendar-sync");
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());

    expect(await startCalendarSync(ctx, { healthSystemIds: [id], portalOnly: true })).toStrictEqual(
      {
        started: true,
      },
    );
    await runDurableObjectAlarm(stub);
    for (let attempt = 0; attempt < 50 && (await calendarSyncBusy(ctx)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(await calendarSyncBusy(ctx)).toBe(false);
    const { results } = await env.DB.prepare(
      "SELECT kind, ok, finished_at IS NOT NULL AS closed FROM run_log",
    ).all();
    expect(results).toStrictEqual([{ kind: "manual", ok: 1, closed: 1 }]);
  });
});
