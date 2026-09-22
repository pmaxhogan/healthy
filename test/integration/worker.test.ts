import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PBKDF2_ITERATIONS } from "@shared/password.ts";

describe("the Worker", () => {
  it("answers GET /health publicly, with a body that leaks nothing", async () => {
    const response = await SELF.fetch("https://healthy.example/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ ok: true });
  });

  it("404s as JSON rather than falling through to the SPA assets", async () => {
    // Guards the wave-0 posture: no route is reachable before its gate exists,
    // so an unknown path must not serve the admin UI.
    const response = await SELF.fetch("https://healthy.example/api/overview");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });
});

describe("D1 migrations", () => {
  it("apply, creating the settings table", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
      .bind("settings")
      .first<{ name: string }>();

    expect(row?.name).toBe("settings");
  });

  it("create every table the schema declares", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    ).all<{ name: string }>();
    const tables = new Set(results.map((r) => r.name));

    for (const table of [
      "settings",
      "providers",
      "connections",
      "google_account",
      "oauth_states",
      "fhir_cache",
      "fhir_sync_state",
      "calendar_events",
      "alerts",
      "mcp_audit",
      "mcp_policy",
      "run_log",
      "login_attempts",
    ]) {
      expect(tables, table).toContain(table);
    }
  });

  it("enforce the single-row invariant on google_account", async () => {
    // The CHECK (id = 1) constraint is the thing keeping a second Google
    // account from ever being half-connected alongside the first.
    await expect(
      env.DB.prepare("INSERT INTO google_account (id, status, updated_at) VALUES (2, ?, 0)")
        .bind("disconnected")
        .run(),
    ).rejects.toThrow();
  });
});

describe("WebCrypto in workerd", () => {
  it(`can derive PBKDF2-SHA256 at the configured ${String(PBKDF2_ITERATIONS)} iterations`, async () => {
    // The Workers runtime caps PBKDF2 iterations, and the cap has moved over
    // time. A PASSWORD_HASH minted above the cap cannot be verified in
    // production, which locks the owner out of the admin UI -- so the cost
    // parameter in scripts/hash-password.ts is asserted against the real
    // runtime rather than assumed.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("password"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new Uint8Array(16),
        iterations: PBKDF2_ITERATIONS,
      },
      key,
      256,
    );

    expect(bits.byteLength).toBe(32);
  });
});
