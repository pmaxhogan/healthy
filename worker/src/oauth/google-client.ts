/**
 * Builds the Google OAuth client from the Worker's secrets.
 *
 * Shared by the two Google OAuth routes and by `DELETE /api/google`, which needs
 * it to revoke the grant. It exists as its own module for one reason: the
 * `redirect_uri` must be byte-for-byte identical on the authorize request, the
 * code exchange and the value registered in the Google Cloud console, and three
 * call sites building that string independently is how they drift.
 *
 * The origin comes from the request rather than from configuration, so the same
 * build works on `http://localhost:8787` and on the deployed custom domain -- both
 * of which are registered redirect URIs. It is not a spoofing risk: Google only
 * accepts a `redirect_uri` that is already registered, and a request that reaches
 * this code has already cleared Cloudflare Access and the password gate.
 */

import { createGoogleOAuth } from "../google/oauth.ts";
import { AppError } from "../lib/errors.ts";
import { makeLogger } from "../lib/log.ts";

import type { Env } from "../env.ts";
import type { GoogleOAuth } from "../google/oauth.ts";

/** The locked callback path. Registered with Google; do not change one without the other. */
const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

function googleRedirectUri(requestUrl: string): string {
  return new URL(GOOGLE_CALLBACK_PATH, requestUrl).href;
}

export function googleOAuthFor(
  env: Env,
  requestUrl: string,
  fetchImpl: typeof fetch,
): { client: GoogleOAuth; redirectUri: string } {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (GOOGLE_CLIENT_ID === undefined || GOOGLE_CLIENT_SECRET === undefined) {
    throw new AppError("internal", "the Google OAuth client is not configured");
  }
  const redirectUri = googleRedirectUri(requestUrl);
  return {
    client: createGoogleOAuth({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri,
      fetchImpl,
      logger: makeLogger({ src: "google.oauth" }),
    }),
    redirectUri,
  };
}
