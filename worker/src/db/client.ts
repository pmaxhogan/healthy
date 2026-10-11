/**
 * Thin helpers over D1, and the context every repo takes.
 *
 * Thin on purpose: D1's own prepare/bind API is good, and hiding it behind a
 * query builder would cost more than it saves for a schema this size. What the
 * helpers add is the three things every call site otherwise repeats -- a typed
 * single row, a typed list, and a `changes` count -- plus an injected clock,
 * which is what makes leases, TTLs and retention windows testable without
 * sleeping.
 *
 * Time convention, matching the migration: every timestamp column is an INTEGER
 * unix second, and `Ctx.now()` returns exactly that. Milliseconds only ever
 * appear in a `ttlMs` argument.
 */

import { noopLogger } from "../lib/log.ts";
import { nowSeconds, toIso } from "../lib/time.ts";

import type { Env } from "../env.ts";
import type { Logger } from "../lib/log.ts";

/**
 * Everything a repo needs. One object rather than `(db, env)` pairs so a repo can
 * log and read the clock without growing a fourth parameter later.
 */
export interface Ctx {
  db: D1Database;
  env: Env;
  log: Logger;
  /** Current time as an integer unix second. Injected so tests can move it. */
  now: () => number;
}

export interface CtxOptions {
  log?: Logger;
  /** Overrides the clock. Takes unix seconds, not milliseconds. */
  now?: () => number;
}

export function makeCtx(db: D1Database, env: Env, options: CtxOptions = {}): Ctx {
  return {
    db,
    env,
    log: options.log ?? noopLogger,
    now: options.now ?? ((): number => nowSeconds()),
  };
}

/** The first row, or null. */
export async function one<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return stmt.first<T>();
}

/** Every row. */
export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const { results } = await stmt.all<T>();
  return results;
}

export interface RunResult {
  /** Rows the statement actually changed. The lease CAS turns on this being exact. */
  changes: number;
  lastRowId: number | null;
}

/** Execute a write and report how many rows it touched. */
export async function run(stmt: D1PreparedStatement): Promise<RunResult> {
  const { meta } = await stmt.run();
  return { changes: meta.changes, lastRowId: meta.last_row_id };
}

/**
 * Run several statements as one D1 batch (which is a transaction).
 *
 * D1 caps how many statements one batch may carry, so callers that build a batch
 * from an unbounded list must chunk it; `BATCH_CHUNK` is the size the FHIR cache
 * uses and is a safe default for anything else.
 */
export async function batch<T>(db: D1Database, stmts: D1PreparedStatement[]): Promise<T[][]> {
  if (stmts.length === 0) return [];
  const results = await db.batch<T>(stmts);
  return results.map((result) => result.results);
}

/** Statements per `batch` call. Conservative; D1's own limit is higher. */
export const BATCH_CHUNK = 50;

/** Split a list into `size`-sized chunks, for batching. */
export function chunk<T>(items: readonly T[], size = BATCH_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Now as an ISO-8601 instant.
 *
 * For log lines, API bodies and calendar descriptions -- never for a column,
 * which takes `ctx.now()` instead.
 */
export function nowIso(now: () => number = nowSeconds): string {
  return toIso(now());
}

/** sha256 of a string, lower-case hex. The FHIR cache's change detector. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Convert a caller's millisecond TTL into the whole seconds a column holds. */
export function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}
