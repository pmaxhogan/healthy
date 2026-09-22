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
 * WebCrypto in deployed workerd caps PBKDF2 at 100,000 iterations: a hash minted
 * above that fails with "iteration counts above 100000 are not supported" and
 * locks the owner out of the admin UI. The local workerd bundled with the test
 * pool accepts more, which is exactly how a 600,000-iteration hash once passed
 * every test and then broke the first production login (2026-09-22). So the
 * cost is pinned to the production cap; do not raise it without proving a real
 * deploy still accepts it. `verifyPassword` refuses anything below
 * MIN_PBKDF2_ITERATIONS, which is this same number, and
 * `MAX_PBKDF2_ITERATIONS` there is the ceiling the login handler checks before it
 * calls WebCrypto, so an over-cap secret reports itself instead of throwing.
 */
export const PBKDF2_ITERATIONS = 100_000;

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
