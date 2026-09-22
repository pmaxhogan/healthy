// The integration runtime's environment, asserted.
//
// The pool loads `wrangler.jsonc` the way `wrangler dev` does, which includes the
// operator's real `.dev.vars`. Several helpers here spread `...env` to get the real
// D1 and Durable Object bindings, so without the dummy bindings in vitest.config.ts
// those helpers would hand real credentials to test code -- and a test that logged
// one, asserted on one, or posted one to a stubbed upstream would leak it.
//
// This file is the tripwire for that. It asserts the dummies are in force, and it
// asserts the real values are absent by checking the shapes a real credential has
// rather than any real value (which must never appear in this repository).

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** Every secret `worker/env.ts` declares, with the dummy vitest.config.ts binds. */
const EXPECTED: Record<string, string> = {
  DEV_MODE: "false",
  CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.test",
  CF_ACCESS_AUD: "test-access-aud",
  CF_ACCESS_ALLOWED_EMAIL: "owner@example.test",
  PASSWORD_HASH: "test-password-hash",
  SESSION_SECRET: "test-session-secret",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  EPIC_CLIENT_ID_PROD: "test-epic-prod",
  EPIC_CLIENT_ID_NONPROD: "test-epic-nonprod",
  TRELLO_KEY: "test-key",
  TRELLO_TOKEN: "test-token",
  TRELLO_MUST_LIST_ID: "test-must-list",
  TRELLO_DONE_LIST_ID: "test-done-list",
};

const secrets = env as unknown as Record<string, unknown>;

describe("the integration environment", () => {
  it("binds a dummy for every secret, overriding .dev.vars", () => {
    // `secrets[name]`: names come from `Object.entries` of a const in this file.
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(secrets[name], name).toBe(value);
    }
  });

  it("keeps the real Trello credentials out, which is the whole point", () => {
    expect(secrets.TRELLO_KEY).toBe("test-key");
    // A real Trello key is 32 hex characters and a real token is 64+; the dummies
    // are neither, so this fails loudly if .dev.vars ever wins again.
    expect(secrets.TRELLO_KEY).not.toMatch(/^[0-9a-f]{32}$/);
    expect(secrets.TRELLO_TOKEN).not.toMatch(/^[0-9a-f]{64,}$/);
  });

  it("binds a usable but throwaway DATA_KEY that is not written down anywhere", () => {
    // Generated per run in vitest.config.ts: valid (32 bytes, base64) so seal/open
    // works, and never committed, because a committed AES key reads as a leaked one.
    const key = secrets.DATA_KEY;
    expect(typeof key).toBe("string");
    expect(atob(String(key))).toHaveLength(32);
  });

  it("does not relax the Access gate for the whole runtime", () => {
    // DEV_MODE mirrors wrangler.jsonc. A suite that needs the gate relaxed passes
    // its own env to `app.fetch`; nothing gets it for free.
    expect(secrets.DEV_MODE).toBe("false");
  });

  it("still has the real bindings, which is why helpers spread env at all", () => {
    expect(env.DB).toBeDefined();
    expect(env.OAUTH_KV).toBeDefined();
    expect(env.ASSETS).toBeDefined();
  });
});
