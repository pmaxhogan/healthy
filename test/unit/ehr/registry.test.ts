import { describe, expect, it } from "vitest";

import { ADAPTER_FACTORIES, adapterFor, isVendor, VENDORS } from "../../../worker/ehr/registry.ts";
import { AppError } from "../../../worker/lib/errors.ts";
import { noopLogger } from "../../../worker/lib/log.ts";

import { stubFetch } from "./fixtures.ts";

import type { AdapterDeps } from "../../../worker/ehr/adapter.ts";

const deps: AdapterDeps = {
  fetchImpl: stubFetch(() => new Response()).fetchImpl,
  logger: noopLogger,
  now: () => 0,
};

describe("registry", () => {
  it("knows exactly one vendor today", () => {
    expect(VENDORS).toStrictEqual(["epic"]);
    expect(Object.keys(ADAPTER_FACTORIES)).toStrictEqual(["epic"]);
  });

  it("narrows a string read out of D1", () => {
    expect(isVendor("epic")).toBe(true);
    expect(isVendor("oracle-health")).toBe(false);
    // Nothing inherited from Object.prototype counts as a vendor.
    expect(isVendor("constructor")).toBe(false);
    expect(isVendor("toString")).toBe(false);
  });

  it("builds the Epic adapter and rejects anything else as a bad request", () => {
    expect(adapterFor("epic", deps).vendor).toBe("epic");
    expect(() => adapterFor("oracle-health", deps)).toThrow(AppError);

    let captured: unknown;
    try {
      adapterFor("", deps);
    } catch (error) {
      captured = error;
    }

    expect((captured as AppError).code).toBe("bad_request");
    expect((captured as AppError).status).toBe(400);
  });

  it("returns a fresh adapter each time, so a request-scoped logger stays attached", () => {
    expect(adapterFor("epic", deps)).not.toBe(adapterFor("epic", deps));
  });
});
