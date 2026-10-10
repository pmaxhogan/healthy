// Prints the derived Epic client secret for one organisation, or mints the key
// those secrets are derived from.
//
//   npm run epic-org-secret -- --org <id>                  # production secret
//   npm run epic-org-secret -- --org <id> --env nonprod    # non-production secret
//   npm run epic-org-secret -- --gen-key                   # print a new key
//   npm run epic-org-secret -- --gen-key --put             # ...and upload it as EPIC_ORG_SECRET_KEY
//
// Why this exists: Epic wants a different client secret per organisation and per
// environment, pasted into its developer portal when the app is enabled there.
// Rather than store one per organisation, the Worker derives it (see
// `worker/db/org-secret.ts`); this prints the same value so it can be registered.
// `<id>` is the organisation's id in the developer portal, and is what goes in a
// health system's "Epic organisation id" field afterwards.
//
// The secret is the only thing written to stdout, so it can be piped straight to
// a clipboard tool. `EPIC_ORG_SECRET_KEY` comes from the environment or from a
// gitignored `.dev.vars`, and is never printed except by `--gen-key`.
//
// WARNING: the key is permanent. Epic keeps a hash of every secret derived from
// it, so replacing it disables the app at every organisation until each one is
// re-registered. `--put` refuses to overwrite an existing key for that reason.
// A Worker secret cannot be read back -- keep a copy somewhere safe.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { deriveOrgClientSecret } from "../worker/db/org-secret.ts";

import { parseDotEnv } from "./set-health-system-secret.ts";

import type { HealthSystemEnvironment } from "../worker/db/rows.ts";

const SECRET_NAME = "EPIC_ORG_SECRET_KEY";
const KEY_BYTES = 32;

type CliArgs =
  | { mode: "derive"; orgId: string; environment: HealthSystemEnvironment }
  | { mode: "gen-key"; put: boolean };

function printUsage(): void {
  console.error(
    [
      "Usage: npm run epic-org-secret -- --org <id> [--env prod|nonprod]",
      "       npm run epic-org-secret -- --gen-key [--put]",
      "",
      "Options:",
      "  --org <id>   The organisation's id in Epic's developer portal. Required to derive.",
      "  --env <env>  prod (the default) or nonprod.",
      "  --gen-key    Print a new derivation key instead of deriving a secret.",
      `  --put        With --gen-key: upload it as ${SECRET_NAME}, unless one already exists.`,
      "",
      `${SECRET_NAME} is read from the environment or from .dev.vars.`,
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

/** `--env`'s two spellings, as the environment the Worker stores. */
function toEnvironment(value: string): HealthSystemEnvironment {
  if (value === "prod") return "prod";
  if (value === "nonprod") return "sandbox";
  throw new Error(`--env must be prod or nonprod, got "${value}"`);
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let orgId: string | null = null;
  let environment: HealthSystemEnvironment | null = null;
  let genKey = false;
  let put = false;

  const remaining = [...argv];
  for (let flag = remaining.shift(); flag !== undefined; flag = remaining.shift()) {
    switch (flag) {
      case "--org": {
        orgId = takeValue(remaining, flag);
        continue;
      }
      case "--env": {
        environment = toEnvironment(takeValue(remaining, flag));
        continue;
      }
      case "--gen-key": {
        genKey = true;
        continue;
      }
      case "--put": {
        put = true;
        continue;
      }
      default: {
        throw new Error(`unrecognized argument: ${flag}`);
      }
    }
  }

  if (genKey) {
    if (orgId !== null || environment !== null) {
      throw new Error("--gen-key cannot be combined with --org or --env");
    }
    return { mode: "gen-key", put };
  }
  if (put) throw new Error("--put only applies to --gen-key");
  if (orgId === null || orgId === "") throw new Error("--org is required");
  return { mode: "derive", orgId, environment: environment ?? "prod" };
}

/** The derivation key: the environment first, then a gitignored `.dev.vars`. */
function resolveKey(): string {
  const fromEnv = process.env[SECRET_NAME];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  const fromDevVars = parseDotEnv(".dev.vars").get(SECRET_NAME);
  if (fromDevVars !== undefined && fromDevVars !== "") return fromDevVars;

  throw new Error(`${SECRET_NAME} was not found in the environment or in .dev.vars`);
}

/**
 * Runs wrangler through the shell, which Windows needs: wrangler is a .cmd shim
 * that Node refuses to spawn directly. Safe here because every argument is a
 * single fixed token.
 */
function wrangler(args: readonly string[], input?: string): string {
  const result = spawnSync("npx", ["wrangler", ...args], {
    ...(input !== undefined && { input }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    shell: true,
  });
  if (result.error) {
    throw new Error(`failed to run wrangler: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} exited with ${String(result.status)}`);
  }
  return result.stdout;
}

/** True when the deployed Worker already has the key. Throws rather than guess. */
function keyAlreadyDeployed(): boolean {
  const parsed: unknown = JSON.parse(wrangler(["secret", "list", "--format", "json"]));
  if (!Array.isArray(parsed)) {
    throw new TypeError("wrangler secret list did not return a list");
  }
  return parsed.some(
    (entry: unknown) =>
      typeof entry === "object" && entry !== null && "name" in entry && entry.name === SECRET_NAME,
  );
}

function generateKey(put: boolean): void {
  if (put && keyAlreadyDeployed()) {
    throw new Error(
      `${SECRET_NAME} is already set on the deployed Worker; replacing it would invalidate every registered secret`,
    );
  }

  const key = randomBytes(KEY_BYTES).toString("base64");
  console.log(key);
  console.error(`\nKeep a copy: add ${SECRET_NAME}=<key> to .dev.vars. It cannot be read back.`);

  if (!put) {
    console.error(`Not uploaded. Re-run with --put, or:  wrangler secret put ${SECRET_NAME}`);
    return;
  }
  wrangler(["secret", "put", SECRET_NAME], key);
  console.error(`${SECRET_NAME} uploaded.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  const args = parseArgs(argv);
  if (args.mode === "gen-key") {
    generateKey(args.put);
    return;
  }
  console.log(await deriveOrgClientSecret(resolveKey(), args.environment, args.orgId));
}

// Only run when executed directly, not when the unit tests import `parseArgs`.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      `epic-org-secret failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    printUsage();
    process.exit(1);
  }
}
