// Shared plumbing for the Google client unit tests.
//
// Both modules take `fetchImpl` precisely so their tests never touch the
// network. `recordingFetch` records what was sent -- URL, method, headers, body
// -- and answers from a per-call responder, which is what lets a test assert on
// query parameters, the Authorization header, and call counts.

import { AppError } from "../../../worker/lib/errors.ts";

export interface RecordedCall {
  url: URL;
  method: string;
  /** Lower-cased header names, as `Headers` normalises them. */
  headers: Record<string, string>;
  body: string | null;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function urlOf(input: FetchInput): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, { status, headers });
}

/**
 * `responder` is called with each request and its zero-based index, so a test
 * can answer differently on the first and second attempt.
 */
export function recordingFetch(responder: (call: RecordedCall, index: number) => Response): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: RecordedCall = {
      url: urlOf(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return Promise.resolve(responder(call, calls.length - 1));
  };
  return { fetchImpl, calls };
}

/**
 * Await a call that must reject with an `AppError`, and hand the error back so
 * the test can assert on `code`, `status` and `retryAfterMs`. Anything else --
 * resolving, or throwing something other than an `AppError` -- fails the test
 * here rather than at a confusing assertion further down.
 */
export async function appErrorFrom(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the call to reject with an AppError, but it resolved");
}
