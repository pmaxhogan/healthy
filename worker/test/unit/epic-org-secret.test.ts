import { describe, expect, it } from "vitest";

import { parseArgs } from "../../scripts/epic-org-secret.ts";

describe("epic-org-secret parseArgs", () => {
  it("derives for production unless told otherwise", () => {
    expect(parseArgs(["--org", "99001"])).toStrictEqual({
      mode: "derive",
      orgId: "99001",
      environment: "prod",
    });
  });

  it("maps nonprod onto the environment the Worker stores", () => {
    expect(parseArgs(["--org", "99001", "--env", "nonprod"])).toMatchObject({
      environment: "sandbox",
    });
    expect(() => parseArgs(["--org", "99001", "--env", "staging"])).toThrow(/prod or nonprod/u);
  });

  it("requires an organisation id, and never takes a flag as one", () => {
    expect(() => parseArgs([])).toThrow(/--org is required/u);
    expect(() => parseArgs(["--org", "--env"])).toThrow(/requires a value/u);
  });

  it("keeps key generation separate from derivation", () => {
    expect(parseArgs(["--gen-key"])).toStrictEqual({ mode: "gen-key", put: false });
    expect(parseArgs(["--gen-key", "--put"])).toStrictEqual({ mode: "gen-key", put: true });
    expect(() => parseArgs(["--gen-key", "--org", "99001"])).toThrow(/cannot be combined/u);
    expect(() => parseArgs(["--org", "99001", "--put"])).toThrow(/only applies/u);
  });

  it("rejects anything it does not recognise", () => {
    expect(() => parseArgs(["--org", "99001", "--verbose"])).toThrow(/unrecognized/u);
  });
});
