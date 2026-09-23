import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";

import { OTHER_DATA_KEY, T0, clock, column, rawColumn, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("providers.create", () => {
  it("stores the row and applies the config defaults", async () => {
    const repos = testRepos();

    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(provider.id).toMatch(/^[0-9A-Z]{26}$/u);
    expect(provider.environment).toBe("prod");
    expect(provider.deleted_at).toBeNull();
    expect(provider.created_at).toBe(T0);
    expect(await repos.providers.getConfig(provider.id)).toStrictEqual({
      arrival_offsets_by_visit_type: {},
      enabled: true,
    });
  });

  it("keeps the overrides it is given", async () => {
    const repos = testRepos();

    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      brandKey: "example-health",
      portalUrl: "https://portal.example.test",
      environment: "sandbox",
      config: { arrival_offset_min: 20, org_short: "EH" },
    });

    expect(provider.brand_key).toBe("example-health");
    expect(provider.environment).toBe("sandbox");
    await expect(repos.providers.getConfig(provider.id)).resolves.toMatchObject({
      arrival_offset_min: 20,
    });
  });
});

describe("the provider client secret", () => {
  it("round-trips, and the raw column is neither the secret nor plaintext", async () => {
    const repos = testRepos();
    const secret = "an-obviously-distinctive-client-secret";

    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: secret,
    });

    expect(await repos.providers.getClientSecret(provider.id)).toBe(secret);

    const raw = await rawColumn("providers", "client_secret_enc", "id = ?", provider.id);

    expect(raw).not.toBeNull();
    expect(raw).not.toContain("distinctive");
    expect(raw ?? "").toMatch(/^v2:/u);
  });

  it("is null until one is set, and settable afterwards", async () => {
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(await repos.providers.getClientSecret(provider.id)).toBeNull();

    await repos.providers.setClientSecret(provider.id, "rotated-secret");

    expect(await repos.providers.getClientSecret(provider.id)).toBe("rotated-secret");
  });

  it("cannot be opened with a different DATA_KEY", async () => {
    // The practical consequence of rotating DATA_KEY: every sealed column is lost.
    // Better a loud crypto failure than a silently empty secret.
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: "secret",
    });

    const wrongKey = testRepos({ dataKey: OTHER_DATA_KEY });

    await expect(wrongKey.providers.getClientSecret(provider.id)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("cannot be moved to another provider's row", async () => {
    // What the AAD buys: a stolen-and-replanted ciphertext is inert.
    const repos = testRepos();
    const victim = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: "the-real-secret",
    });
    const attacker = await repos.providers.create({
      vendor: "epic",
      displayName: "Another Example Health",
      fhirBaseUrl: "https://fhir2.example.test/R4",
    });

    const stolen = await rawColumn("providers", "client_secret_enc", "id = ?", victim.id);
    await repos.ctx.db
      .prepare("UPDATE providers SET client_secret_enc = ? WHERE id = ?")
      .bind(stolen, attacker.id)
      .run();

    await expect(repos.providers.getClientSecret(attacker.id)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("reports a missing provider rather than returning null", async () => {
    const repos = testRepos();

    await expect(repos.providers.getClientSecret("NOPE")).rejects.toThrow(AppError);
    await expect(repos.providers.getConfig("NOPE")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("providers.update", () => {
  it("patches only the fields it is given", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      config: { org_short: "EH" },
    });

    time.advance(30);
    const updated = await repos.providers.update(provider.id, { displayName: "Renamed Health" });

    expect(updated?.display_name).toBe("Renamed Health");
    expect(updated?.fhir_base_url).toBe("https://fhir.example.test/R4");
    expect(updated?.updated_at).toBe(T0 + 30);
    // config_json untouched when `config` is absent.
    await expect(repos.providers.getConfig(provider.id)).resolves.toMatchObject({
      org_short: "EH",
    });
  });

  it("replaces the config wholesale, so an override can be removed", async () => {
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      config: { org_short: "EH", color_id: "5" },
    });

    await repos.providers.update(provider.id, { config: { org_short: "EH" } });

    expect(await repos.providers.getConfig(provider.id)).toStrictEqual({
      org_short: "EH",
      arrival_offsets_by_visit_type: {},
      enabled: true,
    });
  });

  it("returns null for a provider that does not exist", async () => {
    const repos = testRepos();

    expect(await repos.providers.update("NOPE", { displayName: "x" })).toBeNull();
  });
});

describe("providers.softDelete and list", () => {
  it("hides a deleted provider but keeps the row", async () => {
    const repos = testRepos();
    const keep = await repos.providers.create({
      vendor: "epic",
      displayName: "A Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });
    const drop = await repos.providers.create({
      vendor: "epic",
      displayName: "B Example Health",
      fhirBaseUrl: "https://fhir2.example.test/R4",
    });

    expect(await repos.providers.softDelete(drop.id)).toBe(true);

    expect(await column(repos.providers.list(), "id")).toStrictEqual([keep.id]);
    expect(await column(repos.providers.list({ includeDeleted: true }), "id")).toStrictEqual([
      keep.id,
      drop.id,
    ]);
    await expect(repos.providers.get(drop.id)).resolves.toMatchObject({ deleted_at: T0 });
  });

  it("is idempotent: deleting twice reports no second change", async () => {
    const repos = testRepos();
    const provider = await repos.providers.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(await repos.providers.softDelete(provider.id)).toBe(true);
    expect(await repos.providers.softDelete(provider.id)).toBe(false);
  });
});

describe("what providers stores", () => {
  it("seals every column that names the organisation, and reads them back opened", async () => {
    const repos = testRepos();
    const created = await repos.providers.create({
      vendor: "epic",
      displayName: "Distinctive Example Health",
      fhirBaseUrl: "https://fhir.distinctive.example.test/R4",
      brandKey: "brand-distinctive",
      portalUrl: "https://portal.distinctive.example.test",
    });

    const raw = await env.DB.prepare("SELECT * FROM providers WHERE id = ?")
      .bind(created.id)
      .first();
    expect(JSON.stringify(raw)).not.toContain("distinctive");
    for (const column of ["display_name", "fhir_base_url", "brand_key", "portal_url"]) {
      expect(String(raw?.[column]), column).toMatch(/^v2:/u);
    }

    await expect(repos.providers.get(created.id)).resolves.toMatchObject({
      display_name: "Distinctive Example Health",
      fhir_base_url: "https://fhir.distinctive.example.test/R4",
      brand_key: "brand-distinctive",
      portal_url: "https://portal.distinctive.example.test",
    });
  });

  it("still sorts the list by name, now that the name is sealed", async () => {
    const repos = testRepos();
    for (const name of ["Charlie Health", "Alpha Health", "Bravo Health"]) {
      await repos.providers.create({
        vendor: "epic",
        displayName: name,
        fhirBaseUrl: "https://fhir.example.test/R4",
      });
    }

    expect(await column(repos.providers.list(), "display_name")).toStrictEqual([
      "Alpha Health",
      "Bravo Health",
      "Charlie Health",
    ]);
  });

  it("reads an update made in the same second as a cached read", async () => {
    const repos = testRepos();
    const created = await repos.providers.create({
      vendor: "epic",
      displayName: "Before",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });
    await repos.providers.get(created.id);

    await repos.providers.update(created.id, { displayName: "After" });

    await expect(repos.providers.get(created.id)).resolves.toMatchObject({
      display_name: "After",
    });
  });
});
