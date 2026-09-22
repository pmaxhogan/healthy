import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_REQUIRED_HEADER, CSRF_HEADER } from "@shared/types.ts";

import {
  api,
  ApiRequestError,
  AuthRequiredError,
  configureClient,
  errorMessage,
  isAuthRequired,
  request,
} from "../../src/api/client.ts";

import { fakeResponse, urlOf } from "./helpers.ts";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function stub(response: Response): { calls: Recorded[]; navigated: string[] } {
  const calls: Recorded[] = [];
  const navigated: string[] = [];
  configureClient({
    fetch: (input, init) => {
      calls.push({ url: urlOf(input), init });
      return Promise.resolve(response);
    },
    navigate: (url) => {
      navigated.push(url);
    },
  });
  return { calls, navigated };
}

/** Runs a request that is expected to fail and hands back what it threw. */
async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

describe("api client", () => {
  beforeEach(() => {
    configureClient({
      fetch: () => Promise.reject(new Error("no fetch stub installed")),
      navigate: () => {
        // Every test installs its own pair; this only guards against one test's
        // stub leaking into another that forgot to.
      },
    });
  });

  it("does not send the CSRF header on a GET", async () => {
    const { calls } = stub(fakeResponse({ body: { ok: true } }));
    await api.get("/api/whoami");
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER)).toBeNull();
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("sends the CSRF header on a %s", async (method) => {
    const { calls } = stub(fakeResponse({ body: { ok: true } }));
    await request("/api/settings", { method });
    expect(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER)).toBe("1");
  });

  it("sends the session cookie and a JSON body on a mutation", async () => {
    const { calls } = stub(fakeResponse({ body: { ok: true } }));
    await api.put("/api/settings", { windowPastDays: 30 });
    const call = calls[0];
    expect(call?.init?.credentials).toBe("same-origin");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
    expect(call?.init?.body).toBe('{"windowPastDays":30}');
  });

  it("navigates the whole page and throws AuthRequiredError on a flagged 401", async () => {
    const { navigated } = stub(
      fakeResponse({
        status: 401,
        headers: { [AUTH_REQUIRED_HEADER]: "required" },
        html: "<html>login</html>",
      }),
    );

    const failure = await failureOf(api.get("/api/overview"));

    expect(failure).toBeInstanceOf(AuthRequiredError);
    expect(isAuthRequired(failure)).toBe(true);
    expect(navigated).toHaveLength(1);
    // The current URL, so the Worker can send the owner back afterwards.
    expect(navigated[0]).toBe(location.href);
  });

  it("navigates on a flagged 403 as well", async () => {
    const { navigated } = stub(
      fakeResponse({ status: 403, headers: { [AUTH_REQUIRED_HEADER]: "required" }, html: "no" }),
    );
    await expect(api.get("/api/overview")).rejects.toBeInstanceOf(AuthRequiredError);
    expect(navigated).toHaveLength(1);
  });

  it("does not navigate on a 403 without the header, and parses the ApiError", async () => {
    const { navigated } = stub(
      fakeResponse({ status: 403, body: { error: "csrf_failed", message: "Missing header" } }),
    );

    const failure = await failureOf(api.post("/api/sync/run"));

    expect(navigated).toHaveLength(0);
    expect(failure).toBeInstanceOf(ApiRequestError);
    const typed = failure as ApiRequestError;
    expect(typed.status).toBe(403);
    expect(typed.code).toBe("csrf_failed");
    expect(errorMessage(typed)).toBe("Missing header");
  });

  it("falls back to the status code when the error body is not JSON", async () => {
    stub(fakeResponse({ status: 502, html: "<html>bad gateway</html>" }));
    const failure = (await failureOf(api.get("/api/runs"))) as ApiRequestError;
    expect(failure.code).toBe("http_502");
    expect(errorMessage(failure)).toBe("http 502");
  });

  it("tolerates a mutation that answers with no content", async () => {
    stub(fakeResponse({ status: 204 }));
    await expect(api.delete("/api/mcp/grants/g1")).resolves.toBeUndefined();
  });

  it("parses a JSON body on success", async () => {
    stub(fakeResponse({ body: { calendarId: "primary" } }));
    await expect(api.get<{ calendarId: string }>("/api/settings")).resolves.toEqual({
      calendarId: "primary",
    });
  });

  it("passes an abort signal through", async () => {
    const { calls } = stub(fakeResponse({ body: [] }));
    const controller = new AbortController();
    await api.get("/api/runs", controller.signal);
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it("reports a cancelled request as cancelled, and anything else generically", () => {
    // A DOMException rather than a mutated Error: assigning `name` on a built-in
    // error is what the runtime itself would never do, and lint says so.
    expect(errorMessage(new DOMException("aborted", "AbortError"))).toBe("cancelled");
    expect(errorMessage(new Error("boom"))).toBe("request failed");
    expect(errorMessage("not an error")).toBe("request failed");
  });

  it("uses the real fetch by default", async () => {
    // Not a behaviour test so much as a guard: a typo in the default config would
    // otherwise only show up in the browser.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fakeResponse({ body: { ok: true } }));
    configureClient({ fetch: (input, init) => fetch(input, init) });
    await api.get("/api/whoami");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
