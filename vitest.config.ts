import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
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
              bindings: { TEST_MIGRATIONS: migrations },
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
