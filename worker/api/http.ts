/**
 * The plumbing every /api route shares: a request context, body parsing, and the
 * one error handler.
 *
 * ### What the error handler will and will not say
 *
 * `worker/app.ts` answers an `AppError` with its code and nothing else, because
 * an upstream failure's message can quote an upstream response body -- and an
 * upstream response here can carry patient detail. That is the right default for
 * the whole app.
 *
 * The admin API can afford slightly more, and needs it: the caller is the owner,
 * and "bad_request" with no indication of which field is a bad API. So the rule
 * here is drawn by status, not by taste:
 *
 *  - **4xx**: the message and details are the app's own, written in this
 *    repository, describing the request. They are returned.
 *  - **5xx** (`upstream_*`, `internal`, `crypto`): the code only. Those messages
 *    are built from upstream responses.
 *
 * A stack trace is never returned, at any status.
 */

import { z } from "zod";

import { reposFor } from "../db/index.ts";
import { AppError, isAppError } from "../lib/errors.ts";
import { logLine, makeLogger } from "../lib/log.ts";

import { getPorts } from "./ports.ts";

import type { Ports } from "./ports.ts";
import type { AppHonoEnv } from "../auth/gate.ts";
import type { Ctx } from "../db/client.ts";
import type { Repos } from "../db/index.ts";
import type { ApiError } from "@shared/types.ts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Nothing the admin API returns may be cached: all of it is one person's record. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/** Everything a route handler needs, built once per request. */
export interface ApiContext {
  ctx: Ctx;
  repos: Repos;
  ports: Ports;
}

export function apiContext(c: Context<AppHonoEnv>): ApiContext {
  const log = makeLogger({ src: "api" });
  const repos = reposFor(c.env.DB, c.env, { log });
  return { ctx: repos.ctx, repos, ports: getPorts() };
}

/**
 * Let a promise finish after the response has been sent.
 *
 * The `catch` is not optional. An unhandled rejection passed to `waitUntil` fails
 * the whole invocation -- and in the integration tests it fails
 * `waitOnExecutionContext`, turning a background sync error into an unrelated test
 * failure. A background job's errors belong in the run log and the alert, which is
 * the sync engine's job; here they are logged by code and dropped.
 */
export function afterResponse(
  c: Context<AppHonoEnv>,
  event: string,
  start: () => Promise<unknown>,
): void {
  // Wrapped in an async function rather than called directly: a port that has not
  // been wired throws synchronously, and a synchronous throw from `start()` would
  // otherwise escape into the handler and fail a request whose real work had
  // already succeeded.
  const run = async (): Promise<void> => {
    try {
      await start();
    } catch (error) {
      logLine("warn", "api_background_failed", {
        event,
        errorCode: isAppError(error) ? error.code : "unknown",
      });
    }
  };
  c.executionCtx.waitUntil(run());
}

/** zod issues, reduced to paths and codes. The offending value never travels. */
function issuesOf(error: z.ZodError): { issues: string[] } {
  return { issues: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`) };
}

/**
 * Parse and validate a JSON request body.
 *
 * A body that is not JSON at all is a 400 like any other bad request -- Hono's
 * `c.req.json()` throws a `SyntaxError`, which would otherwise surface as a 500.
 */
export async function readJson<T>(c: Context<AppHonoEnv>, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError("bad_request", "the request body is not valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError("bad_request", "the request body is not valid", issuesOf(result.error));
  }
  return result.data;
}

/**
 * Like `readJson`, but an empty body validates as `{}`.
 *
 * For the routes whose body is entirely optional -- "sync everything" is a POST
 * with nothing to say -- where requiring `{}` would be a trap for anyone driving
 * the API with curl.
 */
export async function readOptionalJson<T>(
  c: Context<AppHonoEnv>,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    const empty = schema.safeParse({});
    if (!empty.success) {
      throw new AppError("bad_request", "this request needs a body", issuesOf(empty.error));
    }
    return empty.data;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError("bad_request", "the request body is not valid JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError("bad_request", "the request body is not valid", issuesOf(result.error));
  }
  return result.data;
}

/** Validate a query string against a schema, with the same 400 shape. */
export function readQuery<T>(c: Context<AppHonoEnv>, schema: z.ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) {
    throw new AppError("bad_request", "the query string is not valid", issuesOf(result.error));
  }
  return result.data;
}

/** `?limit=` shared by /api/alerts and /api/mcp/audit. */
export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** `?limit=` plus `?kind=`, for /api/runs. */
export const runQuerySchema = limitQuerySchema.extend({
  kind: z.enum(["calendar", "full", "refresh", "manual"]).optional(),
});

/** The body of the error response for one thrown value. */
function errorBody(error: unknown): { body: ApiError; status: ContentfulStatusCode } {
  if (isAppError(error)) {
    const status = error.status as ContentfulStatusCode;
    if (error.status >= 500) {
      // See the module comment: a 5xx message can quote an upstream body.
      return { body: { error: error.code }, status };
    }
    const body: ApiError = { error: error.code, message: error.message };
    if (error.details !== undefined) body.details = error.details;
    return { body, status };
  }
  return error instanceof z.ZodError
    ? { body: { error: "bad_request", details: issuesOf(error) }, status: 400 }
    : { body: { error: "internal_error" }, status: 500 };
}

/**
 * The /api error handler.
 *
 * Registered on the sub-app so that the richer 4xx body above applies to /api and
 * only to /api; `app.ts`'s handler stays the last resort for everything else.
 */
export function apiErrorHandler(error: Error, c: Context<AppHonoEnv>): Response {
  const { body, status } = errorBody(error);
  // The code, never the message: the message is what may quote an upstream body,
  // and the logger is not a place to find that out.
  // One redacted JSON line, like every other log this Worker writes. The path is
  // safe (ids of our own rows) and the redactor is what keeps it that way.
  //
  // `errorCode`, not `code`: the bare key `code` is redacted wholesale (it names
  // the OAuth authorization code), so every rejection used to be logged as
  // "[redacted]" -- observed live. `errorCode` is the name this project's stable
  // codes travel under everywhere else.
  if (status >= 500) logLine("error", "api_error", { errorCode: body.error, path: c.req.path });
  else logLine("warn", "api_rejected", { errorCode: body.error, path: c.req.path });
  return c.json<ApiError>(body, status, NO_STORE);
}
