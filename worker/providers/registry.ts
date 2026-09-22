/**
 * vendor -> adapter.
 *
 * The only place in the Worker that names a vendor. Adding Oracle Health means
 * one entry here and one implementation under `providers/`.
 */

import { AppError } from "../lib/errors.ts";

import { createEpicAdapter } from "./epic/index.ts";

import type { AdapterDeps, ProviderAdapter, ProviderAdapterFactory } from "./adapter.ts";
import type { Vendor } from "../fhir/types.ts";

export const ADAPTER_FACTORIES: Record<Vendor, ProviderAdapterFactory> = {
  epic: createEpicAdapter,
};

export const VENDORS: readonly Vendor[] = Object.keys(ADAPTER_FACTORIES) as Vendor[];

/** Narrow a string read out of D1 or a request body to a known vendor. */
export function isVendor(value: string): value is Vendor {
  return Object.hasOwn(ADAPTER_FACTORIES, value);
}

/**
 * Build the adapter for a vendor.
 *
 * A new adapter per call: adapters hold only the injected dependencies, so they
 * are cheap, and giving each request its own keeps the request-scoped logger
 * attached to the right request.
 */
export function adapterFor(vendor: string, deps: AdapterDeps): ProviderAdapter {
  if (!isVendor(vendor)) {
    throw new AppError("bad_request", "unknown provider vendor", { vendor });
  }
  // `isVendor` above is the guard: `vendor` is a key of this const map by then.
  return ADAPTER_FACTORIES[vendor](deps);
}
