/**
 * Fixture loading and a scripted `fetch` for the provider and FHIR unit tests.
 *
 * The fixtures under `test/fixtures/epic/` are synthetic: invented ids, invented
 * place names, invented token values. Nothing here came from a real chart, and
 * nothing here may.
 *
 * They are read from disk rather than imported as JSON modules on purpose: a
 * JSON import is typed as its literal shape, which will not satisfy
 * `fhir4.Bundle` (`resourceType: string` is not `"Bundle"`), so the tests would
 * end up asserting against a structurally different type than the code sees.
 */

import { readFileSync } from "node:fs";

/** A made-up host. Never a real organisation's FHIR base. */
export const TEST_FHIR_BASE = "https://fhir.example-health.test/api/FHIR/R4";

/** The public Epic sandbox base, which is safe to name. */
export const EPIC_SANDBOX_BASE = "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4";

/** Read one fixture and assert its type. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the type parameter is the point of this helper: it is how a test says "this file is a Bundle" once, instead of casting at every use.
export function loadFixture<T>(name: string): T {
  const path = new URL(`../../fixtures/epic/${name}`, import.meta.url);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the name is a literal written in a test file, never input.
  const text = readFileSync(path, "utf8");
  return JSON.parse(text) as T;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface FetchStub {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
}

/** JSON response with a FHIR content type, plus any extra headers a test needs. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has("content-type")) headers.set("content-type", "application/fhir+json");
  return Response.json(body, { ...init, headers });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** A `fetch` that records every call and answers from the given handler. */
export function stubFetch(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): FetchStub {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    const call: RecordedCall = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

/** Retry options that make `retriedFetch` deterministic and instant. */
export const FAST_RETRY = {
  sleep: (): Promise<void> => Promise.resolve(),
  random: (): number => 0.5,
};

/** Decode an `Authorization: Basic ...` header back to `id:secret`. */
export function decodeBasic(header: string): string {
  return Buffer.from(header.replace(/^Basic /u, ""), "base64").toString("utf8");
}
