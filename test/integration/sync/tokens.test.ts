// The token manager's refresh margin, per vendor, against real D1.
//
// ModMed's access tokens live five minutes, so its adapter asks for a one-minute
// margin; Epic keeps the five-minute default. The same token, three minutes from
// expiry, is therefore stale for one and comfortably fresh for the other.

import { beforeEach, describe, expect, it } from "vitest";

import { withAccessToken } from "../../../worker/sync/tokens.ts";

import {
  fhirServer,
  resetSyncDb,
  seedConnectedHealthSystem,
  stubUpstreams,
  syncCtx,
} from "./helpers.ts";

beforeEach(resetSyncDb);

const THREE_MINUTES = 180;
const THIRTY_SECONDS = 30;

describe("the refresh margin", () => {
  it("refreshes an Epic token with three minutes left", async () => {
    const ctx = syncCtx();
    const host = "fhir.a.example.test";
    const server = fhirServer();
    const upstreams = stubUpstreams({ [host]: server });
    const seeded = await seedConnectedHealthSystem(ctx, {
      host,
      vendor: "epic",
      accessTtlSeconds: THREE_MINUTES,
    });

    const handle = await withAccessToken(ctx, seeded.healthSystemId, upstreams.deps);
    const token = await handle.getAccessToken();

    expect(handle.adapter.refreshSkewMs).toBe(300_000);
    expect(server.tokenCalls).toBe(1);
    expect(token).toBe("refreshed-access-token");
  });

  it("keeps a ModMed token with three minutes left", async () => {
    const ctx = syncCtx();
    const host = "fhir.b.example.test";
    const server = fhirServer();
    const upstreams = stubUpstreams({ [host]: server });
    const seeded = await seedConnectedHealthSystem(ctx, {
      host,
      vendor: "modmed",
      accessTtlSeconds: THREE_MINUTES,
    });

    const handle = await withAccessToken(ctx, seeded.healthSystemId, upstreams.deps);
    const token = await handle.getAccessToken();

    expect(handle.adapter.refreshSkewMs).toBe(60_000);
    expect(server.tokenCalls).toBe(0);
    expect(token).toBe("seeded-access-token");
  });

  it("still refreshes a ModMed token inside its one-minute margin", async () => {
    const ctx = syncCtx();
    const host = "fhir.b.example.test";
    const server = fhirServer();
    const upstreams = stubUpstreams({ [host]: server });
    const seeded = await seedConnectedHealthSystem(ctx, {
      host,
      vendor: "modmed",
      accessTtlSeconds: THIRTY_SECONDS,
    });

    const handle = await withAccessToken(ctx, seeded.healthSystemId, upstreams.deps);
    const token = await handle.getAccessToken();

    expect(server.tokenCalls).toBe(1);
    expect(token).toBe("refreshed-access-token");
  });
});
