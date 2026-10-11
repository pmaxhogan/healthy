import { describe, expect, it } from "vitest";

import { ADAPTER_FACTORIES, adapterFor, isVendor, VENDORS } from "../../../src/ehr/registry.ts";
import { AppError } from "../../../src/lib/errors.ts";
import { noopLogger } from "../../../src/lib/log.ts";

import { stubFetch } from "./fixtures.ts";

import type { AdapterDeps } from "../../../src/ehr/adapter.ts";

const deps: AdapterDeps = {
  fetchImpl: stubFetch(() => new Response()).fetchImpl,
  logger: noopLogger,
  now: () => 0,
};

describe("registry", () => {
  it("knows exactly two vendors today", () => {
    expect(VENDORS).toStrictEqual(["epic", "modmed"]);
    expect(Object.keys(ADAPTER_FACTORIES)).toStrictEqual(["epic", "modmed"]);
  });

  it("narrows a string read out of D1", () => {
    expect(isVendor("epic")).toBe(true);
    expect(isVendor("modmed")).toBe(true);
    expect(isVendor("oracle-health")).toBe(false);
    // Nothing inherited from Object.prototype counts as a vendor.
    expect(isVendor("constructor")).toBe(false);
    expect(isVendor("toString")).toBe(false);
  });

  it("builds the adapter for the vendor named", () => {
    expect(adapterFor("epic", deps).vendor).toBe("epic");
    expect(adapterFor("modmed", deps).vendor).toBe("modmed");
  });

  it("gives each vendor its own refresh margin and search style", () => {
    expect(adapterFor("epic", deps).categoryScopedSearches).toBe(true);
    expect(adapterFor("epic", deps).refreshSkewMs).toBe(5 * 60 * 1000);
    expect(adapterFor("modmed", deps).categoryScopedSearches).toBe(false);
    expect(adapterFor("modmed", deps).refreshSkewMs).toBe(60 * 1000);
    expect(adapterFor("epic", deps).encountersAreAppointments).toBe(true);
    expect(adapterFor("modmed", deps).encountersAreAppointments).toBe(false);
  });

  it("rejects an unknown vendor as a bad request", () => {
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
    expect(adapterFor("modmed", deps)).not.toBe(adapterFor("modmed", deps));
  });
});
