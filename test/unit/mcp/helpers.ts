// Scaffolding for the MCP tool tests.
//
// The tools are written against `ToolDeps`, so the whole surface can be faked in
// memory: no workerd, no D1, no Durable Object, no network. What is under test is
// still the real thing -- the real `McpServer`, the real zod schemas, the real
// normalizers, the real policy filter -- reached over the SDK's in-memory
// transport exactly as a client would reach it over HTTP.
//
// Every resource below is synthetic. Nothing in this file (or any fixture) may
// come from a real record, and no real organisation is named.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerTools } from "../../../worker/mcp/tools/index.ts";
import { EMPTY_RULES } from "../../../worker/policy/rules.ts";

import type { Logger } from "../../../worker/lib/log.ts";
import type {
  AuditRecord,
  CacheCount,
  CachedRow,
  DocumentTextResult,
  PortalVisitRecord,
  ProviderInfo,
  SyncStatusEntry,
  ToolDeps,
} from "../../../worker/mcp/deps.ts";
import type { PolicyRules } from "../../../worker/policy/rules.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** 2026-06-01T00:00:00Z, in unix seconds. An arbitrary fixed "now". */
export const NOW = 1_780_272_000;

export const PROVIDER_A = "prov_a";
export const PROVIDER_B = "prov_b";
export const NAME_A = "Example Health";
export const NAME_B = "Other Clinic";

function provider(id: string, displayName: string): ProviderInfo {
  return {
    id,
    displayName,
    environment: "sandbox",
    portalUrl: "https://portal.example.test",
    enabled: true,
    status: "connected",
    lastSyncAt: NOW - 3600,
    lastFullRefreshAt: NOW - 86_400,
    lastErrorCode: null,
    needsReauthSince: null,
  };
}

/** A resource pool for one provider, keyed `resourceType`. */
type Pool = Record<string, unknown[]>;

function poolA(): Pool {
  return {
    Patient: [
      {
        resourceType: "Patient",
        id: "pat-a",
        meta: { lastUpdated: "2026-05-01T00:00:00Z" },
        name: [{ family: "Person", given: ["Test"] }],
        birthDate: "1970-07-07",
        gender: "female",
        telecom: [{ system: "phone", value: "555-0100" }],
        address: [
          { city: "Testville", state: "TS", line: ["1 Nowhere Lane"], postalCode: "00000" },
        ],
      },
    ],
    Practitioner: [
      {
        resourceType: "Practitioner",
        id: "prac-1",
        name: [{ family: "Rivers", given: ["Ada"], prefix: ["Dr"] }],
      },
    ],
    Encounter: [
      {
        resourceType: "Encounter",
        id: "enc-future",
        meta: { lastUpdated: "2026-05-20T00:00:00Z" },
        status: "planned",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Follow-up" }],
        period: { start: "2026-07-01T09:00:00Z", end: "2026-07-01T09:30:00Z" },
        participant: [{ individual: { reference: "Practitioner/prac-1" } }],
      },
      {
        resourceType: "Encounter",
        id: "enc-past",
        meta: { lastUpdated: "2026-03-03T00:00:00Z" },
        status: "finished",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Annual physical" }],
        period: { start: "2026-03-02T10:00:00Z", end: "2026-03-02T10:45:00Z" },
      },
    ],
    Condition: [
      {
        resourceType: "Condition",
        id: "cond-1",
        meta: { lastUpdated: "2026-04-04T00:00:00Z" },
        category: [{ coding: [{ code: "problem-list-item" }] }],
        clinicalStatus: { coding: [{ code: "active" }] },
        code: { text: "Seasonal allergic rhinitis" },
        recordedDate: "2026-04-04T00:00:00Z",
      },
      {
        resourceType: "Condition",
        id: "cond-2",
        clinicalStatus: { coding: [{ code: "resolved" }] },
        code: { text: "Sprained ankle" },
        recordedDate: "2025-11-11T00:00:00Z",
      },
    ],
    MedicationRequest: [
      {
        resourceType: "MedicationRequest",
        id: "med-1",
        status: "active",
        intent: "order",
        authoredOn: "2026-05-05T00:00:00Z",
        medicationCodeableConcept: { text: "Cetirizine 10 mg" },
      },
      {
        resourceType: "MedicationRequest",
        id: "med-2",
        status: "completed",
        intent: "order",
        authoredOn: "2025-09-09T00:00:00Z",
        medicationCodeableConcept: { text: "Amoxicillin 500 mg" },
      },
    ],
    Observation: [
      {
        resourceType: "Observation",
        id: "obs-lab",
        status: "final",
        category: [{ coding: [{ code: "laboratory", display: "Laboratory" }] }],
        code: { text: "Hemoglobin A1c", coding: [{ code: "4548-4", system: "https://loinc.org" }] },
        valueQuantity: { value: 5.4, unit: "%" },
        effectiveDateTime: "2026-05-10T00:00:00Z",
      },
      {
        resourceType: "Observation",
        id: "obs-vital",
        status: "final",
        category: [{ coding: [{ code: "vital-signs", display: "Vital Signs" }] }],
        code: { text: "Blood pressure" },
        effectiveDateTime: "2026-05-11T00:00:00Z",
        component: [
          { code: { text: "Systolic" }, valueQuantity: { value: 118, unit: "mm[Hg]" } },
          { code: { text: "Diastolic" }, valueQuantity: { value: 74, unit: "mm[Hg]" } },
        ],
      },
      {
        resourceType: "Observation",
        id: "obs-social",
        status: "final",
        category: [{ coding: [{ code: "social-history" }] }],
        code: { text: "Tobacco smoking status" },
        valueCodeableConcept: { text: "Never smoker" },
        effectiveDateTime: "2026-01-20T00:00:00Z",
      },
    ],
    Coverage: [
      {
        resourceType: "Coverage",
        id: "cov-1",
        status: "active",
        payor: [{ display: "Example Insurer" }],
        type: { text: "PPO" },
        subscriberId: "SUB-12345",
      },
    ],
    DocumentReference: [
      {
        resourceType: "DocumentReference",
        id: "doc-1",
        status: "current",
        date: "2026-03-02T11:00:00Z",
        type: { text: "Progress note" },
        content: [{ attachment: { contentType: "text/html", url: "Binary/bin-1" } }],
      },
    ],
  };
}

function poolB(): Pool {
  return {
    Patient: [
      {
        resourceType: "Patient",
        id: "pat-b",
        name: [{ family: "Person", given: ["Test"] }],
        birthDate: "1970-07-07",
      },
    ],
    Condition: [
      {
        resourceType: "Condition",
        id: "cond-b",
        clinicalStatus: { coding: [{ code: "active" }] },
        code: { text: "Migraine without aura" },
        recordedDate: "2026-02-02T00:00:00Z",
      },
    ],
    Encounter: [
      {
        resourceType: "Encounter",
        id: "enc-b",
        status: "planned",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Neurology consult" }],
        period: { start: "2026-08-15T14:00:00Z" },
      },
    ],
  };
}

export interface FakeState {
  enabled: boolean;
  rules: PolicyRules;
  providers: ProviderInfo[];
  pools: Map<string, Pool>;
  /** What the portal pass stored, by provider id. Empty unless a test adds some. */
  portalVisits: Map<string, PortalVisitRecord[]>;
  counts: CacheCount[];
  syncStatus: SyncStatusEntry[];
  document: DocumentTextResult;
  /** Every audit row the tools wrote, in order. */
  audits: AuditRecord[];
  prunes: number;
  beginCalls: number;
}

export interface FakeOverrides {
  enabled?: boolean;
  rules?: PolicyRules;
  providers?: ProviderInfo[];
  pools?: Map<string, Pool>;
  portalVisits?: Map<string, PortalVisitRecord[]>;
  document?: DocumentTextResult;
}

/** The two-provider world every tool test starts from. */
export function fakeState(overrides: FakeOverrides = {}): FakeState {
  const pools =
    overrides.pools ??
    new Map([
      [PROVIDER_A, poolA()],
      [PROVIDER_B, poolB()],
    ]);
  const counts: CacheCount[] = [];
  for (const [providerId, pool] of pools) {
    for (const [resourceType, resources] of Object.entries(pool)) {
      counts.push({ providerId, resourceType, count: resources.length });
    }
  }
  return {
    enabled: overrides.enabled ?? true,
    rules: overrides.rules ?? EMPTY_RULES,
    providers: overrides.providers ?? [provider(PROVIDER_A, NAME_A), provider(PROVIDER_B, NAME_B)],
    pools,
    portalVisits: overrides.portalVisits ?? new Map(),
    counts,
    syncStatus: [
      {
        providerId: PROVIDER_A,
        resourceType: "Condition",
        lastFullAt: NOW - 86_400,
        lastOk: true,
        lastErrorCode: null,
        warnings: [{ code: "4119", count: 1 }],
      },
    ],
    document: overrides.document ?? {
      ok: true,
      documentId: "doc-1",
      contentType: "text/html",
      text: "Patient reports seasonal symptoms.",
      cached: false,
    },
    audits: [],
    prunes: 0,
    beginCalls: 0,
  };
}

function discard(): void {
  // Intentionally empty: the test logger's whole job is to drop the line.
}

/** A logger that drops every line. The tools' own logging is not under test. */
function silentLog(): Logger {
  const log: Logger = {
    debug: discard,
    info: discard,
    warn: discard,
    error: discard,
    time: async (_event, fn) => fn(),
    child: () => log,
  };
  return log;
}

/** One resource type out of a pool, read as an own property. */
function fromPool(pool: Pool | undefined, resourceType: string): unknown[] {
  if (pool === undefined || !Object.hasOwn(pool, resourceType)) return [];
  const found: unknown = Reflect.get(pool, resourceType);
  return Array.isArray(found) ? (found as unknown[]) : [];
}

/** A `ToolDeps` over `state`. Mutate `state` between calls to change the world. */
export function fakeDeps(state: FakeState): ToolDeps {
  const rows = (providerId: string, resourceType: string): CachedRow[] =>
    fromPool(state.pools.get(providerId), resourceType).map((resource) => ({
      resource,
      lastUpdated: null,
      fetchedAt: NOW,
    }));

  return {
    log: silentLog(),
    caller: { clientId: "client-under-test", grantId: "grant-under-test" },
    beginCall: () => {
      state.beginCalls += 1;
    },
    now: () => NOW,
    mcpEnabled: () => Promise.resolve(state.enabled),
    rules: () => Promise.resolve(state.rules),
    providers: () => Promise.resolve(state.providers),
    resources: (providerId, resourceType) => Promise.resolve(rows(providerId, resourceType)),
    referencePool: (providerId) => {
      const pool = state.pools.get(providerId);
      return Promise.resolve([
        ...fromPool(pool, "Practitioner"),
        ...fromPool(pool, "Location"),
        ...fromPool(pool, "Organization"),
      ]);
    },
    portalVisits: (providerId) => Promise.resolve(state.portalVisits.get(providerId) ?? []),
    counts: () => Promise.resolve(state.counts),
    syncStatus: () => Promise.resolve(state.syncStatus),
    documentText: () => Promise.resolve(state.document),
    recordAudit: (entry) => {
      state.audits.push(entry);
      return Promise.resolve();
    },
    pruneAudit: () => {
      state.prunes += 1;
      return Promise.resolve();
    },
  };
}

/** A client connected to a real McpServer carrying the real tool registrations. */
export async function connectTools(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

export interface ToolAnswer {
  /** The serialised text block, exactly as a client receives it. */
  text: string;
  isError: boolean;
  items: Record<string, unknown>[];
  warnings: string[];
  truncated: boolean;
  raw?: { resource: Record<string, unknown> }[];
  /** Present on an error answer. */
  error?: string;
}

/** The one text block a tool answers with, or an empty string. */
function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

/**
 * The envelope, when there is one.
 *
 * A schema rejection comes back as a protocol error rendered into the text block
 * rather than as this server's JSON envelope, so parsing has to be optional.
 */
function parseEnvelope(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Call a tool and parse the one text block it answers with. */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolAnswer> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = textOf(result);
  const parsed = parseEnvelope(text);
  return {
    text,
    isError: result.isError === true,
    items: (parsed.items ?? []) as Record<string, unknown>[],
    warnings: (parsed.warnings ?? []) as string[],
    truncated: parsed.truncated === true,
    ...(parsed.raw !== undefined && { raw: parsed.raw as { resource: Record<string, unknown> }[] }),
    ...(typeof parsed.error === "string" && { error: parsed.error }),
  };
}
