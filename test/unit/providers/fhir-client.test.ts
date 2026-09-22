import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";
import { noopLogger } from "../../../worker/lib/log.ts";
import {
  createFhirClient,
  DEFAULT_MAX_PAGES,
  fhirUrl,
  sameOrigin,
  searchUrl,
} from "../../../worker/providers/epic/fhir-client.ts";

import { FAST_RETRY, jsonResponse, loadFixture, stubFetch, TEST_FHIR_BASE } from "./fixtures.ts";

import type {
  Bundle,
  Encounter,
  OperationOutcome,
  Patient,
  Resource,
} from "../../../worker/fhir/types.ts";
import type {
  FhirClient,
  FhirClientDeps,
  SearchOptions,
  SearchResult,
} from "../../../worker/providers/epic/fhir-client.ts";

const page1 = loadFixture<Bundle>("encounter-bundle-page1.json");
const page2 = loadFixture<Bundle>("encounter-bundle-page2.json");
const page3 = loadFixture<Bundle>("encounter-bundle-page3.json");
const noResults = loadFixture<Bundle>("outcome-4101.json");
const mixed = loadFixture<Bundle>("outcome-4119-mixed.json");
const pagingExpired = loadFixture<OperationOutcome>("outcome-4113.json");

const PATIENT = "synthetic-patient-1";
const SEARCH_PARAMS = { patient: PATIENT, date: "ge2026-06-23", _count: "100" };

function client(fetchImpl: typeof fetch, extra: Partial<FhirClientDeps> = {}): FhirClient {
  const deps: FhirClientDeps = {
    baseUrl: TEST_FHIR_BASE,
    getAccessToken: () => Promise.resolve("token-1"),
    fetchImpl,
    logger: noopLogger,
    now: () => 0,
    retry: FAST_RETRY,
    ...extra,
  };
  return createFhirClient(deps);
}

async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected the promise to reject");
}

/** Answer the three encounter pages in order, keyed by continuation token. */
function pagedStub(): ReturnType<typeof stubFetch> {
  return stubFetch((call) => {
    if (call.url.includes("synthetic-page-2")) return jsonResponse(page2);
    return jsonResponse(call.url.includes("synthetic-page-3") ? page3 : page1);
  });
}

describe("url helpers", () => {
  it("resolves paths with and without a trailing slash on the base", () => {
    expect(fhirUrl(TEST_FHIR_BASE, "metadata")).toBe(`${TEST_FHIR_BASE}/metadata`);
    expect(fhirUrl(`${TEST_FHIR_BASE}/`, "Encounter/enc-1")).toBe(
      `${TEST_FHIR_BASE}/Encounter/enc-1`,
    );
  });

  it("builds a search URL with every parameter", () => {
    const url = new URL(searchUrl(TEST_FHIR_BASE, "Encounter", SEARCH_PARAMS));

    expect(url.pathname).toBe("/api/FHIR/R4/Encounter");
    expect(url.searchParams.get("patient")).toBe(PATIENT);
    expect(url.searchParams.get("date")).toBe("ge2026-06-23");
    expect(url.searchParams.get("_count")).toBe("100");
  });

  it("accepts a same-origin next link and rejects anything else", () => {
    expect(sameOrigin(`${TEST_FHIR_BASE}/Encounter?continue-token=x`, TEST_FHIR_BASE)).toBe(true);
    expect(sameOrigin("https://elsewhere.example.test/Encounter", TEST_FHIR_BASE)).toBe(false);
    // Same host, different port: still a different origin.
    expect(sameOrigin("https://fhir.example-health.test:8443/api", TEST_FHIR_BASE)).toBe(false);
    expect(sameOrigin("not a url", TEST_FHIR_BASE)).toBe(false);
  });

  it("defaults to 20 pages", () => {
    expect(DEFAULT_MAX_PAGES).toBe(20);
  });
});

describe("search paging", () => {
  it("follows next links through three pages and de-duplicates by Type/id", async () => {
    const stub = pagedStub();

    const result: SearchResult<Resource> = await client(stub.fetchImpl).search(
      "Encounter",
      SEARCH_PARAMS,
    );

    expect(result.pages).toBe(3);
    expect(stub.calls).toHaveLength(3);
    // Five matched Encounters plus the Location that came in as an include.
    expect(result.resources).toHaveLength(6);
    expect(
      result.resources.filter((resource) => resource.resourceType === "Encounter"),
    ).toHaveLength(5);
    expect(new Set(result.resources.map((resource) => resource.id)).size).toBe(6);
  });

  it("asks for FHIR JSON and sends the bearer token on every page", async () => {
    const stub = pagedStub();

    await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    for (const call of stub.calls) {
      expect(call.headers.accept, call.url).toBe("application/fhir+json");
      expect(call.headers.authorization, call.url).toBe("Bearer token-1");
    }
  });

  it("stops at maxPages and warns instead of truncating silently", async () => {
    const stub = pagedStub();
    const options: SearchOptions = { maxPages: 2 };

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS, options);

    expect(result.pages).toBe(2);
    expect(result.warnings.map((warning) => warning.code)).toContain("incomplete");
  });

  it("refuses to follow a next link that points at another origin", async () => {
    const offOrigin: Bundle = {
      ...page1,
      link: [{ relation: "next", url: "https://attacker.example.test/api/FHIR/R4/Encounter" }],
    };
    const stub = stubFetch(() => jsonResponse(offOrigin));

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    // Following it would put the bearer token on a third-party request.
    expect(stub.calls).toHaveLength(1);
    expect(result.pages).toBe(1);
  });
});

describe("OperationOutcome handling", () => {
  it("skips outcome entries but keeps their issues as warnings", async () => {
    const stub = pagedStub();

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    // Page 3 carries an informational outcome entry alongside one Encounter.
    expect(result.warnings.map((warning) => warning.epicCode)).toStrictEqual(["4103"]);
    expect(result.resources.some((resource) => resource.resourceType === "OperationOutcome")).toBe(
      false,
    );
  });

  it("treats 4101 as an empty result, not an error", async () => {
    const stub = stubFetch(() => jsonResponse(noResults));

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    expect(result.resources).toStrictEqual([]);
    expect(result.pages).toBe(1);
    expect(result.warnings[0]?.epicCode).toBe("4101");
  });

  it("treats a bare OperationOutcome body as an empty result too", async () => {
    // Epic answers some empty searches with a top-level OperationOutcome rather
    // than an empty Bundle. Branching on resourceType is what keeps that from
    // looking like a parse failure.
    const stub = stubFetch(() =>
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [
          { severity: "warning", code: "not-found", details: { coding: [{ code: "4101" }] } },
        ],
      }),
    );

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    expect(result.resources).toStrictEqual([]);
    expect(result.warnings[0]?.epicCode).toBe("4101");
  });

  it("surfaces 4119 as a warning and still returns the results it did get", async () => {
    const stub = stubFetch(() => jsonResponse(mixed));

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    expect(result.resources).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.epicCode)).toStrictEqual(["4119", "4122"]);
  });

  it("maps 4118 to upstream_auth", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "forbidden", details: { coding: [{ code: "4118" }] } }],
      }),
    );

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_auth");
    expect(error.details).toMatchObject({ resourceType: "Encounter", epicCodes: ["4118"] });
  });

  it("maps an unrecognised fatal issue to upstream_error", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "fatal", code: "processing", details: { coding: [{ code: "4100" }] } }],
      }),
    );

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_error");
  });
});

describe("paging session expiry (4113)", () => {
  it("restarts the whole search once, from the first page", async () => {
    let expired = false;
    const stub = stubFetch((call) => {
      if (!expired && call.url.includes("synthetic-page-2")) {
        expired = true;
        return jsonResponse(pagingExpired, { status: 400 });
      }
      if (call.url.includes("synthetic-page-2")) return jsonResponse(page2);
      return jsonResponse(call.url.includes("synthetic-page-3") ? page3 : page1);
    });

    const result = await client(stub.fetchImpl).search<Encounter>("Encounter", SEARCH_PARAMS);

    // page1, page2(400), then page1, page2, page3.
    expect(stub.calls).toHaveLength(5);
    expect(result.pages).toBe(3);
    expect(result.resources).toHaveLength(6);
  });

  it("gives up with upstream_unavailable if the restart expires too", async () => {
    const stub = stubFetch((call) =>
      call.url.includes("continue-token")
        ? jsonResponse(pagingExpired, { status: 400 })
        : jsonResponse(page1),
    );

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_unavailable");
    expect(stub.calls).toHaveLength(4);
  });
});

describe("authorization failures", () => {
  it("refreshes through onUnauthorized once and retries the request", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve("token-2"));
    const stub = stubFetch((call) =>
      call.headers.authorization === "Bearer token-1"
        ? new Response("", { status: 401 })
        : jsonResponse(page3),
    );

    const result = await client(stub.fetchImpl, { onUnauthorized }).search(
      "Encounter",
      SEARCH_PARAMS,
    );

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.headers.authorization).toBe("Bearer token-2");
    expect(result.resources).toHaveLength(1);
  });

  it("gives up with upstream_auth when the refreshed token is rejected too", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve("token-2"));
    const stub = stubFetch(() => new Response("", { status: 401 }));

    const error = await expectAppError(
      client(stub.fetchImpl, { onUnauthorized }).search("Encounter", SEARCH_PARAMS),
    );

    expect(error.code).toBe("upstream_auth");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(stub.calls).toHaveLength(2);
  });

  it("does not retry a 401 at all when no hook was provided", async () => {
    const stub = stubFetch(() => new Response("", { status: 401 }));

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_auth");
    expect(stub.calls).toHaveLength(1);
  });

  it("never retries a 403, because that is a registration mismatch", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve("token-2"));
    const stub = stubFetch(() =>
      jsonResponse(
        {
          resourceType: "OperationOutcome",
          issue: [
            { severity: "error", code: "forbidden", details: { coding: [{ code: "59109" }] } },
          ],
        },
        { status: 403 },
      ),
    );

    const error = await expectAppError(
      client(stub.fetchImpl, { onUnauthorized }).search("Encounter", SEARCH_PARAMS),
    );

    expect(error.code).toBe("upstream_auth");
    expect(error.details).toMatchObject({ status: 403, epicCodes: ["59109"] });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(stub.calls).toHaveLength(1);
  });
});

describe("transient failures", () => {
  it("retries a 429 and succeeds", async () => {
    let attempts = 0;
    const stub = stubFetch(() => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 429, headers: { "retry-after": "1" } })
        : jsonResponse(page3);
    });

    const result = await client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS);

    expect(stub.calls).toHaveLength(2);
    expect(result.resources).toHaveLength(1);
  });

  it("reports an exhausted 429 as upstream_unavailable and carries Retry-After", async () => {
    const stub = stubFetch(
      () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_unavailable");
    expect(error.retryAfterMs).toBe(30_000);
    expect(stub.calls).toHaveLength(4);
  });

  it("reports an exhausted 5xx as upstream_unavailable", async () => {
    const stub = stubFetch(() => new Response("", { status: 503 }));

    const error = await expectAppError(client(stub.fetchImpl).search("Encounter", SEARCH_PARAMS));

    expect(error.code).toBe("upstream_unavailable");
    expect(error.details).toMatchObject({ status: 503 });
  });
});

describe("read", () => {
  it("fetches one resource by id", async () => {
    const stub = stubFetch(() => jsonResponse({ resourceType: "Patient", id: PATIENT }));

    const patient = await client(stub.fetchImpl).read<Patient>("Patient", PATIENT);

    expect(stub.calls[0]?.url).toBe(`${TEST_FHIR_BASE}/Patient/${PATIENT}`);
    expect(patient?.id).toBe(PATIENT);
  });

  it("returns null for a 404 rather than throwing", async () => {
    const stub = stubFetch(() => new Response("", { status: 404 }));

    await expect(client(stub.fetchImpl).read("Location", "loc-missing")).resolves.toBeNull();
  });

  it("maps 4118 on a read to upstream_auth", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "forbidden", details: { coding: [{ code: "4118" }] } }],
      }),
    );

    const error = await expectAppError(client(stub.fetchImpl).read("Practitioner", "prac-1"));

    expect(error.code).toBe("upstream_auth");
  });

  it("returns null rather than handing back an OperationOutcome as the resource", async () => {
    const stub = stubFetch(() =>
      jsonResponse({
        resourceType: "OperationOutcome",
        issue: [
          { severity: "warning", code: "not-found", details: { coding: [{ code: "4101" }] } },
        ],
      }),
    );

    await expect(client(stub.fetchImpl).read("Practitioner", "prac-1")).resolves.toBeNull();
  });

  it("refuses a body of the wrong resource type", async () => {
    const stub = stubFetch(() => jsonResponse({ resourceType: "Patient", id: PATIENT }));

    const error = await expectAppError(client(stub.fetchImpl).read("Practitioner", "prac-1"));

    expect(error.code).toBe("upstream_error");
  });

  it("percent-encodes the id", async () => {
    const stub = stubFetch(() => new Response("", { status: 404 }));

    await client(stub.fetchImpl).read("Binary", "a/b c");

    expect(stub.calls[0]?.url).toBe(`${TEST_FHIR_BASE}/Binary/a%2Fb%20c`);
  });
});
