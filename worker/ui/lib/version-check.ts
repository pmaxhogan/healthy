// "A newer build is deployed -- reload."
//
// A push to main deploys the Worker and the SPA together, but a tab opened before
// the deploy keeps running the old bundle against the new API. A request shape
// the new Worker no longer accepts answers `bad_request`, which reads to the
// owner as a bug in whatever they just clicked.
//
// The check needs no build plumbing: Vite names the entry bundle by content hash
// (`/assets/index-<hash>.js`) and the Worker serves index.html `no-store`, so
// "the entry script the live index.html names" differs from "the one this page
// was loaded with" exactly when a new build is live. Under `npm run dev` the page
// has no `/assets/` entry at all, and the check does nothing.

import { ApiRequestError } from "../api/client.ts";

import { toastAction } from "./toasts.ts";

/** Checks are cheap but not free; one a minute is plenty to catch a deploy. */
const MIN_INTERVAL_MS = 60_000;

const ENTRY_SELECTOR = 'script[type="module"][src^="/assets/"]';

interface VersionCheckConfig {
  fetch: typeof globalThis.fetch;
  reload: () => void;
  now: () => number;
  /** The page whose running bundle is compared. */
  page: () => Document;
}

const config: VersionCheckConfig = {
  fetch: (input, init) => fetch(input, init),
  reload: () => {
    location.reload();
  },
  now: () => Date.now(),
  page: () => document,
};

/** Mutable module state, in an object for the same lint reason as toasts.ts. */
const state = { lastCheckAt: -Infinity, notified: false };

/** Test seam. Production code never calls this. */
export function configureVersionCheck(overrides: Partial<VersionCheckConfig>): void {
  Object.assign(config, overrides);
  state.lastCheckAt = -Infinity;
  state.notified = false;
}

/** The hashed entry bundle a document loads, or null when it has none (dev). */
function entryOf(doc: Document): string | null {
  const script = doc.querySelector<HTMLScriptElement>(ENTRY_SELECTOR);
  return script?.getAttribute("src") ?? null;
}

async function liveEntry(): Promise<string | null> {
  const response = await config.fetch("/", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  // A login wall, an Access redirect, a Worker error: none of those is evidence
  // of a new build, and the API client already handles the auth cases.
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) {
    return null;
  }
  const html = await response.text();
  return entryOf(new DOMParser().parseFromString(html, "text/html"));
}

/**
 * Compare the running bundle with the live one, at most once a minute, and
 * offer a reload once if they differ. Never throws -- this runs from error
 * paths and event listeners, where a failure of its own would only add noise.
 *
 * Resolves with whether a newer build was found.
 */
export async function checkForNewVersion(): Promise<boolean> {
  if (state.notified) return true;
  const running = entryOf(config.page());
  if (running === null) return false;
  const now = config.now();
  if (now - state.lastCheckAt < MIN_INTERVAL_MS) return false;
  state.lastCheckAt = now;

  try {
    const live = await liveEntry();
    if (live === null || live === running) return false;
  } catch {
    return false;
  }
  state.notified = true;
  toastAction("Healthy was updated since this page was opened. Reload to get the new version.", {
    label: "Reload",
    run: () => {
      config.reload();
    },
  });
  return true;
}

/**
 * Check whenever the owner comes back to the tab -- the moment a long-open page
 * is most likely to be stale.
 */
export function watchForNewVersion(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForNewVersion();
  });
}

/**
 * After a failed request: a 400 or a 404 from the API is what an old bundle
 * talking to a new Worker looks like (a field renamed, a route moved), so it is
 * worth one check. Anything else -- a 5xx, a network error -- is not.
 */
export function checkAfterError(error: unknown): void {
  if (error instanceof ApiRequestError && (error.status === 400 || error.status === 404)) {
    void checkForNewVersion();
  }
}
