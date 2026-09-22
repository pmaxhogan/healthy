// Mints the AES-GCM-256 key used by the app-layer seal()/open() helpers.
//
//   npm run gen-data-key            # print a new key
//   npm run gen-data-key -- --put   # print it and upload as the DATA_KEY secret
//
// WARNING: rotating DATA_KEY makes every existing sealed column unreadable.
// There is no key-id in the envelope yet, so a rotation means re-authorising
// every provider and dropping the FHIR cache. Generate this once, at setup.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

const SECRET_NAME = "DATA_KEY";
const KEY_BYTES = 32;

const key = randomBytes(KEY_BYTES).toString("base64");
console.log(key);

if (!process.argv.includes("--put")) {
  console.error(`\nNot uploaded. Re-run with --put, or:  wrangler secret put ${SECRET_NAME}`);
  process.exit(0);
}

// `shell: true` is required on Windows, where wrangler is a .cmd shim that
// Node refuses to spawn directly (EINVAL).
const result = spawnSync("npx", ["wrangler", "secret", "put", SECRET_NAME], {
  input: key,
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});

if (result.error) {
  console.error(`Failed to run wrangler: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`wrangler secret put ${SECRET_NAME} exited with ${String(result.status)}`);
  process.exit(result.status ?? 1);
}

console.error(`${SECRET_NAME} updated.`);
