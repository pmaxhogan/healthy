// The tools against a real D1 and the real FHIR read cache.
//
// The unit suite already drives every tool over the in-memory transport with faked
// dependencies. What this file adds is the half that cannot be faked: the cache
// rows are really sealed with AES-GCM and really read back, `settings` and
// `mcp_policy` are really rows in SQLite, and the audit trail is really written --
// so a repo signature change, a migration change or an AAD mistake fails here.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { makeCtx } from "../../../worker/db/client.ts";
import { makeRepos } from "../../../worker/db/index.ts";
import { setSetting } from "../../../worker/db/settings.ts";
import { makeToolDeps } from "../../../worker/mcp/deps-d1.ts";
import { registerTools } from "../../../worker/mcp/tools/index.ts";
import { parseUpcoming } from "../../../worker/providers/mychart/visits.ts";
import { resetDb } from "../db/helpers.ts";

import type { Repos } from "../../../worker/db/index.ts";
import type { Env } from "../../../worker/env.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** 2026-06-01T00:00:00Z. The clock every repo and every tool in this file sees. */
const NOW = 1_780_272_000;

/** A key for this isolate: nothing may commit one, not even a throwaway. */
function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

const DATA_KEY = randomDataKey();

const TEST_ENV = { ...env, DATA_KEY } as unknown as Env;

const NAME_A = "Example Health";
const NAME_B = "Other Clinic";

function repos(): Repos {
  return makeRepos(makeCtx(env.DB, TEST_ENV, { now: () => NOW }));
}

/** A DocumentReference whose text is inline, so no organisation is ever called. */
const INLINE_NOTE = {
  resourceType: "DocumentReference",
  id: "doc-inline",
  status: "current",
  date: "2026-04-01T00:00:00Z",
  type: { text: "Progress note" },
  content: [
    {
      attachment: {
        contentType: "text/html",
        // "<p>Reviewed results.</p><p>No change.</p>"
        data: btoa("<p>Reviewed results.</p><p>No change.</p>"),
      },
    },
  ],
};

interface Seeded {
  providerA: string;
  providerB: string;
}

async function seed(): Promise<Seeded> {
  const db = repos();
  const a = await db.providers.create({
    vendor: "epic",
    displayName: NAME_A,
    fhirBaseUrl: "https://a.fhir.example.test/R4",
    environment: "sandbox",
  });
  const b = await db.providers.create({
    vendor: "epic",
    displayName: NAME_B,
    fhirBaseUrl: "https://b.fhir.example.test/R4",
    environment: "sandbox",
  });

  const day = 24 * 3600 * 1000;
  await db.fhirCache.upsertMany(
    a.id,
    [
      {
        resourceType: "Patient",
        id: "pat-a",
        name: [{ family: "Person", given: ["Test"] }],
        birthDate: "1970-07-07",
        telecom: [{ system: "phone", value: "555-0100" }],
      },
      {
        resourceType: "Practitioner",
        id: "prac-1",
        name: [{ family: "Rivers", given: ["Ada"], prefix: ["Dr"] }],
      },
      {
        resourceType: "Condition",
        id: "cond-a",
        clinicalStatus: { coding: [{ code: "active" }] },
        code: { text: "Seasonal allergic rhinitis" },
        recordedDate: "2026-04-04T00:00:00Z",
      },
      {
        resourceType: "Encounter",
        id: "enc-a",
        status: "planned",
        class: { code: "AMB", display: "ambulatory" },
        type: [{ text: "Follow-up" }],
        period: { start: "2026-07-01T09:00:00Z" },
        participant: [{ individual: { reference: "Practitioner/prac-1" } }],
      },
      INLINE_NOTE,
    ],
    8 * day,
  );
  await db.fhirCache.upsertMany(
    b.id,
    [
      {
        resourceType: "Condition",
        id: "cond-b",
        clinicalStatus: { coding: [{ code: "active" }] },
        code: { text: "Migraine without aura" },
        recordedDate: "2026-02-02T00:00:00Z",
      },
    ],
    8 * day,
  );

  return { providerA: a.id, providerB: b.id };
}

async function connect(): Promise<Client> {
  const server = new McpServer({ name: "Healthy", version: "test" });
  registerTools(
    server,
    makeToolDeps({
      env: TEST_ENV,
      caller: { clientId: "client-int", grantId: "grant-int" },
      now: () => NOW,
    }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "test" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** The envelope, when the answer carried one rather than a schema complaint. */
function parseEnvelope(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface Answer {
  text: string;
  isError: boolean;
  items: Record<string, unknown>[];
  total?: number;
  truncated?: boolean;
  error?: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Answer> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  const parsed = parseEnvelope(text);
  return {
    text,
    isError: result.isError === true,
    items: (parsed.items ?? []) as Record<string, unknown>[],
    ...(typeof parsed.total === "number" && { total: parsed.total }),
    ...(typeof parsed.truncated === "boolean" && { truncated: parsed.truncated }),
    ...(typeof parsed.error === "string" && { error: parsed.error }),
  };
}

/** The world each test starts from. A holder, so `beforeEach` assigns a property. */
const world: { seeded: Seeded; client: Client } = {
  seeded: { providerA: "", providerB: "" },
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  await resetDb();
  world.seeded = await seed();
  world.client = await connect();
});

describe("reading the real cache", () => {
  it("decrypts and normalizes across both providers", async () => {
    const answer = await call(world.client, "get_conditions");

    expect(answer.items.map((item) => item.provider)).toStrictEqual([NAME_A, NAME_B]);
    expect(answer.items.map((item) => (item.code as { text?: string }).text)).toStrictEqual([
      "Seasonal allergic rhinitis",
      "Migraine without aura",
    ]);
  });

  it("resolves references out of the cache, not out of the bundle", async () => {
    const answer = await call(world.client, "get_appointments");

    expect(answer.items[0]?.practitioner).toBe("Dr Ada Rivers");
  });

  it("withholds the sensitive fields the normalizers flag, from raw as well", async () => {
    const answer = await call(world.client, "get_patient_profile", { raw: true });

    expect(answer.text).not.toContain("1970-07-07");
  });

  it("never carries a phone number in the normalized profile", async () => {
    // Normalization drops Patient.telecom entirely rather than projecting it.
    const answer = await call(world.client, "get_patient_profile");

    expect(answer.text).not.toContain("555-0100");
  });

  it("does carry it under `raw`, which is what a deny rule is for", async () => {
    // Documented consequence of the allow-all-with-deny-list design: `raw: true`
    // is the resource as the organisation sent it, minus the policy and the
    // sensitive default. A field rule is how the owner narrows it further.
    const exposed = await call(world.client, "get_patient_profile", { raw: true });
    await repos().mcpPolicy.add("field", "Patient.telecom");
    const denied = await call(world.client, "get_patient_profile", { raw: true });

    expect(exposed.text).toContain("555-0100");
    expect(denied.text).not.toContain("555-0100");
  });

  it("counts what is really in the table", async () => {
    const answer = await call(world.client, "get_health_summary");
    const counts = answer.items.filter((item) => item.kind === "count");

    expect(counts).toContainEqual({
      kind: "count",
      provider: NAME_A,
      providerId: world.seeded.providerA,
      resourceType: "Condition",
      count: 1,
    });
  });
});

describe("policy rows in D1", () => {
  it("hides a denied provider everywhere", async () => {
    await repos().mcpPolicy.add("provider", world.seeded.providerB, "test");

    for (const tool of ["list_providers", "get_conditions", "get_health_summary"]) {
      const answer = await call(world.client, tool);
      expect(answer.text, tool).not.toContain(NAME_B);
      expect(answer.text, tool).not.toContain(world.seeded.providerB);
      expect(answer.text, tool).not.toContain("Migraine");
    }
  });

  it("answers policy_denied for a denied tool", async () => {
    await repos().mcpPolicy.add("tool", "get_conditions");

    const answer = await call(world.client, "get_conditions");

    expect(answer.isError).toBe(true);
    expect(answer.error).toBe("policy_denied");
    expect(answer.text).not.toContain("rhinitis");
  });

  it("strips a denied field", async () => {
    await repos().mcpPolicy.add("field", "Condition.code.text");

    const answer = await call(world.client, "get_conditions");

    expect(answer.text).not.toContain("rhinitis");
    expect(answer.items).toHaveLength(2);
  });

  it("strips the documented field-rule example from both the normalized item and the raw resource", async () => {
    // Vuln 1 in .local/reviews/sec-entrypoints-egress.md, exercised through a
    // real tool call rather than `applyPolicy` directly: the rule targets the
    // raw vocabulary (`docs/mcp.md`'s worked example), and both the default
    // (normalized) answer and the `raw: true` projection must lose the value.
    const day = 24 * 3600 * 1000;
    await repos().fhirCache.upsertMany(
      world.seeded.providerA,
      [
        {
          resourceType: "Observation",
          id: "obs-bp",
          status: "final",
          category: [{ coding: [{ code: "vital-signs" }] }],
          code: { text: "Blood Pressure" },
          component: [
            { code: { text: "Systolic" }, valueQuantity: { value: 8_675_309.5, unit: "mmHg" } },
            { code: { text: "Diastolic" }, valueQuantity: { value: 4_241_100.25, unit: "mmHg" } },
          ],
        },
      ],
      8 * day,
    );

    // Sentinel values, not "120"/"80": a short digit run occasionally turns up
    // inside a randomly generated provider id too, and this test used to assert
    // it absent from the *whole* serialised text, which is exactly where a
    // provider id also lives. These have a decimal point, which Crockford
    // base32 (what a ULID is made of) can never contain, so no id can ever
    // collide with one.
    const before = await call(world.client, "get_vitals", { raw: true });
    expect(before.text).toContain("8675309.5");
    expect(before.text).toContain("4241100.25");

    await repos().mcpPolicy.add("field", "Observation.component[].valueQuantity.value");
    const after = await call(world.client, "get_vitals", { raw: true });

    expect(after.text).not.toContain("8675309.5");
    expect(after.text).not.toContain("4241100.25");
    // The rule names the value, not the component: the labels survive.
    expect(after.text).toContain("Systolic");
    expect(after.text).toContain("Diastolic");

    // Belt and braces: the field is structurally gone, not merely reformatted
    // to something that happens not to match the substring above.
    const parsedAfter = JSON.parse(after.text) as {
      raw: { resource: { component?: { valueQuantity?: Record<string, unknown> }[] } }[];
    };
    const components = parsedAfter.raw[0]?.resource.component ?? [];
    for (const component of components) {
      expect(component.valueQuantity).not.toHaveProperty("value");
    }
  });

  it("removes a denied resource type", async () => {
    await repos().mcpPolicy.add("resource", "Condition");

    const answer = await call(world.client, "get_conditions");

    expect(answer.items).toStrictEqual([]);
  });

  it("picks up a rule added between two calls on the same session", async () => {
    const before = await call(world.client, "get_conditions");
    await repos().mcpPolicy.add("tool", "get_conditions");
    const after = await call(world.client, "get_conditions");

    expect(before.items).toHaveLength(2);
    expect(after.error).toBe("policy_denied");
  });
});

/** `/Date(<ms>)/`, the portal's own instant encoding. */
const wcf = (iso: string): string => `/Date(${String(Date.parse(iso))})/`;

/** One synthetic `LoadUpcoming` row. */
function upcomingRow(csn: string, iso: string): Record<string, unknown> {
  return {
    CSN: csn,
    Instant: wcf(iso),
    TimeZone: "UTC",
    VisitType: "Follow-up",
    ProviderName: "P. Portal, MD",
    DepartmentName: "Portal Example Clinic",
  };
}

/**
 * Seven synthetic visits across all three `LoadUpcoming` buckets and about seven
 * months, parsed by the real parser and stored by the real repo -- the path the
 * hourly portal pass takes.
 */
async function storeSevenMonths(providerId: string): Promise<void> {
  const parsed = parseUpcoming(
    {
      InProgressVisits: [upcomingRow("csn-1", "2026-06-01T01:00:00Z")],
      NextNDaysVisits: [
        upcomingRow("csn-2", "2026-06-05T15:00:00Z"),
        upcomingRow("csn-3", "2026-06-12T15:00:00Z"),
      ],
      LaterVisitsList: [
        upcomingRow("csn-6", "2026-11-20T15:00:00Z"),
        upcomingRow("csn-4", "2026-08-10T15:00:00Z"),
        upcomingRow("csn-7", "2026-12-28T15:00:00Z"),
        upcomingRow("csn-5", "2026-09-30T15:00:00Z"),
      ],
    },
    "UTC",
  );
  await repos().portalVisits.record(providerId, parsed.visits, { complete: true });
}

describe("portal visits through the MCP", () => {
  it("returns every stored upcoming visit, soonest first, however far out", async () => {
    await storeSevenMonths(world.seeded.providerA);

    const answer = await call(world.client, "get_appointments");

    expect(
      answer.items.filter((item) => item.source === "portal").map((item) => item.csn),
    ).toStrictEqual(["csn-1", "csn-2", "csn-3", "csn-4", "csn-5", "csn-6", "csn-7"]);
    // enc-a (2026-07-01) sits between csn-3 and csn-4.
    expect(answer.items.map((item) => item.csn ?? item.encounterId)).toStrictEqual([
      "csn-1",
      "csn-2",
      "csn-3",
      "enc-a",
      "csn-4",
      "csn-5",
      "csn-6",
      "csn-7",
    ]);
  });

  it("gives one item for a visit both FHIR and the portal know about", async () => {
    const parsed = parseUpcoming(
      { NextNDaysVisits: [upcomingRow("csn-dup", "2026-07-01T09:02:00Z")] },
      "UTC",
    );
    await repos().portalVisits.record(world.seeded.providerA, parsed.visits, { complete: true });

    const answer = await call(world.client, "get_appointments");

    expect(answer.items).toHaveLength(1);
    expect(answer.items[0]).toMatchObject({
      source: "fhir",
      encounterId: "enc-a",
      practitioner: "Dr Ada Rivers",
      department: "Portal Example Clinic",
    });
  });

  it("narrows to the providers asked for and to the window", async () => {
    await storeSevenMonths(world.seeded.providerA);

    const other = await call(world.client, "get_appointments", { providers: [NAME_B] });
    const summer = await call(world.client, "get_appointments", {
      from: "2026-08-01",
      to: "2026-09-30",
    });

    expect(other.items).toStrictEqual([]);
    expect(summer.items.map((item) => item.csn)).toStrictEqual(["csn-5", "csn-4"]);
  });

  it("strips a denied field from portal items, and never serves their payload as raw", async () => {
    await storeSevenMonths(world.seeded.providerA);
    await repos().mcpPolicy.add("field", "Encounter.practitioner");

    const answer = await call(world.client, "get_appointments", { raw: true });
    const parsed = JSON.parse(answer.text) as {
      raw: { resource: Record<string, unknown> }[];
      warnings: string[];
    };

    expect(answer.text).not.toContain("P. Portal, MD");
    expect(answer.items.filter((item) => item.source === "portal")).toHaveLength(7);
    expect(parsed.raw).toHaveLength(answer.items.length);
    expect(JSON.stringify(parsed.raw)).not.toContain("Portal Example Clinic");
    expect(parsed.warnings).toContain("portal_items_have_no_raw");
  });

  it("drops portal items with a resource rule on Encounter", async () => {
    await storeSevenMonths(world.seeded.providerA);
    await repos().mcpPolicy.add("resource", "Encounter");

    const answer = await call(world.client, "get_appointments");

    expect(answer.items).toStrictEqual([]);
    expect(answer.text).not.toContain("Portal Example Clinic");
  });

  it("puts the next portal visits at the head of the summary's appointments", async () => {
    await storeSevenMonths(world.seeded.providerA);

    const answer = await call(world.client, "get_health_summary");
    const appointments = answer.items.filter(
      (item) => item.kind === "recent" && item.section === "appointments",
    );

    expect(appointments.map((item) => item.csn ?? item.encounterId)).toStrictEqual([
      "csn-1",
      "csn-2",
      "csn-3",
      "enc-a",
      "csn-4",
    ]);
  });
});

describe("no cap on how much comes back", () => {
  it("returns more than 200 cached resources when the caller passes no limit", async () => {
    const day = 24 * 3600 * 1000;
    await repos().fhirCache.upsertMany(
      world.seeded.providerA,
      Array.from({ length: 250 }, (_, index) => ({
        resourceType: "Encounter",
        id: `gen-enc-${String(index)}`,
        status: "finished",
        class: { code: "AMB", display: "ambulatory" },
        period: { start: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T09:00:00Z` },
      })),
      8 * day,
    );

    const everything = await call(world.client, "get_encounters");
    const limited = await call(world.client, "get_encounters", { limit: 10 });

    // enc-a from `seed()` plus the 250 generated here.
    expect(everything.items).toHaveLength(251);
    expect(everything.total).toBe(251);
    expect(everything.truncated).toBe(false);

    expect(limited.items).toHaveLength(10);
    expect(limited.total).toBe(251);
    expect(limited.truncated).toBe(true);
  });
});

describe("the master switch in settings", () => {
  it("turns every tool off and back on within one session", async () => {
    await setSetting(repos().ctx, "mcp_enabled", false);
    const off = await call(world.client, "get_conditions");

    await setSetting(repos().ctx, "mcp_enabled", true);
    const on = await call(world.client, "get_conditions");

    expect(off.error).toBe("mcp_disabled");
    expect(off.text).not.toContain("rhinitis");
    expect(on.items).toHaveLength(2);
  });
});

describe("the audit trail", () => {
  it("writes one row per call, with the tool, the caller and the providers", async () => {
    await call(world.client, "get_conditions");

    const rows = await repos().mcpAudit.listRecent(10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "get_conditions",
      clientId: "client-int",
      grantId: "grant-int",
      resultCount: 2,
      ok: true,
      errorCode: null,
    });
    expect(rows[0]?.providers).toStrictEqual([world.seeded.providerA, world.seeded.providerB]);
  });

  it("records a refusal with its code", async () => {
    await repos().mcpPolicy.add("tool", "get_vitals");

    await call(world.client, "get_vitals");
    const rows = await repos().mcpAudit.listRecent(10);

    expect(rows[0]).toMatchObject({ tool: "get_vitals", ok: false, errorCode: "policy_denied" });
  });

  it("stores no clinical content in any column", async () => {
    await call(world.client, "get_conditions");
    await call(world.client, "get_patient_profile");

    // Straight out of D1, every column, so nothing can hide behind a projection.
    const { results } = await env.DB.prepare("SELECT * FROM mcp_audit").all();
    const serialised = JSON.stringify(results);

    for (const fragment of ["rhinitis", "Migraine", "1970-07-07", NAME_A, NAME_B]) {
      expect(serialised, fragment).not.toContain(fragment);
    }
  });
});

describe("get_document_text", () => {
  it("decodes an inline attachment and caches the text for the next call", async () => {
    const first = await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "doc-inline",
    });
    const second = await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "doc-inline",
    });

    expect(first.items[0]?.text).toBe("Reviewed results.\nNo change.");
    expect(first.items[0]?.cached).toBe(false);
    expect(second.items[0]?.cached).toBe(true);
  });

  it("caches under the synthetic resource type, not as a FHIR resource", async () => {
    await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "doc-inline",
    });

    const row = await env.DB.prepare("SELECT resource_type FROM fhir_cache WHERE resource_type = ?")
      .bind("_binary_text")
      .first<{ resource_type: string }>();

    expect(row?.resource_type).toBe("_binary_text");
  });

  it("keeps the cached text encrypted at rest", async () => {
    await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "doc-inline",
    });

    const row = await env.DB.prepare("SELECT payload_enc FROM fhir_cache WHERE resource_type = ?")
      .bind("_binary_text")
      .first<{ payload_enc: string }>();

    expect(row?.payload_enc).toMatch(/^v1:/u);
    expect(row?.payload_enc).not.toContain("Reviewed");
  });

  it("answers not_found for a document that is not in the cache", async () => {
    const answer = await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "nope",
    });

    expect(answer.error).toBe("not_found");
  });

  it("does not report its own text cache as a resource type in the summary", async () => {
    await call(world.client, "get_document_text", {
      provider: world.seeded.providerA,
      id: "doc-inline",
    });

    const answer = await call(world.client, "get_health_summary");

    expect(answer.text).not.toContain("_binary_text");
  });
});
