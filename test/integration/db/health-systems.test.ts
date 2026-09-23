import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";

import { OTHER_DATA_KEY, T0, clock, column, rawColumn, resetDb, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("health_systems.create", () => {
  it("stores the row and applies the config defaults", async () => {
    const repos = testRepos();

    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(healthSystem.id).toMatch(/^[0-9A-Z]{26}$/u);
    expect(healthSystem.environment).toBe("prod");
    expect(healthSystem.deleted_at).toBeNull();
    expect(healthSystem.created_at).toBe(T0);
    expect(await repos.healthSystems.getConfig(healthSystem.id)).toStrictEqual({
      arrival_offsets_by_visit_type: {},
      enabled: true,
    });
  });

  it("keeps the overrides it is given", async () => {
    const repos = testRepos();

    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      brandKey: "example-health",
      portalUrl: "https://portal.example.test",
      environment: "sandbox",
      config: { arrival_offset_min: 20, org_short: "EH" },
    });

    expect(healthSystem.brand_key).toBe("example-health");
    expect(healthSystem.environment).toBe("sandbox");
    await expect(repos.healthSystems.getConfig(healthSystem.id)).resolves.toMatchObject({
      arrival_offset_min: 20,
    });
  });
});

describe("the health system client secret", () => {
  it("round-trips, and the raw column is neither the secret nor plaintext", async () => {
    const repos = testRepos();
    const secret = "an-obviously-distinctive-client-secret";

    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: secret,
    });

    expect(await repos.healthSystems.getClientSecret(healthSystem.id)).toBe(secret);

    const raw = await rawColumn("health_systems", "client_secret_enc", "id = ?", healthSystem.id);

    expect(raw).not.toBeNull();
    expect(raw).not.toContain("distinctive");
    expect(raw ?? "").toMatch(/^v2:/u);
  });

  it("is null until one is set, and settable afterwards", async () => {
    const repos = testRepos();
    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(await repos.healthSystems.getClientSecret(healthSystem.id)).toBeNull();

    await repos.healthSystems.setClientSecret(healthSystem.id, "rotated-secret");

    expect(await repos.healthSystems.getClientSecret(healthSystem.id)).toBe("rotated-secret");
  });

  it("cannot be opened with a different DATA_KEY", async () => {
    // The practical consequence of rotating DATA_KEY: every sealed column is lost.
    // Better a loud crypto failure than a silently empty secret.
    const repos = testRepos();
    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: "secret",
    });

    const wrongKey = testRepos({ dataKey: OTHER_DATA_KEY });

    await expect(wrongKey.healthSystems.getClientSecret(healthSystem.id)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("cannot be moved to another health system's row", async () => {
    // What the AAD buys: a stolen-and-replanted ciphertext is inert.
    const repos = testRepos();
    const victim = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      clientSecret: "the-real-secret",
    });
    const attacker = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Another Example Health",
      fhirBaseUrl: "https://fhir2.example.test/R4",
    });

    const stolen = await rawColumn("health_systems", "client_secret_enc", "id = ?", victim.id);
    await repos.ctx.db
      .prepare("UPDATE health_systems SET client_secret_enc = ? WHERE id = ?")
      .bind(stolen, attacker.id)
      .run();

    await expect(repos.healthSystems.getClientSecret(attacker.id)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("reports a missing health system rather than returning null", async () => {
    const repos = testRepos();

    await expect(repos.healthSystems.getClientSecret("NOPE")).rejects.toThrow(AppError);
    await expect(repos.healthSystems.getConfig("NOPE")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("health_systems.update", () => {
  it("patches only the fields it is given", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      config: { org_short: "EH" },
    });

    time.advance(30);
    const updated = await repos.healthSystems.update(healthSystem.id, {
      displayName: "Renamed Health",
    });

    expect(updated?.display_name).toBe("Renamed Health");
    expect(updated?.fhir_base_url).toBe("https://fhir.example.test/R4");
    expect(updated?.updated_at).toBe(T0 + 30);
    // config_json untouched when `config` is absent.
    await expect(repos.healthSystems.getConfig(healthSystem.id)).resolves.toMatchObject({
      org_short: "EH",
    });
  });

  it("replaces the config wholesale, so an override can be removed", async () => {
    const repos = testRepos();
    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
      config: { org_short: "EH", color_id: "5" },
    });

    await repos.healthSystems.update(healthSystem.id, { config: { org_short: "EH" } });

    expect(await repos.healthSystems.getConfig(healthSystem.id)).toStrictEqual({
      org_short: "EH",
      arrival_offsets_by_visit_type: {},
      enabled: true,
    });
  });

  it("returns null for a health system that does not exist", async () => {
    const repos = testRepos();

    expect(await repos.healthSystems.update("NOPE", { displayName: "x" })).toBeNull();
  });
});

describe("health systems.softDelete and list", () => {
  it("hides a deleted health system but keeps the row", async () => {
    const repos = testRepos();
    const keep = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "A Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });
    const drop = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "B Example Health",
      fhirBaseUrl: "https://fhir2.example.test/R4",
    });

    expect(await repos.healthSystems.softDelete(drop.id)).toBe(true);

    expect(await column(repos.healthSystems.list(), "id")).toStrictEqual([keep.id]);
    expect(await column(repos.healthSystems.list({ includeDeleted: true }), "id")).toStrictEqual([
      keep.id,
      drop.id,
    ]);
    await expect(repos.healthSystems.get(drop.id)).resolves.toMatchObject({ deleted_at: T0 });
  });

  it("is idempotent: deleting twice reports no second change", async () => {
    const repos = testRepos();
    const healthSystem = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Example Health",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });

    expect(await repos.healthSystems.softDelete(healthSystem.id)).toBe(true);
    expect(await repos.healthSystems.softDelete(healthSystem.id)).toBe(false);
  });
});

describe("what health systems stores", () => {
  it("seals every column that names the organisation, and reads them back opened", async () => {
    const repos = testRepos();
    const created = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Distinctive Example Health",
      fhirBaseUrl: "https://fhir.distinctive.example.test/R4",
      brandKey: "brand-distinctive",
      portalUrl: "https://portal.distinctive.example.test",
    });

    const raw = await env.DB.prepare("SELECT * FROM health_systems WHERE id = ?")
      .bind(created.id)
      .first();
    expect(JSON.stringify(raw)).not.toContain("distinctive");
    for (const column of [
      "display_name_enc",
      "fhir_base_url_enc",
      "brand_key_enc",
      "portal_url_enc",
      "config_enc",
    ]) {
      expect(String(raw?.[column]), column).toMatch(/^v2:/u);
    }

    await expect(repos.healthSystems.get(created.id)).resolves.toMatchObject({
      display_name: "Distinctive Example Health",
      fhir_base_url: "https://fhir.distinctive.example.test/R4",
      brand_key: "brand-distinctive",
      portal_url: "https://portal.distinctive.example.test",
    });
  });

  it("still sorts the list by name, now that the name is sealed", async () => {
    const repos = testRepos();
    for (const name of ["Charlie Health", "Alpha Health", "Bravo Health"]) {
      await repos.healthSystems.create({
        vendor: "epic",
        displayName: name,
        fhirBaseUrl: "https://fhir.example.test/R4",
      });
    }

    expect(await column(repos.healthSystems.list(), "display_name")).toStrictEqual([
      "Alpha Health",
      "Bravo Health",
      "Charlie Health",
    ]);
  });

  it("reads an update made in the same second as a cached read", async () => {
    const repos = testRepos();
    const created = await repos.healthSystems.create({
      vendor: "epic",
      displayName: "Before",
      fhirBaseUrl: "https://fhir.example.test/R4",
    });
    await repos.healthSystems.get(created.id);

    await repos.healthSystems.update(created.id, { displayName: "After" });

    await expect(repos.healthSystems.get(created.id)).resolves.toMatchObject({
      display_name: "After",
    });
  });
});
