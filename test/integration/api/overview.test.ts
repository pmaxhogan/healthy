// `GET /api/overview` -- the whole dashboard in one request.
//
// Two things are asserted here that nothing else covers: the shape (every panel the
// SPA renders is present, with the right kinds of value), and that the grant count
// degrades to zero instead of taking the dashboard down when the OAuth provider's KV
// store cannot be reached. The second matters because the dashboard is where the
// owner would find out what is wrong.

import { afterEach, describe, expect, it } from "vitest";

import {
  blindKey,
  freshOwner,
  json,
  resetPorts,
  seedProvider,
  testRepos,
  usePorts,
} from "./helpers.ts";

import type { GoogleAccountDto, OverviewDto } from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

describe("GET /api/overview", () => {
  it("answers with every panel on an empty deployment", async () => {
    const dto = await json<OverviewDto>(await owner().get("/api/overview"));

    expect(dto.providers).toStrictEqual([]);
    expect(dto.openAlerts).toStrictEqual([]);
    expect(dto.lastRuns).toStrictEqual([]);
    expect(dto.cacheCounts).toStrictEqual([]);
    expect(dto.calendarEvents).toStrictEqual({ active: 0, ghost: 0 });
    expect(dto.mcp).toStrictEqual({ enabled: true, grants: 0, auditLast24h: 0, policyRules: 0 });
    expect(dto.google.status).toBe("not_connected");
    expect(dto.settings.calendarId).toBe("primary");
  });

  it("counts active and ghosted calendar events separately", async () => {
    const id = await seedProvider();
    const repos = testRepos();
    for (const key of ["a", "b", "c"]) {
      await repos.calendarEvents.upsert({
        eventKey: await blindKey(`${id}:${key}`),
        providerId: id,
        encounterId: key,
        calendarId: "primary",
        googleEventId: `gcal-${key}`,
        fingerprint: `fp-${key}`,
      });
    }
    await repos.calendarEvents.markGhost(await blindKey(`${id}:c`));

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));

    expect(dto.calendarEvents).toStrictEqual({ active: 2, ghost: 1 });
  });

  it("counts cached resources per provider and type, without decrypting any of them", async () => {
    const id = await seedProvider();
    await testRepos().fhirCache.upsertMany(
      id,
      [
        { resourceType: "Encounter", id: "enc-1" },
        { resourceType: "Encounter", id: "enc-2" },
        { resourceType: "Condition", id: "cond-1" },
      ],
      60_000,
    );

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));

    expect(dto.cacheCounts).toStrictEqual([
      { providerId: id, resourceType: "Condition", count: 1 },
      { providerId: id, resourceType: "Encounter", count: 2 },
    ]);
    // Counts only: no payload, no ciphertext.
    expect(JSON.stringify(dto)).not.toContain("payload");
  });

  it("leaves the sync engine's own bookkeeping rows out of the record counts", async () => {
    // `fhir_cache` also holds one `_smart` and one `_capability` row per provider --
    // a discovery document and an indexed CapabilityStatement. Counting those would
    // report two cached "records" for a provider that has never been synced.
    const id = await seedProvider();
    await testRepos().fhirCache.upsertMany(
      id,
      [
        { resourceType: "_smart", id: "v1" },
        { resourceType: "_capability", id: "v1" },
        { resourceType: "Encounter", id: "enc-1" },
      ],
      60_000,
    );

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));

    expect(dto.cacheCounts).toStrictEqual([
      { providerId: id, resourceType: "Encounter", count: 1 },
    ]);
  });

  it("counts MCP policy rules and recent audit rows", async () => {
    const repos = testRepos();
    await repos.mcpPolicy.add("resource", "DocumentReference");
    await repos.mcpPolicy.add("tool", "get_documents");
    await repos.mcpAudit.insert({ tool: "get_vitals" });

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));

    expect(dto.mcp.policyRules).toBe(2);
    expect(dto.mcp.auditLast24h).toBe(1);
  });

  it("excludes an audit row older than a day from auditLast24h", async () => {
    const repos = testRepos();
    await repos.mcpAudit.insert({ tool: "old" });
    await repos.ctx.db.prepare("UPDATE mcp_audit SET ts = 0").run();

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));
    expect(dto.mcp.auditLast24h).toBe(0);
  });

  it("reports the grants it can see", async () => {
    usePorts({
      grants: {
        listGrants: () => Promise.resolve([{ id: "g1" }, { id: "g2" }]),
        revokeGrant: () => Promise.resolve(true),
      },
    });

    const dto = await json<OverviewDto>(await owner().get("/api/overview"));
    expect(dto.mcp.grants).toBe(2);
  });

  it("still answers 200 with zero grants when the grant store is unreachable", async () => {
    usePorts({
      grants: {
        listGrants: () => Promise.reject(new Error("KV unavailable")),
        revokeGrant: () => Promise.resolve(false),
      },
    });

    const response = await owner().get("/api/overview");

    const dto = await json<OverviewDto>(response);
    expect(response.status).toBe(200);
    expect(dto.mcp.grants).toBe(0);
  });

  it("includes each provider with its connection and no secrets", async () => {
    const id = await seedProvider({ clientSecret: "the-secret" });
    await testRepos().connections.upsertTokens(id, {
      accessToken: "access",
      refreshToken: "refresh",
      status: "connected",
    });

    const response = await owner().get("/api/overview");
    const body = await response.text();
    const dto = JSON.parse(body) as OverviewDto;

    expect(dto.providers).toHaveLength(1);
    expect(dto.providers[0]?.hasClientSecret).toBe(true);
    expect(dto.providers[0]?.connection?.status).toBe("connected");
    expect(dto.providers[0]?.connection?.hasRefreshToken).toBe(true);
    for (const secret of ["the-secret", "access", "refresh"]) {
      expect(body).not.toContain(`"${secret}"`);
    }
    expect(body).not.toMatch(/[a-z]_enc/);
  });

  it("agrees with GET /api/google about the calendar account", async () => {
    const overview = await json<OverviewDto>(await owner().get("/api/overview"));
    const google = await json<GoogleAccountDto>(await owner().get("/api/google"));

    expect(overview.google).toStrictEqual(google);
  });

  it("is never cached", async () => {
    const response = await owner().get("/api/overview");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
