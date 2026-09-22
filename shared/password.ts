// Cost and format of the admin password hash.
//
// This lives in shared/ because three places must agree on it and none of them
// can import the others: the Node script that mints the hash
// (scripts/hash-password.ts), the Worker that verifies it (wave 1,
// worker/auth/password.ts), and the integration test that checks the Workers
// runtime can actually derive at this cost.

/**
 * PBKDF2-SHA256 iterations. Deliberately high: the Worker only runs this on a
 * login attempt, which is rate-limited, so an attacker pays the cost far more
 * often than the owner does.
 *
 * WebCrypto in workerd caps PBKDF2 iterations, and the cap has moved between
 * runtime releases. A hash minted above the cap cannot be verified, which locks
 * the owner out of the admin UI -- so this value is asserted in
 * test/integration/worker.test.ts. That test runs against the *local* workerd
 * that the test pool bundles, which is strong evidence but not proof about
 * deployed Workers: confirm a login works on the first real deploy before
 * relying on it. If production rejects this cost, `hashPassword(pw, 100_000)`
 * re-mints at the older known-safe count. Do not raise it without the test
 * going green.
 */
export const PBKDF2_ITERATIONS = 600_000;

/** Derived key length, in bytes. */
export const PBKDF2_KEY_BYTES = 32;

/** Salt length, in bytes. */
export const PBKDF2_SALT_BYTES = 16;

/**
 * Storage format of the PASSWORD_HASH secret:
 *   pbkdf2$sha256$<iterations>$<saltBase64Url>$<hashBase64Url>
 *
 * The cost parameters travel with the hash, so PBKDF2_ITERATIONS can be raised
 * later without invalidating the secret already deployed.
 */
export const PASSWORD_HASH_PATTERN = /^pbkdf2\$sha256\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u;
