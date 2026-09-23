import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiRequestError } from "../../src/api/client.ts";
import ToastStack from "../../src/components/ToastStack.vue";
import { toastAction, toasts } from "../../src/lib/toasts.ts";
import {
  checkAfterError,
  checkForNewVersion,
  configureVersionCheck,
} from "../../src/lib/version-check.ts";

import { fakeResponse, urlOf } from "./helpers.ts";

/** index.html as `vite build` writes it, naming one hashed entry bundle. */
function indexHtml(entry: string): string {
  return `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head><body><div id="app"></div></body></html>`;
}

/**
 * The page this bundle was loaded from. A parsed document rather than scripts
 * added to the live one: happy-dom tries to load a module script the moment it
 * is connected.
 */
const running: { page: Document } = { page: document };

function runningEntry(entry: string | null): void {
  running.page = new DOMParser().parseFromString(
    entry === null ? "<html><body></body></html>" : indexHtml(entry),
    "text/html",
  );
}

interface Harness {
  fetches: string[];
  reloads: number;
  clock: { now: number };
}

function install(respond: () => Response): Harness {
  const harness: Harness = { fetches: [], reloads: 0, clock: { now: 1_000_000 } };
  configureVersionCheck({
    fetch: (input) => {
      harness.fetches.push(urlOf(input));
      return Promise.resolve(respond());
    },
    reload: () => {
      harness.reloads += 1;
    },
    now: () => harness.clock.now,
    page: () => running.page,
  });
  return harness;
}

describe("version check", () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  afterEach(() => {
    runningEntry(null);
  });

  it("does nothing under the dev server, where there is no hashed bundle", async () => {
    runningEntry(null);
    const harness = install(() => fakeResponse({ html: indexHtml("/assets/index-new.js") }));

    expect(await checkForNewVersion()).toBe(false);
    expect(harness.fetches).toStrictEqual([]);
  });

  it("stays quiet while the live index.html names the running bundle", async () => {
    runningEntry("/assets/index-aaa.js");
    install(() => fakeResponse({ html: indexHtml("/assets/index-aaa.js") }));

    expect(await checkForNewVersion()).toBe(false);
    expect(toasts).toHaveLength(0);
  });

  it("offers a reload once a newer bundle is live", async () => {
    runningEntry("/assets/index-aaa.js");
    const harness = install(() => fakeResponse({ html: indexHtml("/assets/index-bbb.js") }));

    expect(await checkForNewVersion()).toBe(true);

    expect(harness.fetches).toStrictEqual(["/"]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.text).toContain("Reload");
    toasts[0]?.action?.run();
    expect(harness.reloads).toBe(1);

    // Once is enough: a second check neither fetches nor stacks another toast.
    harness.clock.now += 10 * 60_000;
    expect(await checkForNewVersion()).toBe(true);
    expect(harness.fetches).toHaveLength(1);
    expect(toasts).toHaveLength(1);
  });

  it("checks at most once a minute", async () => {
    runningEntry("/assets/index-aaa.js");
    const harness = install(() => fakeResponse({ html: indexHtml("/assets/index-aaa.js") }));

    await checkForNewVersion();
    harness.clock.now += 30_000;
    await checkForNewVersion();
    expect(harness.fetches).toHaveLength(1);

    harness.clock.now += 31_000;
    await checkForNewVersion();
    expect(harness.fetches).toHaveLength(2);
  });

  it("does not read a login wall or an error as a new build", async () => {
    runningEntry("/assets/index-aaa.js");
    const harness = install(() =>
      fakeResponse({ status: 401, html: indexHtml("/assets/index-bbb.js") }),
    );
    expect(await checkForNewVersion()).toBe(false);

    harness.clock.now += 61_000;
    configureVersionCheck({
      fetch: () => Promise.resolve(fakeResponse({ body: { error: "not_found" } })),
    });
    expect(await checkForNewVersion()).toBe(false);

    configureVersionCheck({ fetch: () => Promise.reject(new TypeError("offline")) });
    expect(await checkForNewVersion()).toBe(false);
    expect(toasts).toHaveLength(0);
  });

  it("runs after a 400 or 404 from the API, and not after a 5xx", async () => {
    runningEntry("/assets/index-aaa.js");
    const harness = install(() => fakeResponse({ html: indexHtml("/assets/index-aaa.js") }));

    checkAfterError(new ApiRequestError(502, { error: "upstream_error" }));
    checkAfterError(new Error("network"));
    await Promise.resolve();
    expect(harness.fetches).toStrictEqual([]);

    checkAfterError(new ApiRequestError(400, { error: "bad_request" }));
    await Promise.resolve();
    expect(harness.fetches).toStrictEqual(["/"]);
  });
});

describe("ToastStack: an action toast", () => {
  it("renders the action as a button that runs it", async () => {
    toasts.length = 0;
    const ran: string[] = [];
    toastAction("A newer build is live.", {
      label: "Reload",
      run: () => {
        ran.push("reload");
      },
    });
    const wrapper = mount(ToastStack);

    const button = wrapper.findAll("button").find((candidate) => candidate.text() === "Reload");
    expect(button).toBeDefined();
    await button?.trigger("click");

    expect(ran).toStrictEqual(["reload"]);
  });
});
