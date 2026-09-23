// Writes a per-organisation FHIR confidential-client secret straight into D1,
// sealed exactly the way the Worker seals it, without going through the admin
// UI or a browser.
//
//   PROVIDER_CLIENT_SECRET=<secret> npm run set-provider-secret -- --provider <id> --remote
//   npm run set-provider-secret -- --provider <id> --local          # reads the secret from stdin
//
// Why this exists: `POST /api/providers/:id/secret` is how the admin UI sets
// this column, but that path requires a browser session, and a production
// client secret should never be typed into one. This script is the
// no-browser equivalent -- it shells out to `wrangler d1 execute` the same
// way `npm run migrate:remote` does.
//
// The secret is never a command-line argument and never on the command line
// / in shell history: it comes from the `PROVIDER_CLIENT_SECRET` environment
// variable or, failing that, from stdin. `DATA_KEY` -- needed to seal the
// value the same way `worker/db/crypto.ts` does -- comes from the
// environment or from a gitignored `.dev.vars`, the same two places every
// other Worker secret in this repo lives locally. Only the row id and
// "updated" are ever printed; the secret and the key never are.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { aadFor, sealShort } from "../worker/db/crypto.ts";
import { isRecord } from "../worker/fhir/bundle.ts";
import { ID_PATTERN } from "../worker/lib/ids.ts";
import { nowSeconds } from "../worker/lib/time.ts";

// Matches wrangler.jsonc's `d1_databases[0].database_name`, the same name
// `migrate:local` / `migrate:remote` pass to `wrangler d1 migrations apply`.
const DB_NAME = "healthy";

// Defence in depth: `sealShort()` always returns this shape, but the value is
// about to be interpolated into a SQL string (see `updateProvider` below),
// so it is checked again right before that happens rather than trusted.
const SEALED_ENVELOPE_PATTERN = /^v2:[A-Za-z0-9_-]+$/u;

type Target = "--remote" | "--local";

interface CliArgs {
  providerId: string;
  target: Target;
}

function printUsage(): void {
  console.error(
    [
      "Usage: npm run set-provider-secret -- --provider <id> (--remote|--local)",
      "",
      "Options:",
      "  --provider <id>   Provider row id (a 26-character ULID). Required.",
      "  --remote          Write to the deployed (production) D1 database.",
      "  --local           Write to the local D1 database used by `wrangler dev`.",
      "                    Exactly one of --remote / --local is required.",
      "",
      "The secret is read from the PROVIDER_CLIENT_SECRET environment variable,",
      "or from stdin if that is unset -- never from a command-line argument.",
    ].join("\n"),
  );
}

/** Pops the next token off `remaining`, refusing to consume another flag as a value. */
function takeValue(remaining: string[], flag: string): string {
  const value = remaining.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let providerId: string | null = null;
  let remote = false;
  let local = false;

  const remaining = [...argv];
  for (let flag = remaining.shift(); flag !== undefined; flag = remaining.shift()) {
    switch (flag) {
      case "--provider": {
        providerId = takeValue(remaining, flag);
        continue;
      }
      case "--remote": {
        remote = true;
        continue;
      }
      case "--local": {
        local = true;
        continue;
      }
      default: {
        throw new Error(`unrecognized argument: ${flag}`);
      }
    }
  }

  if (providerId === null || providerId === "") {
    throw new Error("--provider is required");
  }
  if (remote === local) {
    // Both false (neither given) and both true (given together) are refused:
    // this always writes to a real database, so the target is never inferred.
    throw new Error("exactly one of --remote or --local is required");
  }
  return { providerId, target: remote ? "--remote" : "--local" };
}

/** Drains stdin to EOF and returns it as text, with no encoding surprises. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The client secret: `PROVIDER_CLIENT_SECRET` if set, otherwise stdin.
 *
 * Reading from stdin rather than a prompt (unlike `set-password.ts`) is
 * deliberate -- the caller in practice pipes it in from a gitignored file or a
 * secrets manager, e.g. `PROVIDER_CLIENT_SECRET="$(...)" npm run ...` or
 * `npm run set-provider-secret -- ... < secret.txt`. Either way it is never a
 * process argument, so it never lands in shell history or `ps`.
 */
async function readSecret(): Promise<string> {
  const fromEnv = process.env.PROVIDER_CLIENT_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  console.error("PROVIDER_CLIENT_SECRET is not set; reading the secret from stdin...");
  const raw = await readStdin();
  // Strip exactly the trailing newline a shell heredoc/pipe adds; nothing else
  // -- a real client secret should not contain other leading/trailing
  // whitespace, and silently trimming it would mask a copy/paste mistake.
  return raw.replace(/\r?\n$/u, "");
}

/** Parses a minimal `NAME=value` file, the same shape `.dev.vars` uses. */
export function parseDotEnv(path: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(path)) return values;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

/** `DATA_KEY`: the environment first, then a gitignored `.dev.vars`, matching where every other local secret in this repo lives. */
function resolveDataKey(): string {
  const fromEnv = process.env.DATA_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fromDevVars = parseDotEnv(".dev.vars").get("DATA_KEY");
  if (fromDevVars !== undefined && fromDevVars !== "") return fromDevVars;

  throw new Error("DATA_KEY was not found in the environment or in .dev.vars");
}

/**
 * Wrangler's own CLI entry point, resolved from this repo's `node_modules`
 * rather than run via `npx`/PATH.
 *
 * `set-password.ts` and `gen-data-key.ts` shell out with
 * `spawnSync("npx", ["wrangler", ...], { shell: true })`, which is only safe
 * because every argument they pass is a single token. This script's
 * `--command` argument is a whole SQL string with spaces and quotes in it,
 * and `shell: true` on Windows joins argv with spaces and hands it to
 * `cmd.exe`, which re-splits on those spaces -- so `--command "SELECT ... "`
 * arrives at wrangler as several separate arguments instead of one. Invoking
 * Node directly on wrangler's own entry script sidesteps the shell (and its
 * quoting) entirely: argv reaches wrangler exactly as this process built it.
 */
const WRANGLER_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** Runs wrangler with `args`, returning stdout. See `WRANGLER_BIN` for why this does not shell out. */
function runWrangler(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    // stderr is inherited so wrangler's own progress/auth prompts are visible;
    // stdout is captured because that is where --json puts the result set.
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    throw new Error(`failed to run wrangler: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} exited with ${String(result.status)}`);
  }
  return result.stdout;
}

/** Parses wrangler's `--json` output into the first result set's row, as `unknown`. */
function firstResultOf(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `could not parse wrangler's --json output: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return Array.isArray(parsed) ? (parsed[0] as unknown) : undefined;
}

/** The first result set's rows out of `wrangler d1 execute --json` output. */
function rowsFromD1Json(stdout: string): unknown[] {
  const first = firstResultOf(stdout);
  if (!isRecord(first) || !Array.isArray(first.results)) {
    throw new Error("wrangler's --json output did not have the expected shape");
  }
  return first.results;
}

/** True if a row with this id exists. `id` must already be ULID-validated: it is interpolated into the SQL text (see the module comment on why). */
function providerExists(id: string, target: Target): boolean {
  const stdout = runWrangler([
    "d1",
    "execute",
    DB_NAME,
    target,
    "--json",
    "--command",
    `SELECT id FROM providers WHERE id = '${id}'`,
  ]);
  return rowsFromD1Json(stdout).length > 0;
}

/**
 * `wrangler d1 execute --command` takes a single SQL string with no bind-
 * parameter support, so this builds the statement by hand instead of binding.
 * That is only as safe as its inputs: `id` is ULID-validated (Crockford
 * base32, no punctuation) and `sealed` is checked against
 * `SEALED_ENVELOPE_PATTERN` (base64url plus a literal `v1:`) before either
 * touches this string, so neither can contain a quote to break out of the
 * SQL string literals below.
 *
 * Success is confirmed with a SELECT afterwards rather than by trusting
 * `meta.changes` in the UPDATE's own `--json` output: a local D1 (miniflare)
 * only ever reports `meta.duration` for a write, never `meta.changes`, so
 * checking that field would make this refuse every local write it just made.
 * Reading the row back is the one check that is true regardless of target.
 */
function updateProviderSecret(id: string, sealed: string, updatedAt: number, target: Target): void {
  runWrangler([
    "d1",
    "execute",
    DB_NAME,
    target,
    "--json",
    "--command",
    `UPDATE providers SET client_secret_enc = '${sealed}', updated_at = ${String(updatedAt)} WHERE id = '${id}'`,
  ]);

  const stdout = runWrangler([
    "d1",
    "execute",
    DB_NAME,
    target,
    "--json",
    "--command",
    `SELECT client_secret_enc, updated_at FROM providers WHERE id = '${id}'`,
  ]);
  const row = rowsFromD1Json(stdout)[0];
  const wroteExpectedValue =
    isRecord(row) && row.client_secret_enc === sealed && row.updated_at === updatedAt;
  if (!wroteExpectedValue) {
    throw new Error("update did not take effect: the row does not read back what was written");
  }
}

/**
 * The AAD one provider's `client_secret_enc` cell is sealed under.
 *
 * Must equal `secretAad` in `worker/db/repos/providers.ts` exactly -- that
 * private helper is what `providersRepo.getClientSecret` calls `open()` with,
 * so a value this script writes is only ever legible to the Worker if this
 * matches it byte for byte. See `test/unit/set-provider-secret.test.ts` for
 * the round trip that catches a future divergence.
 */
export function providerSecretAad(providerId: string): string {
  return aadFor("providers", "client_secret_enc", providerId);
}

/** Seals `secret` exactly the way `providersRepo.setClientSecret` does. */
export async function sealProviderSecret(
  dataKey: string,
  providerId: string,
  secret: string,
): Promise<string> {
  const sealed = await sealShort(dataKey, secret, providerSecretAad(providerId));
  if (!SEALED_ENVELOPE_PATTERN.test(sealed)) {
    // Unreachable in practice -- sealShort() always returns this shape -- but this
    // value is about to be interpolated into SQL text (see
    // `updateProviderSecret`), so it is re-checked right here rather than
    // trusted from a caller away.
    throw new Error("sealShort() produced an unexpected envelope shape");
  }
  return sealed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!ID_PATTERN.test(args.providerId)) {
    throw new Error(`--provider must be a 26-character ULID, got "${args.providerId}"`);
  }

  const secret = await readSecret();
  if (secret === "") {
    throw new Error("the client secret was empty");
  }

  const dataKey = resolveDataKey();
  const sealed = await sealProviderSecret(dataKey, args.providerId, secret);

  const targetLabel = args.target === "--remote" ? "remote" : "local";
  if (!providerExists(args.providerId, args.target)) {
    throw new Error(`no provider with id ${args.providerId} in the ${targetLabel} database`);
  }

  updateProviderSecret(args.providerId, sealed, nowSeconds(), args.target);

  console.log(`${args.providerId} updated`);
}

// Only run when this file is executed directly (`tsx scripts/set-provider-secret.ts`
// / `npm run set-provider-secret`), not when the unit tests import it for its
// pure helpers -- the same guard `scripts/hash-password.ts` uses.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `set-provider-secret failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    process.exit(1);
  }
}
