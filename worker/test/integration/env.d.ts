// `cloudflare:test` types `env` as `Cloudflare.Env`, which wrangler generates
// from wrangler.jsonc. TEST_MIGRATIONS is injected by vitest.config.ts and has
// no place in that file, so it is merged in here instead.

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
