// The Worker's whole external surface: what it is bound to, and what it is
// told. Written by hand rather than derived from the generated
// worker-configuration.d.ts, because the secrets half of this interface has no
// representation in wrangler.jsonc -- by design, since that file is committed.
//
// Everything personal or credential-shaped is a secret or a `settings` row.
// Nothing here has a default baked into source.

// Type-only, so this stays a declaration file in effect: the class is needed to
// type the Durable Object stub's RPC methods, not at runtime.
import type { FullRefreshRunner } from "./sync/runner.ts";

export interface Env {
  // --- Bindings (see wrangler.jsonc) ---------------------------------------
  /** Primary datastore: providers, connections, FHIR cache, audit, run log. */
  DB: D1Database;
  /**
   * Token and grant storage for @cloudflare/workers-oauth-provider. The
   * binding name is fixed by that library and cannot be changed.
   */
  OAUTH_KV: KVNamespace;
  /** The built Vue SPA, served only to requests that clear both auth gates. */
  ASSETS: Fetcher;
  /** SQLite-backed Durable Object hosting the MCP session. */
  HEALTHY_MCP: DurableObjectNamespace;
  /**
   * One object per provider, driving a manual full refresh across as many alarm
   * invocations as it takes. See `worker/sync/runner.ts` for why a request's
   * `waitUntil` cannot do this job.
   */
  FULL_REFRESH: DurableObjectNamespace<FullRefreshRunner>;

  // --- Var (wrangler.jsonc) ------------------------------------------------
  /**
   * "true" only under `wrangler dev` and in the integration tests, where there
   * is no Cloudflare Access in front of the Worker. It relaxes the Access JWT
   * check -- and nothing else -- so the password gate still applies.
   */
  DEV_MODE: string;

  // --- Secrets (`wrangler secret put`, or .dev.vars locally) ---------------
  /** Cloudflare Access team domain, e.g. "<team>.cloudflareaccess.com". */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Access application AUD tag; the `aud` claim the Access JWT must carry. */
  CF_ACCESS_AUD?: string;
  /** The single identity the Access JWT's email claim must equal. */
  CF_ACCESS_ALLOWED_EMAIL?: string;
  /** Admin password, as `pbkdf2$sha256$<iterations>$<saltB64url>$<hashB64url>`. */
  PASSWORD_HASH?: string;
  /** HMAC key for the session cookie. */
  SESSION_SECRET?: string;
  /** base64 of 32 random bytes: the AES-GCM-256 key for seal()/open(). */
  DATA_KEY?: string;
  /** Google OAuth client for Calendar access. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Epic app client ids, one per Epic environment. */
  EPIC_CLIENT_ID_PROD?: string;
  EPIC_CLIENT_ID_NONPROD?: string;
  /** Trello REST credentials and the two list ids used for re-auth cards. */
  TRELLO_KEY?: string;
  TRELLO_TOKEN?: string;
  TRELLO_MUST_LIST_ID?: string;
  TRELLO_DONE_LIST_ID?: string;
}

// TODO(wave1): config helpers land here alongside their first caller --
// isDevMode(env), requireSecret(env, name) that throws rather than silently
// degrading, and the settings-table accessors. They are omitted for now so the
// module stays free of code nothing calls.
