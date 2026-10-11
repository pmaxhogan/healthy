// Gate 1: Cloudflare Access.
//
// Access terminates Google SSO in front of the Worker and injects a signed JWT.
// Verifying that JWT here -- rather than trusting that the request could only
// have arrived through Access -- is what makes the gate real: the Worker is also
// reachable from inside Cloudflare's network and, during a misconfiguration, by
// anyone who learns the origin hostname.
//
// Two things are checked beyond the signature:
//   * `aud` must be the Access *application* AUD, not merely any app in the
//     team. Without it, every other application in the same Access account
//     would be a valid issuer for this one.
//   * `email` must be the single allowed identity. An Access policy can be
//     widened by accident in the dashboard; this check cannot.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { readCookie } from "./primitives.ts";

/** The slice of Env this module reads. Narrow so it is unit-testable. */
export interface AccessEnv {
  DEV_MODE?: string | undefined;
  CF_ACCESS_TEAM_DOMAIN?: string | undefined;
  CF_ACCESS_AUD?: string | undefined;
  CF_ACCESS_ALLOWED_EMAIL?: string | undefined;
}

/** Access puts the assertion here on every proxied request. */
const ACCESS_HEADER = "cf-access-jwt-assertion";

/** ...and in this cookie, which is what a browser navigation carries. */
const ACCESS_COOKIE = "CF_Authorization";

/**
 * One remote JWKS per team domain, cached for the life of the isolate.
 *
 * `createRemoteJWKSet` does its own caching and cooldown, so re-creating it per
 * request would defeat that and issue a certificate fetch on every hit. Keyed by
 * team domain so a secret rotation that changes the team is picked up without a
 * redeploy.
 */
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function jwksFor(team: string): JWTVerifyGetKey {
  const cached = jwksByTeam.get(team);
  if (cached) return cached;
  const created = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
  jwksByTeam.set(team, created);
  return created;
}

/** Overrides for the tests. Production never passes this. */
export interface VerifyAccessOptions {
  /**
   * Replaces the remote JWKS with a locally supplied key resolver, so the email
   * and audience checks can be tested against a real RS256 signature without
   * reaching the network. `jose`'s `createLocalJWKSet` produces one.
   */
  getKey?: JWTVerifyGetKey;
}

/**
 * True when the request carries a valid Access assertion for the one allowed
 * identity.
 *
 * `DEV_MODE === "true"` short-circuits this gate and *only* this gate: there is
 * no Access in front of `wrangler dev` or the integration tests, but the
 * password gate still applies in both.
 */
export async function verifyAccess(
  request: Request,
  env: AccessEnv,
  options: VerifyAccessOptions = {},
): Promise<boolean> {
  if (env.DEV_MODE === "true") return true;

  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const audience = env.CF_ACCESS_AUD;
  const allowedEmail = env.CF_ACCESS_ALLOWED_EMAIL;
  // Fail closed. An unset secret is a misconfiguration, never a bypass.
  if (!team || !audience || !allowedEmail) return false;

  const token = request.headers.get(ACCESS_HEADER) ?? readCookie(request, ACCESS_COOKIE);
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, options.getKey ?? jwksFor(team), {
      audience,
      issuer: `https://${team}`,
      algorithms: ["RS256"],
      // Access-issued tokens are short-lived; a little tolerance covers clock
      // skew between Cloudflare's signer and the edge running this Worker.
      clockTolerance: 30,
    });
    const email = payload.email;
    return (
      typeof email === "string" && email.trim().toLowerCase() === allowedEmail.trim().toLowerCase()
    );
  } catch {
    // Signature, expiry, audience, issuer and algorithm failures all land here
    // and are all the same answer to the caller: not authenticated.
    return false;
  }
}
