// Brings the real D1 schema up before any integration test runs, using the
// same migrations/ directory that `npm run migrate:remote` applies in
// production. A schema change that breaks the migration therefore breaks the
// test suite, which is the point.

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
