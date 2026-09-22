import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  parseArgs,
  parseDotEnv,
  providerSecretAad,
  sealProviderSecret,
} from "../../scripts/set-provider-secret.ts";
import { aadFor, open } from "../../worker/db/crypto.ts";

// Synthetic ULIDs -- not real provider ids -- just something that satisfies
// worker/lib/ids.ts's ID_PATTERN shape for the tests below.
const PROVIDER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROVIDER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

function freshKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

describe("providerSecretAad", () => {
  it("matches the AAD the providers repo seals under", () => {
    // worker/db/repos/providers.ts derives its AAD as
    // `aadFor("providers", "client_secret_enc", id)`; this must be exactly
    // that, or a value this script writes would be unreadable to the Worker.
    expect(providerSecretAad(PROVIDER_ID)).toBe(
      aadFor("providers", "client_secret_enc", PROVIDER_ID),
    );
    expect(providerSecretAad(PROVIDER_ID)).toBe(`providers.client_secret_enc.${PROVIDER_ID}`);
  });
});

describe("sealProviderSecret", () => {
  it("round-trips through the Worker's own open()", async () => {
    const dataKey = freshKey();

    const sealed = await sealProviderSecret(dataKey, PROVIDER_ID, "a-confidential-client-secret");

    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("confidential");
    await expect(open(dataKey, sealed, providerSecretAad(PROVIDER_ID))).resolves.toBe(
      "a-confidential-client-secret",
    );
  });

  it("produces a value the providers repo's own AAD can open, and no other row's AAD can", async () => {
    const dataKey = freshKey();
    const sealed = await sealProviderSecret(dataKey, PROVIDER_ID, "another-secret");

    // Exactly the shape providersRepo.getClientSecret uses to open this cell.
    const repoAad = aadFor("providers", "client_secret_enc", PROVIDER_ID);
    await expect(open(dataKey, sealed, repoAad)).resolves.toBe("another-secret");

    // A ciphertext copied onto a different provider's row must not open.
    const otherProviderAad = aadFor("providers", "client_secret_enc", OTHER_PROVIDER_ID);
    await expect(open(dataKey, sealed, otherProviderAad)).rejects.toMatchObject({ code: "crypto" });
  });

  it("never seals the same secret to the same ciphertext twice", async () => {
    const dataKey = freshKey();
    const [first, second] = await Promise.all([
      sealProviderSecret(dataKey, PROVIDER_ID, "same-secret"),
      sealProviderSecret(dataKey, PROVIDER_ID, "same-secret"),
    ]);

    expect(first).not.toBe(second);
  });
});

describe("parseArgs", () => {
  it("accepts --provider with --remote or --local", () => {
    expect(parseArgs(["--provider", PROVIDER_ID, "--remote"])).toEqual({
      providerId: PROVIDER_ID,
      target: "--remote",
    });
    expect(parseArgs(["--provider", PROVIDER_ID, "--local"])).toEqual({
      providerId: PROVIDER_ID,
      target: "--local",
    });
  });

  it("refuses when --provider is missing", () => {
    expect(() => parseArgs(["--remote"])).toThrow(/--provider is required/);
  });

  it("refuses when neither --remote nor --local is given", () => {
    expect(() => parseArgs(["--provider", PROVIDER_ID])).toThrow(
      /exactly one of --remote or --local/,
    );
  });

  it("refuses when both --remote and --local are given", () => {
    expect(() => parseArgs(["--provider", PROVIDER_ID, "--remote", "--local"])).toThrow(
      /exactly one of --remote or --local/,
    );
  });

  it("refuses an unrecognized argument", () => {
    expect(() => parseArgs(["--provider", PROVIDER_ID, "--remote", "--bogus"])).toThrow(
      /unrecognized argument: --bogus/,
    );
  });

  it("refuses --provider with no value", () => {
    expect(() => parseArgs(["--provider", "--remote"])).toThrow(/--provider requires a value/);
  });
});

describe("parseDotEnv", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "set-provider-secret-test-"));
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
