// The daily full refresh, against real D1.
//
// What is worth proving here is not "it fetches things" but the isolation: a
// resource type the organisation refuses must leave the others cached and one
// recorded failure behind, because that record is how the owner ever finds out a
// scope is missing.

import { beforeEach, describe, expect, it } from "vitest";

import { setSetting } from "../../../worker/db/settings.ts";
import { runFullRefresh, runFullRefreshChunk } from "../../../worker/sync/full-refresh.ts";

import {
  T0,
  clock,
  encounter,
  fhirServer,
  organization,
  recordingLog,
  referencePool,
  resetSyncDb,
  searchBundle,
  seedConnectedProvider,
  seedSettings,
  stubUpstreams,
  syncCtx,
  syncRepos,
} from "./helpers.ts";

import type { FhirServer, Upstreams } from "./helpers.ts";
import type { Ctx } from "../../../worker/db/client.ts";
import type { FullRefreshResult, RefreshJob } from "../../../worker/sync/full-refresh.ts";
import type * as fhir4 from "fhir/r4";

beforeEach(resetSyncDb);

const HOST = "fhir.a.example.test";

/** FHIR's own union of resource type names, which the rest resource's `type` is. */
type ResourceTypeName = fhir4.CapabilityStatementRestResource["type"];

/** The resource types this suite asks the organisation to support. */
function searchable(): fhir4.CapabilityStatementRestResource[] {
  const withCategory = (type: ResourceTypeName): fhir4.CapabilityStatementRestResource => ({
    type,
    interaction: [{ code: "read" }, { code: "search-type" }],
    searchParam: [
      { name: "patient", type: "reference" },
      { name: "category", type: "token" },
      { name: "date", type: "date" },
    ],
  });
  const plain = (type: ResourceTypeName): fhir4.CapabilityStatementRestResource => ({
    type,
    interaction: [{ code: "read" }, { code: "search-type" }],
    searchParam: [{ name: "patient", type: "reference" }],
  });
  return [
    withCategory("Condition"),
    withCategory("Observation"),
    withCategory("DocumentReference"),
    plain("Immunization"),
    plain("AllergyIntolerance"),
    { type: "Binary", interaction: [{ code: "read" }] },
  ];
}

function condition(id: string): fhir4.Condition {
  return {
    resourceType: "Condition",
    id,
    subject: { reference: "Patient/patient-a" },
    code: { text: "Test Condition" },
    category: [{ coding: [{ code: "problem-list-item" }] }],
  };
}

function observation(id: string): fhir4.Observation {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    subject: { reference: "Patient/patient-a" },
    code: { text: "Test Observation" },
    category: [{ coding: [{ code: "laboratory" }] }],
    valueQuantity: { value: 1, unit: "mg/dL" },
  };
}

function immunization(id: string): fhir4.Immunization {
  return {
    resourceType: "Immunization",
    id,
    status: "completed",
    patient: { reference: "Patient/patient-a" },
    vaccineCode: { text: "Test Vaccine" },
    occurrenceDateTime: "2026-01-02",
  };
}

/**
 * A Bundle whose only entry is an OperationOutcome, as Epic sends for a search
 * that produced a warning instead of results.
 */
function outcomeBundle(issue: fhir4.OperationOutcomeIssue): fhir4.Bundle {
  const outcome: fhir4.OperationOutcome = { resourceType: "OperationOutcome", issue: [issue] };
  return {
    resourceType: "Bundle",
    type: "searchset",
    entry: [{ search: { mode: "outcome" }, resource: outcome }],
  };
}

/** Epic's daily document-query cap (4135). */
function documentCapBundle(): fhir4.Bundle {
  return outcomeBundle({
    severity: "warning",
    code: "throttled",
    details: { coding: [{ code: "4135" }], text: "document query cap reached" },
  });
}

interface Harness {
  ctx: Ctx;
  time: ReturnType<typeof clock>;
  server: FhirServer;
  upstreams: Upstreams;
  providerId: string;
  lines: string[];
}

async function setup(): Promise<Harness> {
  const time = clock();
  const { log, lines } = recordingLog();
  const ctx = syncCtx({ now: time.now, log });
  const seeded = await seedConnectedProvider(ctx, { host: HOST });
  await seedSettings(ctx);

  const server = fhirServer({ resources: referencePool() });
  server.capability = {
    ...server.capability,
    rest: [
      {
        mode: "server",
        resource: [...(server.capability.rest?.[0]?.resource ?? []), ...searchable()],
      },
    ],
  };
  server.resources.set("Patient/patient-a", {
    resourceType: "Patient",
    id: "patient-a",
    name: [{ family: "Testperson", given: ["Test"] }],
    birthDate: "1990-01-01",
  });
  server.encounters = searchBundle([encounter({ id: "enc-1", start: "2026-06-29T15:30:00Z" })]);
  server.searches.set("Condition", searchBundle([condition("cond-1"), condition("cond-2")]));
  server.searches.set("Observation", searchBundle([observation("obs-1")]));
  server.searches.set("Immunization", searchBundle([immunization("imm-1")]));

  const upstreams = stubUpstreams({ [HOST]: server });
  return { ctx, time, server, upstreams, lines, providerId: seeded.providerId };
}

describe("runFullRefresh", () => {
  it("fills the cache and reports what it cached", async () => {
    const h = await setup();

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    expect(summary.providers).toBe(1);
    expect(summary.errors).toStrictEqual([]);
    expect(summary.resourcesCached).toBeGreaterThanOrEqual(6);

    const cached = await syncRepos(h.ctx).fhirCache.countsByType();
    const counts = new Map(cached.map((row) => [row.resourceType, row.count]));
    expect(counts.get("Patient")).toBe(1);
    expect(counts.get("Encounter")).toBe(1);
    expect(counts.get("Condition")).toBe(2);
    expect(counts.get("Observation")).toBe(1);
    expect(counts.get("Immunization")).toBe(1);
  });

  it("records the outcome per resource type", async () => {
    const h = await setup();

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const states = await syncRepos(h.ctx).fhirSyncState.listByProvider(h.providerId);
    const byType = new Map(states.map((state) => [state.resourceType, state]));
    expect(byType.get("Condition")).toMatchObject({ lastOk: true, lastFullAt: T0 });
    expect(byType.get("Observation")?.lastOk).toBe(true);
    // A type the organisation returned nothing for is still a success: "no rows"
    // is an answer, and it is how the owner tells it apart from a refusal.
    expect(byType.get("AllergyIntolerance")).toMatchObject({ lastOk: true });
  });

  it("does not ask for a resource type the organisation does not expose", async () => {
    const h = await setup();

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const states = await syncRepos(h.ctx).fhirSyncState.listByProvider(h.providerId);
    const types = new Set(states.map((state) => state.resourceType));
    expect(types.has("Coverage")).toBe(false);
    expect(types.has("MedicationRequest")).toBe(false);
  });

  it("runs one search per category for a category-scoped type", async () => {
    // Epic's patient-facing Condition search returns only the category asked for,
    // so three categories means three searches.
    const h = await setup();
    const before = h.server.searchCalls;

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    // Condition (3) + Observation (4) + DocumentReference (1) + Immunization (1)
    // + AllergyIntolerance (1) + Encounter (1).
    expect(h.server.searchCalls - before).toBe(11);
  });

  it("de-duplicates a resource returned by more than one category search", async () => {
    const h = await setup();
    // The same Condition comes back for every category.
    h.server.searches.set("Condition", searchBundle([condition("cond-dupe")]));

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const counts = await syncRepos(h.ctx).fhirCache.countsByType();
    expect(counts.find((row) => row.resourceType === "Condition")?.count).toBe(1);
  });

  it("isolates a failing resource type from the rest", async () => {
    const h = await setup();
    h.server.searches.set(
      "Observation",
      outcomeBundle({
        severity: "error",
        code: "forbidden",
        details: { coding: [{ code: "4118" }], text: "not authorized" },
      }),
    );

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    // The run itself is a success: one resource type is not the record.
    expect(summary.errors).toStrictEqual([]);
    const states = await syncRepos(h.ctx).fhirSyncState.listByProvider(h.providerId);
    const observation_ = states.find((state) => state.resourceType === "Observation");
    expect(observation_?.lastOk).toBe(false);
    expect(observation_?.lastErrorCode).toBe("upstream_auth:4118");
    // Everything else still landed.
    const counts = await syncRepos(h.ctx).fhirCache.countsByType();
    expect(counts.find((row) => row.resourceType === "Condition")?.count).toBe(2);
  });

  it("stops document work for the day when Epic reports its cap", async () => {
    const h = await setup();
    h.server.searches.set("DocumentReference", documentCapBundle());

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const states = await syncRepos(h.ctx).fhirSyncState.listByProvider(h.providerId);
    const binary = states.find((state) => state.resourceType === "Binary");
    expect(binary).toMatchObject({ lastOk: false, lastErrorCode: "epic_4135" });
  });

  it("records the 4135 warning against DocumentReference too", async () => {
    const h = await setup();
    h.server.searches.set("DocumentReference", documentCapBundle());

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    expect(summary.warnings).toBeGreaterThan(0);
    const runs = await syncRepos(h.ctx).runLog.listRecent();
    expect(runs[0]?.summary.warnings).toContain("4135");
  });

  it("writes a run_log row of kind full", async () => {
    const h = await setup();

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const runs = await syncRepos(h.ctx).runLog.listRecent();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "full", ok: true });
    expect(runs[0]?.summary.resources).toBeGreaterThan(0);
  });

  it("stamps the connection's own full-refresh clock", async () => {
    const h = await setup();

    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const connection = await syncRepos(h.ctx).connections.getForProvider(h.providerId);
    expect(connection?.last_full_refresh_at).toBe(T0);
  });

  it("re-caches an unchanged resource without rewriting it", async () => {
    const h = await setup();
    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    h.time.advance(86_400);
    const second = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    // Same count, and the TTL moved: `upsertMany` extends rather than rewrites
    // when the plaintext hash is unchanged.
    expect(second.resourcesCached).toBeGreaterThan(0);
    const cached = await syncRepos(h.ctx).fhirCache.get(h.providerId, "Condition", "cond-1");
    expect(cached?.fetchedAt).toBe(T0 + 86_400);
  });

  it("caches a resource whose content changed", async () => {
    const h = await setup();
    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });
    h.server.searches.set(
      "Condition",
      searchBundle([{ ...condition("cond-1"), code: { text: "Changed" } }, condition("cond-2")]),
    );

    h.time.advance(86_400);
    await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const cached = await syncRepos(h.ctx).fhirCache.get(h.providerId, "Condition", "cond-1");
    expect((cached?.resource as fhir4.Condition).code?.text).toBe("Changed");
  });

  it("backs off and stops when the organisation returns 429", async () => {
    const h = await setup();
    h.server.encounterStatus = 429;

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    expect(summary.backedOff).toBe(true);
    expect(summary.errors.map((error) => error.providerId)).toStrictEqual([h.providerId]);
  });

  it("skips entirely while a backoff stands", async () => {
    const h = await setup();
    await setSetting(h.ctx, "sync_backoff_until", T0 + 3600);

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    expect(summary.backedOff).toBe(true);
    expect(h.server.searchCalls).toBe(0);
    await expect(syncRepos(h.ctx).runLog.listRecent()).resolves.toStrictEqual([]);
  });

  it("tries the whole registry when the CapabilityStatement cannot be read", async () => {
    // A capability fetch that fails leaves the index null; `getCapabilityIndex`
    // swallows it rather than failing the run, and the refresh falls back to
    // asking for everything -- an unsupported search costs one warning.
    const h = await setup();
    h.server.capabilityStatus = 403;
    h.server.searches.set("Organization", searchBundle([organization("org-9", "Another Example")]));

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    const states = await syncRepos(h.ctx).fhirSyncState.listByProvider(h.providerId);
    expect(states.some((state) => state.resourceType === "MedicationRequest")).toBe(true);
    expect(summary.errors).toStrictEqual([]);
  });

  it("asks for nothing when the organisation lists no resource types", async () => {
    // An empty CapabilityStatement is an answer, not a failure: the spec says to
    // skip the types an organisation does not list, and it lists none.
    const h = await setup();
    h.server.capability = { resourceType: "CapabilityStatement" } as fhir4.CapabilityStatement;

    const summary = await runFullRefresh(h.ctx, { deps: h.upstreams.deps });

    expect(h.server.searchCalls).toBe(0);
    expect(summary.resourcesCached).toBe(0);
    expect(summary.errors).toStrictEqual([]);
  });
});

/**
 * A wall clock that jumps by a fixed step every time it is read.
 *
 * The budget is measured in milliseconds and `Ctx.now()` is whole seconds, so the
 * chunk clock is its own injected dep. Stepping it by more than the budget makes
 * "one resource type per chunk" exact instead of a race against the machine.
 */
function steppedMs(step: number): () => number {
  const state = { at: 0 };
  return () => {
    state.at += step;
    return state.at;
  };
}

/** Deps that make every budget check after the first one report "spent". */
function oneTypePerChunk(upstreams: Upstreams): Upstreams["deps"] {
  return { ...upstreams.deps, nowMs: steppedMs(1000) };
}

const ONE_TYPE_BUDGET_MS = 500;

describe("runFullRefreshChunk", () => {
  it("never asks to be resumed when it was given no budget", async () => {
    const h = await setup();

    const result = await runFullRefreshChunk(h.ctx, { deps: h.upstreams.deps });

    expect(result.job).toBeNull();
    expect(result.summary.errors).toStrictEqual([]);
  });

  it("stops between resource types once the budget is spent, leaving the row open", async () => {
    const h = await setup();

    const result = await runFullRefreshChunk(h.ctx, {
      deps: oneTypePerChunk(h.upstreams),
      budgetMs: ONE_TYPE_BUDGET_MS,
      job: { pending: [h.providerId], cycleStartedAt: T0, runId: null, state: null },
    });

    expect(result.job?.pending).toStrictEqual([h.providerId]);
    const repos = syncRepos(h.ctx);
    // Exactly one (provider, resource type) pass happened: a chunk always makes
    // progress, and a spent budget stops it after the first.
    const states = await repos.fhirSyncState.listByProvider(h.providerId);
    expect(states).toHaveLength(1);
    // The row is deliberately still open, and it is the one the job carries.
    const runs = await repos.runLog.listRecent({ kind: "full" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBeNull();
    expect(result.job?.runId).toBe(runs[0]?.id);
    // And the provider is not stamped as refreshed, because it is not.
    const connection = await repos.connections.getForProvider(h.providerId);
    expect(connection?.last_full_refresh_at).toBeNull();
  });

  it("closes the open row when a backoff lands between two chunks", async () => {
    const h = await setup();
    const first = await runFullRefreshChunk(h.ctx, {
      deps: oneTypePerChunk(h.upstreams),
      budgetMs: ONE_TYPE_BUDGET_MS,
      job: { pending: [h.providerId], cycleStartedAt: T0, runId: null, state: null },
    });
    const { job } = first;
    if (job === null) throw new Error("the budgeted first chunk should have deferred");

    // Something else -- the hourly sync meeting a 429 -- set a backoff while this
    // refresh was between alarms.
    await setSetting(h.ctx, "sync_backoff_until", T0 + 3600);
    const second = await runFullRefreshChunk(h.ctx, {
      deps: oneTypePerChunk(h.upstreams),
      budgetMs: ONE_TYPE_BUDGET_MS,
      job,
    });

    // The refresh stops, and the row does not sit open waiting to be swept as
    // `aborted` half an hour later: it says what actually happened.
    expect(second.job).toBeNull();
    expect(second.summary.backedOff).toBe(true);
    const runs = await syncRepos(h.ctx).runLog.listRecent({ kind: "full" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBe(T0);
    expect(runs[0]?.summary.backedOff).toBe(true);
  });

  it("resumes where it stopped, asking for nothing twice, and closes one run row", async () => {
    const h = await setup();
    const unchunked = h.server.searchCalls;
    let job: RefreshJob = {
      pending: [h.providerId],
      cycleStartedAt: T0,
      runId: null,
      state: null,
    };
    let result: FullRefreshResult;
    let chunks = 0;
    do {
      result = await runFullRefreshChunk(h.ctx, {
        deps: oneTypePerChunk(h.upstreams),
        budgetMs: ONE_TYPE_BUDGET_MS,
        job,
      });
      chunks += 1;
      if (result.job !== null) job = result.job;
    } while (result.job !== null && chunks < 30);

    expect(result.job).toBeNull();
    // More than one chunk, or the budget proved nothing.
    expect(chunks).toBeGreaterThan(1);
    // The resume marker is `fhir_sync_state.last_full_at`, and this is the
    // assertion that it works: eleven searches is what one unchunked refresh of
    // this organisation costs, so nothing was walked twice.
    expect(h.server.searchCalls - unchunked).toBe(11);

    const repos = syncRepos(h.ctx);
    const runs = await repos.runLog.listRecent({ kind: "full" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.finishedAt).toBe(T0);
    expect(runs[0]?.ok).toBe(true);
    // Counts survived every chunk boundary rather than restarting at zero.
    expect(runs[0]?.summary.resources).toBe(result.summary.resourcesCached);
    expect(result.summary.providers).toBe(1);
    const cached = await repos.fhirCache.countsByType();
    const counts = new Map(cached.map((row) => [row.resourceType, row.count]));
    expect(counts.get("Condition")).toBe(2);
    expect(counts.get("Patient")).toBe(1);
    // Only the chunk that finished the provider stamps its clock.
    const connection = await repos.connections.getForProvider(h.providerId);
    expect(connection?.last_full_refresh_at).toBe(T0);
  });
});
