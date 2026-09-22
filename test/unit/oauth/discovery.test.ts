// The SMART discovery cache.
//
// The trailing-slash case is the one that matters. Epic matches the authorize
// request's `aud` against the registered FHIR base as a *string*, so two bases that
// differ only by a trailing slash are genuinely different configurations. A cache
// that normalised the key would serve one organisation's endpoints under the
// other's identity, and the failure would be a redirect that silently never comes
// back.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISCOVERY_TTL_MS,
  clearDiscoveryCache,
  discoverCached,
} from "../../../worker/oauth/discovery.ts";
import smartConfiguration from "../../fixtures/epic/smart-configuration.json";

const BASE = "https://fhir.example.test/R4";

function okJson(body: unknown): Response {
  return Response.json(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that counts its calls and always answers with the fixture. */
function countingFetch(): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  // `unknown`, not `RequestInfo`: this project's unit tests run in plain Node,
  // whose lib does not declare the Worker fetch input types.
  const fetchImpl = vi.fn((input: unknown) => {
    calls.push(String(input));
    return Promise.resolve(okJson(smartConfiguration));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  clearDiscoveryCache();
});

describe("discoverCached", () => {
  it("parses the authorize and token endpoints out of the document", async () => {
    const { fetchImpl, calls } = countingFetch();

    const config = await discoverCached("epic", BASE, { fetchImpl });

    expect(config.authorizeUrl).toBe(smartConfiguration.authorization_endpoint);
    expect(config.tokenUrl).toBe(smartConfiguration.token_endpoint);
    expect(config.pkceMethods).toContain("S256");
    expect(calls[0]).toBe(`${BASE}/.well-known/smart-configuration`);
  });

  it("fetches once for repeated calls on the same base", async () => {
    const { fetchImpl, calls } = countingFetch();

    await discoverCached("epic", BASE, { fetchImpl });
    await discoverCached("epic", BASE, { fetchImpl });

    expect(calls).toHaveLength(1);
  });

  it("treats a trailing slash as a different endpoint, because Epic does", async () => {
    const { fetchImpl, calls } = countingFetch();

    await discoverCached("epic", BASE, { fetchImpl });
    await discoverCached("epic", `${BASE}/`, { fetchImpl });

    expect(calls).toHaveLength(2);
  });

  it("re-fetches once the entry has expired", async () => {
    const { fetchImpl, calls } = countingFetch();
    const clock = { at: 1_000_000 };
    const nowMs = (): number => clock.at;

    await discoverCached("epic", BASE, { fetchImpl, nowMs });
    clock.at += DISCOVERY_TTL_MS + 1;
    await discoverCached("epic", BASE, { fetchImpl, nowMs });

    expect(calls).toHaveLength(2);
  });

  it("keeps the entry for the whole TTL", async () => {
    const { fetchImpl, calls } = countingFetch();
    const clock = { at: 1_000_000 };
    const nowMs = (): number => clock.at;

    await discoverCached("epic", BASE, { fetchImpl, nowMs });
    clock.at += DISCOVERY_TTL_MS - 1000;
    await discoverCached("epic", BASE, { fetchImpl, nowMs });

    expect(calls).toHaveLength(1);
  });

  it("does not cache a document that had no OAuth endpoints", async () => {
    const bad = { ...smartConfiguration, token_endpoint: undefined };
    const fetchImpl = vi.fn(() => Promise.resolve(okJson(bad))) as unknown as typeof fetch;

    await expect(discoverCached("epic", BASE, { fetchImpl })).rejects.toThrow();

    // The second attempt must reach upstream again rather than replay the failure.
    const good = countingFetch();
    const config = await discoverCached("epic", BASE, { fetchImpl: good.fetchImpl });
    expect(config.tokenUrl).toBe(smartConfiguration.token_endpoint);
  });

  it("refuses a vendor with no adapter", async () => {
    const { fetchImpl } = countingFetch();

    await expect(discoverCached("oracle", BASE, { fetchImpl })).rejects.toThrow();
  });
});
