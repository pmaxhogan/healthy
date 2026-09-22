// `safeNextPath` is the whole of what stands between `?next` and an open
// redirect, or a response header an attacker gets to splice a line into. Every
// rejection branch is exercised on its own so a future edit that loosens one
// check cannot hide behind another still catching the same input.

import { describe, expect, it } from "vitest";

// Imported from safe-next-path.ts directly, not from gate.ts: gate.ts also
// imports the full worker `Env` (for `AppHonoEnv`), which needs
// worker-configuration.d.ts -- present for the worker and integration
// tsconfigs, but not for this plain-Node unit-test project. safe-next-path.ts
// has no such dependency, which is the whole reason it was split out.
import { safeNextPath } from "../../../worker/auth/safe-next-path.ts";

describe("safeNextPath", () => {
  it("keeps an ordinary same-origin path, query string included", () => {
    expect(safeNextPath("/settings?x=1")).toBe("/settings?x=1");
  });

  it("rejects a missing or empty value", () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath("")).toBeNull();
  });

  it("rejects anything not starting with a single leading slash", () => {
    expect(safeNextPath("settings")).toBeNull();
    expect(safeNextPath("https://evil.example")).toBeNull();
  });

  it("rejects a protocol-relative path", () => {
    expect(safeNextPath("//evil.example")).toBeNull();
  });

  it("rejects a backslash anywhere, since some browsers treat it as a slash", () => {
    expect(safeNextPath(String.raw`/\evil.example`)).toBeNull();
    expect(safeNextPath(String.raw`/ok\evil.example`)).toBeNull();
  });

  it("rejects the auth endpoints, to avoid bouncing straight back to the form", () => {
    expect(safeNextPath("/auth")).toBeNull();
    expect(safeNextPath("/auth/login")).toBeNull();
  });

  describe("control characters", () => {
    it("rejects a raw tab", () => {
      expect(safeNextPath("/\t/evil.example")).toBeNull();
    });

    it("rejects the value a query-decoded %09 becomes", () => {
      // Hono decodes the query string before this function ever sees it, so the
      // input here is not the literal "%09" -- it is what decoding it produces.
      expect(safeNextPath(decodeURIComponent("/%09/evil.example"))).toBeNull();
    });

    it("rejects NUL and CR/LF", () => {
      expect(safeNextPath("/foo\u{0}bar")).toBeNull();
      expect(safeNextPath("/foo\r\nbar")).toBeNull();
    });

    it("rejects DEL (0x7F)", () => {
      expect(safeNextPath("/foo\u{7F}bar")).toBeNull();
    });

    it("still accepts an ordinary path once the control character is gone", () => {
      expect(safeNextPath("/foo/evil.example")).toBe("/foo/evil.example");
    });
  });
});
