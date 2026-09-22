// Shared scaffolding for the db integration tests.
//
// These run in real workerd against the real D1 schema (test/integration/setup.ts
// applies migrations/ before the first test), so what they exercise is the SQL,
// the constraints and WebCrypto -- not a mock of any of them.

import { env } from "cloudflare:test";

import { makeCtx } from "../../../worker/db/client.ts";
import { makeRepos } from "../../../worker/db/index.ts";

import type { Ctx } from "../../../worker/db/client.ts";
import type { Repos } from "../../../worker/db/index.ts";
import type { Env } from "../../../worker/env.ts";
import type { Logger } from "../../../worker/lib/log.ts";

function randomDataKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes));
}

/**
 * A DATA_KEY for this test isolate.
 *
 * Generated rather than fixed: nothing may commit a key, not even a throwaway
 * one, because a committed AES key is indistinguishable from a leaked one to
 * every scanner that will look at this repository.
 */
const TEST_DATA_KEY = randomDataKey();

/** A second, unrelated key, for proving that the wrong key cannot open a column. */
export const OTHER_DATA_KEY = randomDataKey();

/** An arbitrary fixed instant: 2026-01-01T00:00:00Z, in unix seconds. */
export const T0 = 1_767_225_600;

function testEnv(dataKey = TEST_DATA_KEY): Env {
  // `Cloudflare.Env` types HEALTHY_MCP as DurableObjectNamespace<HealthyMcp>,
  // which is narrower than the hand-written Env's plain DurableObjectNamespace.
  // That one difference is all the cast covers.
  return { ...env, DATA_KEY: dataKey } as unknown as Env;
}

/** A clock the test moves by hand, so TTLs and windows need no real waiting. */
export function clock(start = T0): { now: () => number; advance: (seconds: number) => void } {
  const state = { at: start };
  return {
    now: () => state.at,
    advance: (seconds) => {
      state.at += seconds;
    },
  };
}

export interface TestOptions {
  now?: () => number;
  log?: Logger;
  dataKey?: string;
}

export function testCtx(options: TestOptions = {}): Ctx {
  const base = { now: options.now ?? ((): number => T0) };
  return makeCtx(
    env.DB,
    testEnv(options.dataKey),
    options.log ? { ...base, log: options.log } : base,
  );
}

export function testRepos(options: TestOptions = {}): Repos {
  return makeRepos(testCtx(options));
}

/** A logger that records its lines, for asserting on warnings. */
export function recordingLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  // Imported lazily through makeLogger's options rather than the module default,
  // so nothing in the db layer has to know it is under test.
  const sink = (_level: string, line: string): void => {
    lines.push(line);
  };
  return { log: buildLogger(sink), lines };
}

function buildLogger(sink: (level: string, line: string) => void): Logger {
  // A tiny hand-rolled Logger: the real makeLogger is unit-tested already, and
  // this keeps the integration tests from depending on its redaction behaviour.
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void => {
    sink(level, JSON.stringify({ level, event, ...fields }));
  };
  const logger: Logger = {
    debug: (event, fields) => {
      emit("debug", event, fields);
    },
    info: (event, fields) => {
      emit("info", event, fields);
    },
    warn: (event, fields) => {
      emit("warn", event, fields);
    },
    error: (event, fields) => {
      emit("error", event, fields);
    },
    time: async (_event, fn) => fn(),
    child: () => logger,
  };
  return logger;
}

/** Create a provider row and return its id. Nothing here names a real org. */
export async function seedProvider(
  repos: Repos,
  overrides: { displayName?: string; clientSecret?: string } = {},
): Promise<string> {
  const provider = await repos.providers.create({
    vendor: "epic",
    displayName: overrides.displayName ?? "Example Health",
    fhirBaseUrl: "https://fhir.example.test/R4",
    portalUrl: "https://portal.example.test",
    environment: "sandbox",
    ...(overrides.clientSecret !== undefined && { clientSecret: overrides.clientSecret }),
  });
  return provider.id;
}

// Every table, child before parent so the deletes never trip a foreign key.
const TABLES = [
  "login_attempts",
  "portal_accounts",
  "mcp_policy",
  "mcp_audit",
  "run_log",
  "alerts",
  "calendar_events",
  "fhir_sync_state",
  "fhir_cache",
  "oauth_states",
  "connections",
  "providers",
  "settings",
];

/**
 * Empty every table and put `google_account` back to its seeded state.
 *
 * The test pool shares one D1 instance across the tests in a file, so each test
 * starts from a clean database only if it says so. Call this from `beforeEach`.
 */
export async function resetDb(): Promise<void> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare(
    `UPDATE google_account
        SET email_enc = NULL, access_token_enc = NULL, access_expires_at = NULL,
            refresh_token_enc = NULL, scope = NULL, status = 'disconnected',
            last_refresh_at = NULL, needs_reauth_since = NULL, lease_owner = NULL,
            lease_expires_at = NULL, connected_at = NULL, updated_at = 0
      WHERE id = 1`,
  ).run();
}

/**
 * Await a list of rows and project one column, in order.
 *
 * Almost every list assertion here wants "which rows, in what order", and this
 * says that in one expression -- while keeping the member access off the await,
 * which `unicorn/no-await-expression-member` rightly objects to.
 */
export async function column<T, K extends keyof T>(promise: Promise<T[]>, key: K): Promise<T[K][]> {
  const rows = await promise;
  // `row[key]`: `K extends keyof T`, so the compiler has already proved the index.
  return rows.map((row) => row[key]);
}

/** Read one column straight out of D1, bypassing the repos. */
export async function rawColumn(
  table: string,
  column: string,
  where: string,
  ...values: unknown[]
): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}`)
    .bind(...values)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}
