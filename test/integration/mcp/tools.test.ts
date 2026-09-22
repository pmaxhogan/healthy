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
