import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

const shared = fileURLToPath(new URL("shared", import.meta.url));

// wrangler.jsonc publishes ./dist as the ASSETS binding. Miniflare resolves
// that path when it loads the config, and `npm run check` runs the tests before
// the build, so on a clean checkout the directory does not exist yet. Creating
// it empty is cheaper than reordering `check` away from the fail-fast order
// (lint and typecheck first).
mkdirSync("dist", { recursive: true });

// Read once here, in Node, and hand the parsed statements to the integration
// worker as a binding: the test runtime has no filesystem to read migrations
// from. test/integration/setup.ts applies them per test file.
const migrations = await readD1Migrations(fileURLToPath(new URL("migrations", import.meta.url)));

/**
 * Dummy values for every secret in `worker/env.ts`, bound into the integration
 * runtime.
 *
 * This is a safety fix, not a convenience. The pool loads `wrangler.jsonc` the way
 * `wrangler dev` does, which includes reading the developer's real `.dev.vars` into
 * `env` -- so a test helper that spreads `...env` (several do, to get the real D1
 * and Durable Object bindings) silently picks up the operator's real Trello token,
 * Google client secret and `DATA_KEY`. Nothing in the suite needs them, and a test
 * that asserted on one, logged one, or sent one to a stubbed upstream would put a
 * live credential somewhere it does not belong.
 *
 * `miniflare.bindings` is applied after the config is read, so these win. Every name
 * in `Env` is listed even where no test reads it: the point is that the real value
 * cannot be present, and a secret added to `Env` without a line here is a gap.
 * `test/integration/env.test.ts` asserts that this is in force.
 *
 * `DEV_MODE` is "false", matching wrangler.jsonc and production: a test that needs
 * the Access gate relaxed builds its own env and passes it to `app.fetch`, which is
 * what every suite here already does.
 *
 * `DATA_KEY` is generated per run rather than written down. A committed AES key is
 * indistinguishable from a leaked one to every scanner that will read this
 * repository, and the tests only need the key to be valid, not to be stable.
 */
const TEST_SECRETS: Record<string, string> = {
  DEV_MODE: "false",
  CF_ACCESS_TEAM_DOMAIN: "test-team.cloudflareaccess.test",
  CF_ACCESS_AUD: "test-access-aud",
  CF_ACCESS_ALLOWED_EMAIL: "owner@example.test",
  // Not a usable hash: the format is `pbkdf2$sha256$<iterations>$<salt>$<hash>`,
  // and this deliberately is not one, so nothing can log in with it by accident.
  PASSWORD_HASH: "test-password-hash",
  SESSION_SECRET: "test-session-secret",
  DATA_KEY: randomBytes(32).toString("base64"),
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  EPIC_CLIENT_ID_PROD: "test-epic-prod",
  EPIC_CLIENT_ID_NONPROD: "test-epic-nonprod",
  TRELLO_KEY: "test-key",
  TRELLO_TOKEN: "test-token",
  TRELLO_MUST_LIST_ID: "test-must-list",
  TRELLO_DONE_LIST_ID: "test-done-list",
};

export default defineConfig({
  resolve: { alias: { "@shared": shared } },
  test: {
    projects: [
      {
        // Plain Node. Everything that is pure logic and does not need a Worker
        // runtime lives here, because it runs an order of magnitude faster.
        resolve: { alias: { "@shared": shared } },
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        // The Vue SPA's component and helper tests. A browser-shaped DOM
        // (happy-dom) but no Worker runtime: these exercise src/** against
        // mocked fetch responses, so they stay in the same speed class as
        // `unit`. They live under test/spa/ rather than test/unit/spa/ so the
        // `unit` project's glob does not also pick them up and run them in a
        // DOM-less Node environment.
        plugins: [vue()],
        resolve: { alias: { "@shared": shared } },
        test: {
          name: "spa",
          environment: "happy-dom",
          include: ["test/spa/**/*.test.ts"],
        },
      },
      {
        // Real workerd, real D1, real Durable Objects, driven from
        // wrangler.jsonc so the tests and the deployment cannot drift.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              // @cloudflare/vitest-pool-workers 0.22.0 bundles a workerd that
              // only understands compatibility dates up to 2026-08-22, while
              // the deployed Worker is pinned to 2026-09-01. Overriding it here
              // rather than in wrangler.jsonc keeps production on the intended
              // date; drop this line once the pool ships a newer workerd.
              compatibilityDate: "2026-08-22",
              // The dummy secrets come last so they override anything the
              // config (or the operator's .dev.vars) supplied. See TEST_SECRETS.
              bindings: { TEST_MIGRATIONS: migrations, ...TEST_SECRETS },
            },
          }),
        ],
        resolve: { alias: { "@shared": shared } },
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          setupFiles: ["./test/integration/setup.ts"],
        },
      },
    ],
  },
});
