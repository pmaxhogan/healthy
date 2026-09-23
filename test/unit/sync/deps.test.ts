// `resolveDeps`/`portalDeps` must never hand out the raw global `fetch`
// reference as a default: a real portal sign-in broke in production because
// `worker/providers/mychart/http.ts` calls its `fetchImpl` as `deps.fetchImpl(...)`
// -- a property-access call, which sets `this` to the deps object -- and
// workerd's native `fetch` throws "Illegal invocation" for any `this` other
// than itself or `undefined`. The fix is the default itself: wrap it in a
// plain function the way `worker/api/ports.ts`'s `defaults()` already does, so
// a `this` set by *any* caller's property access is thrown away before the
// real `fetch` is ever reached.

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDeps } from "../../../worker/sync/deps.ts";
import { portalDeps } from "../../../worker/sync/portal-signin.ts";

/**
 * Stands in for workerd's native `fetch`. Throws unless called with no
 * receiver at all, exactly the check the real one performs internally.
 */
function strictFetch(this: unknown): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Illegal invocation");
  }
  return Promise.resolve(new Response("ok"));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveDeps", () => {
  it("wraps the default fetchImpl rather than handing out the raw reference", async () => {
    vi.stubGlobal("fetch", strictFetch);
    const resolved = resolveDeps({});

    // The shape that broke in production: a property-access call sets `this`
    // to the object the function is hung off of.
    const caller = { fetchImpl: resolved.fetchImpl };
    await expect(caller.fetchImpl("https://example.test/")).resolves.toBeInstanceOf(Response);
  });

  it("wraps the default trelloFetch the same way", async () => {
    vi.stubGlobal("fetch", strictFetch);
    const resolved = resolveDeps({});

    const caller = { trelloFetch: resolved.trelloFetch };
    await expect(caller.trelloFetch("https://example.test/")).resolves.toBeInstanceOf(Response);
  });

  it("still falls back trelloFetch to a caller-supplied fetchImpl when none of its own is given", () => {
    // Unchanged by this fix: a caller-supplied `fetchImpl` is trusted as given,
    // the same way a test's own stub always has been. Only the *default* --
    // reached when the caller supplies neither -- had to stop being the raw
    // global reference.
    const custom = vi.fn(() => Promise.resolve(new Response("ok")));
    const resolved = resolveDeps({ fetchImpl: custom });

    expect(resolved.trelloFetch).toBe(custom);
  });
});

describe("portalDeps", () => {
  it("wraps the default fetchImpl rather than handing out the raw reference", async () => {
    vi.stubGlobal("fetch", strictFetch);
    const deps = portalDeps({});

    const caller = { fetchImpl: deps.fetchImpl };
    await expect(caller.fetchImpl("https://example.test/")).resolves.toBeInstanceOf(Response);
  });
});
