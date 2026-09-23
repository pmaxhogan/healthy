import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  parseArgs,
  parseDotEnv,
  healthSystemSecretAad,
  sealHealthSystemSecret,
} from "../../scripts/set-health-system-secret.ts";
import { aadFor, open } from "../../worker/db/crypto.ts";

// Synthetic ULIDs -- not real health system ids -- just something that satisfies
// worker/lib/ids.ts's ID_PATTERN shape for the tests below.
const HEALTH_SYSTEM_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_HEALTH_SYSTEM_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function freshKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

describe("healthSystemSecretAad", () => {
  it("matches the AAD the health systems repo seals under", () => {
    // worker/db/repos/health systems.ts derives its AAD as
    // `aadFor("health_systems", "client_secret_enc", id)`; this must be exactly
    // that, or a value this script writes would be unreadable to the Worker.
    expect(healthSystemSecretAad(HEALTH_SYSTEM_ID)).toBe(
      aadFor("providers", "client_secret_enc", HEALTH_SYSTEM_ID),
    );
    expect(healthSystemSecretAad(HEALTH_SYSTEM_ID)).toBe(
      `providers.client_secret_enc.${HEALTH_SYSTEM_ID}`,
    );
  });
});

describe("sealHealthSystemSecret", () => {
  it("round-trips through the Worker's own open()", async () => {
    const dataKey = freshKey();

    const sealed = await sealHealthSystemSecret(
      dataKey,
      HEALTH_SYSTEM_ID,
      "a-confidential-client-secret",
    );

    expect(sealed.startsWith("v2:")).toBe(true);
    expect(sealed).not.toContain("confidential");
    await expect(open(dataKey, sealed, healthSystemSecretAad(HEALTH_SYSTEM_ID))).resolves.toBe(
      "a-confidential-client-secret",
    );
  });

  it("produces a value the health systems repo's own AAD can open, and no other row's AAD can", async () => {
    const dataKey = freshKey();
    const sealed = await sealHealthSystemSecret(dataKey, HEALTH_SYSTEM_ID, "another-secret");

    // Exactly the shape healthSystemsRepo.getClientSecret uses to open this cell.
    const repoAad = aadFor("providers", "client_secret_enc", HEALTH_SYSTEM_ID);
    await expect(open(dataKey, sealed, repoAad)).resolves.toBe("another-secret");

    // A ciphertext copied onto a different health system's row must not open.
    const otherHealthSystemAad = aadFor("providers", "client_secret_enc", OTHER_HEALTH_SYSTEM_ID);
    await expect(open(dataKey, sealed, otherHealthSystemAad)).rejects.toMatchObject({
      code: "crypto",
    });
  });

  it("never seals the same secret to the same ciphertext twice", async () => {
    const dataKey = freshKey();
    const [first, second] = await Promise.all([
      sealHealthSystemSecret(dataKey, HEALTH_SYSTEM_ID, "same-secret"),
      sealHealthSystemSecret(dataKey, HEALTH_SYSTEM_ID, "same-secret"),
    ]);

    expect(first).not.toBe(second);
  });
});

describe("parseArgs", () => {
  it("accepts --health-system with --remote or --local", () => {
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--remote",
    });
    expect(parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--local"])).toEqual({
      healthSystemId: HEALTH_SYSTEM_ID,
      target: "--local",
    });
  });

  it("refuses when --health-system is missing", () => {
    expect(() => parseArgs(["--remote"])).toThrow(/--health-system is required/);
  });

  it("refuses when neither --remote nor --local is given", () => {
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID])).toThrow(
      /exactly one of --remote or --local/,
    );
  });

  it("refuses when both --remote and --local are given", () => {
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--local"])).toThrow(
      /exactly one of --remote or --local/,
    );
  });

  it("refuses an unrecognized argument", () => {
    expect(() => parseArgs(["--health-system", HEALTH_SYSTEM_ID, "--remote", "--bogus"])).toThrow(
      /unrecognized argument: --bogus/,
    );
  });

  it("refuses --health-system with no value", () => {
    expect(() => parseArgs(["--health-system", "--remote"])).toThrow(
      /--health-system requires a value/,
    );
  });
});

describe("parseDotEnv", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "set-health_system-secret-test-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty map for a missing file", () => {
    expect(parseDotEnv(path.join(dir, "does-not-exist.env"))).toEqual(new Map());
  });

  it("parses NAME=value lines, skipping blanks and comments", () => {
    const file = path.join(dir, "plain.env");
    writeFileSync(
      file,
      ["# a comment", "", "DATA_KEY=abc123", "OTHER = spaced ", ""].join("\n"),
      "utf8",
    );

    const values = parseDotEnv(file);

    expect(values.get("DATA_KEY")).toBe("abc123");
    expect(values.get("OTHER")).toBe("spaced");
    expect(values.has("")).toBe(false);
  });

  it("strips one layer of matching quotes", () => {
    const file = path.join(dir, "quoted.env");
    writeFileSync(file, ['DATA_KEY="quoted-value"', "SINGLE='also-quoted'"].join("\n"), "utf8");

    const values = parseDotEnv(file);

    expect(values.get("DATA_KEY")).toBe("quoted-value");
    expect(values.get("SINGLE")).toBe("also-quoted");
  });
});
