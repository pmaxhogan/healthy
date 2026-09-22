// Writes a provider's patient-portal username and password straight into D1,
// sealed exactly the way the Worker seals them, without going through the admin
// UI or a browser.
//
//   PORTAL_USERNAME=<user> npm run set-portal-credentials -- --provider <id> --remote
//   npm run set-portal-credentials -- --provider <id> --local     # both from stdin
//
// `--mfa-contact` additionally sets the address (from PORTAL_MFA_CONTACT) the
// portal should email a verification code to, for the rare deployment whose
// login response does not say. Optional, and left alone unless the flag is
// given -- most accounts never need it.
//
// Why this exists: the admin UI's portal card is how this is normally set, but
// that path needs a browser session, and a portal password -- which is a login
// to a whole medical record, not an API credential -- should not be typed into
// one more window than necessary. This script is the no-browser equivalent, and
// it is the same shape as `scripts/set-provider-secret.ts`: it shells out to
// `wrangler d1 execute` the way `npm run migrate:remote` does.
//
// Neither value is ever a command-line argument, so neither lands in shell
// history or in `ps`. The username comes from `PORTAL_USERNAME` or the first
// line of stdin; the password from `PORTAL_PASSWORD` or the rest of stdin.
// `DATA_KEY` -- needed to seal the values the same way `worker/db/crypto.ts`
// does -- comes from the environment or from a gitignored `.dev.vars`. Only the
// row id and "updated" are ever printed.
//
// `--local` writes to the database `wrangler dev` uses, so `npm run
// migrate:local` has to have been run at least once first or there is no
// `portal_accounts` table to write to.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { aadFor, seal } from "../worker/db/crypto.ts";
import { isRecord } from "../worker/fhir/bundle.ts";
import { ID_PATTERN } from "../worker/lib/ids.ts";
import { nowSeconds } from "../worker/lib/time.ts";

import { parseDotEnv } from "./set-provider-secret.ts";

// Matches wrangler.jsonc's `d1_databases[0].database_name`.
const DB_NAME = "healthy";

// Defence in depth: `seal()` always returns this shape, but both values are
// about to be interpolated into a SQL string (there are no bind parameters in
// `wrangler d1 execute --command`), so the shape is re-checked right before that
// happens rather than trusted.
const SEALED_ENVELOPE_PATTERN = /^v1:[A-Za-z0-9_-]+$/u;

type Target = "--remote" | "--local";

interface CliArgs {
  providerId: string;
  target: Target;
  /** Also write `mfa_contact_enc` from `PORTAL_MFA_CONTACT`. */
  mfaContact: boolean;
}

function printUsage(): void {
  console.error(
    [
      "Usage: npm run set-portal-credentials -- --provider <id> (--remote|--local)",
      "",
      "Options:",
      "  --provider <id>   Provider row id (a 26-character ULID). Required.",
      "  --remote          Write to the deployed (production) D1 database.",
      "  --local           Write to the local D1 database used by `wrangler dev`.",
      "                    Run `npm run migrate:local` first, or the table will",
      "                    not exist. Exactly one of --remote / --local is required.",
      "  --mfa-contact     Also set the address (from PORTAL_MFA_CONTACT) the portal",
      "                    should email a verification code to. Optional; omit to",
      "                    leave whatever is already stored unchanged.",
      "",
      "The username is read from PORTAL_USERNAME, or the first line of stdin.",
      "The password is read from PORTAL_PASSWORD, or the remaining lines of stdin.",
      "Neither is ever a command-line argument. Same for --mfa-contact's address,",
      "which comes only from PORTAL_MFA_CONTACT.",
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
  let mfaContact = false;

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
      case "--mfa-contact": {
        mfaContact = true;
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
  return { providerId, target: remote ? "--remote" : "--local", mfaContact };
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
 * Split piped input into a username line and a password.
 *
 * Exactly two lines, in that order: `printf '%s\n%s\n' "$user" "$pass" | npm run
 * ...`. The password keeps whatever internal whitespace it has -- only the one
 * trailing newline a shell adds is stripped, because silently trimming a
 * password would mask a copy/paste mistake and produce a login failure the owner
 * could not explain.
 */
export function splitStdin(raw: string): { username: string; password: string } {
  const newline = raw.indexOf("\n");
  if (newline === -1) {
    throw new Error("stdin must contain a username line and then the password");
  }
  return {
    username: raw.slice(0, newline).replace(/\r$/u, "").trim(),
    password: raw.slice(newline + 1).replace(/\r?\n$/u, ""),
  };
}

/** The two values, from the environment where it is set and stdin otherwise. */
async function readCredentials(): Promise<{ username: string; password: string }> {
  const fromEnv = {
    username: process.env.PORTAL_USERNAME ?? "",
    password: process.env.PORTAL_PASSWORD ?? "",
  };
  if (fromEnv.username !== "" && fromEnv.password !== "") return fromEnv;

  console.error(
    "PORTAL_USERNAME / PORTAL_PASSWORD are not both set; reading from stdin (username line, then password)...",
  );
  const piped = splitStdin(await readStdin());
  return {
    username: fromEnv.username === "" ? piped.username : fromEnv.username,
    password: fromEnv.password === "" ? piped.password : fromEnv.password,
  };
}

/** `DATA_KEY`: the environment first, then a gitignored `.dev.vars`. */
function resolveDataKey(): string {
  const fromEnv = process.env.DATA_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fromDevVars = parseDotEnv(".dev.vars").get("DATA_KEY");
  if (fromDevVars !== undefined && fromDevVars !== "") return fromDevVars;

  throw new Error("DATA_KEY was not found in the environment or in .dev.vars");
}

/**
 * Wrangler's own CLI entry point, resolved from this repo's `node_modules`.
 *
 * Invoked through Node directly rather than `npx ... { shell: true }`: the
 * `--command` argument is a whole SQL string with spaces and quotes in it, and
 * on Windows a shell re-splits it into several arguments. See the same comment
 * in `set-provider-secret.ts`.
 */
const WRANGLER_BIN = path.join(
  path.dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

function runWrangler(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    encoding: "utf8",
    // stderr is inherited so wrangler's own auth prompts are visible; stdout is
    // captured because that is where --json puts the result set.
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

/** The first result set's rows out of `wrangler d1 execute --json` output. */
function rowsFromD1Json(stdout: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `could not parse wrangler's --json output: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const first = Array.isArray(parsed) ? (parsed[0] as unknown) : undefined;
  if (!isRecord(first) || !Array.isArray(first.results)) {
    throw new Error("wrangler's --json output did not have the expected shape");
  }
  return first.results;
}

/** True if a provider with this id exists. `id` must already be ULID-validated. */
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
 * The AADs the three columns are sealed under.
 *
 * These must equal `aad(...)` in `worker/db/repos/portal-accounts.ts` byte for
 * byte, or a value this script writes is illegible to the Worker. See
 * `test/unit/set-portal-credentials.test.ts` for the round trip that catches a
 * future divergence.
 */
export function portalUsernameAad(providerId: string): string {
  return aadFor("portal_accounts", "username_enc", providerId);
}

export function portalPasswordAad(providerId: string): string {
  return aadFor("portal_accounts", "password_enc", providerId);
}

export function portalMfaContactAad(providerId: string): string {
  return aadFor("portal_accounts", "mfa_contact_enc", providerId);
}

function checkEnvelope(sealed: string): string {
  if (!SEALED_ENVELOPE_PATTERN.test(sealed)) {
    // Unreachable in practice, but this value is about to be interpolated into
    // SQL text, so it is re-checked here rather than trusted from a caller away.
    throw new Error("seal() produced an unexpected envelope shape");
  }
  return sealed;
}

/** Seals both values exactly the way `portalAccounts.setCredentials` does. */
export async function sealPortalCredentials(
  dataKey: string,
  providerId: string,
  credentials: { username: string; password: string },
): Promise<{ username: string; password: string }> {
  return {
    username: checkEnvelope(
      await seal(dataKey, credentials.username, portalUsernameAad(providerId)),
    ),
    password: checkEnvelope(
      await seal(dataKey, credentials.password, portalPasswordAad(providerId)),
    ),
  };
}

/**
 * Upsert the row, then read it back.
 *
 * An upsert rather than an update: a provider that has never had a portal
 * account has no `portal_accounts` row at all, and the repo's `ensure()` is not
 * reachable from a script. Storing credentials resets the session the same way
 * the repo does -- a new password invalidates whatever cookie jar was there.
 *
 * Success is confirmed with a SELECT rather than by trusting `meta.changes`: a
 * local D1 only ever reports `meta.duration` for a write, so checking that field
 * would make this refuse every local write it just made.
 *
 * `mfaContactEnc` is omitted from the statement entirely when null -- not set to
 * SQL `NULL` -- so a run without `--mfa-contact` leaves an already-stored value
 * alone instead of wiping it on every credential rotation.
 */
function writeCredentials(
  id: string,
  sealed: { username: string; password: string },
  mfaContactEnc: string | null,
  updatedAt: number,
  target: Target,
): void {
  const mfaColumn = mfaContactEnc === null ? "" : ", mfa_contact_enc";
  const mfaValue = mfaContactEnc === null ? "" : `, '${mfaContactEnc}'`;
  const mfaSet = mfaContactEnc === null ? "" : ", mfa_contact_enc = excluded.mfa_contact_enc";

  runWrangler([
    "d1",
    "execute",
    DB_NAME,
    target,
    "--json",
    "--command",
    `INSERT INTO portal_accounts
       (provider_id, username_enc, password_enc, session_state, updated_at${mfaColumn})
     VALUES ('${id}', '${sealed.username}', '${sealed.password}', 'none', ${String(updatedAt)}${mfaValue})
     ON CONFLICT (provider_id) DO UPDATE SET
       username_enc = excluded.username_enc,
       password_enc = excluded.password_enc,
       cookie_jar_enc = NULL,
       session_state = 'none',
       last_error_code = NULL,
       needs_reauth_since = NULL,
       updated_at = excluded.updated_at${mfaSet}`,
  ]);

  const stdout = runWrangler([
    "d1",
    "execute",
    DB_NAME,
    target,
    "--json",
    "--command",
    `SELECT username_enc, password_enc, mfa_contact_enc, updated_at FROM portal_accounts WHERE provider_id = '${id}'`,
  ]);
  const row = rowsFromD1Json(stdout)[0];
  const wroteExpectedValue =
    isRecord(row) &&
    row.username_enc === sealed.username &&
    row.password_enc === sealed.password &&
    row.updated_at === updatedAt &&
    (mfaContactEnc === null || row.mfa_contact_enc === mfaContactEnc);
  if (!wroteExpectedValue) {
    throw new Error("write did not take effect: the row does not read back what was written");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!ID_PATTERN.test(args.providerId)) {
    throw new Error(`--provider must be a 26-character ULID, got "${args.providerId}"`);
  }

  const credentials = await readCredentials();
  if (credentials.username === "") throw new Error("the portal username was empty");
  if (credentials.password === "") throw new Error("the portal password was empty");

  const dataKey = resolveDataKey();
  const sealed = await sealPortalCredentials(dataKey, args.providerId, credentials);

  let sealedMfaContact: string | null = null;
  if (args.mfaContact) {
    const contact = process.env.PORTAL_MFA_CONTACT ?? "";
    if (contact === "") throw new Error("--mfa-contact requires PORTAL_MFA_CONTACT to be set");
    sealedMfaContact = checkEnvelope(
      await seal(dataKey, contact, portalMfaContactAad(args.providerId)),
    );
  }

  const targetLabel = args.target === "--remote" ? "remote" : "local";
  if (!providerExists(args.providerId, args.target)) {
    throw new Error(`no provider with id ${args.providerId} in the ${targetLabel} database`);
  }

  writeCredentials(args.providerId, sealed, sealedMfaContact, nowSeconds(), args.target);

  console.log(`${args.providerId} updated`);
}

// Only run when this file is executed directly, not when the unit tests import
// it for its pure helpers -- the same guard the other scripts use.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `set-portal-credentials failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    process.exit(1);
  }
}
