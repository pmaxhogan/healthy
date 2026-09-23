import { describe, expect, it } from "vitest";

import { buildArgsSkeleton } from "../../src/lib/mcp-schema.ts";

describe("buildArgsSkeleton", () => {
  it("is empty when nothing is required", () => {
    expect(
      buildArgsSkeleton({
        type: "object",
        properties: { providers: { type: "array" }, limit: { type: "integer" } },
      }),
    ).toStrictEqual({});
  });

  it("prefills one placeholder per required property, typed to match", () => {
    const skeleton = buildArgsSkeleton({
      type: "object",
      properties: {
        provider: { type: "string" },
        id: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["provider", "id"],
    });

    expect(skeleton).toStrictEqual({ provider: "", id: "" });
  });

  it("picks a placeholder for every JSON Schema type", () => {
    const skeleton = buildArgsSkeleton({
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        a: { type: "array" },
        o: { type: "object" },
      },
      required: ["s", "n", "i", "b", "a", "o"],
    });

    expect(skeleton).toStrictEqual({ s: "", n: 0, i: 0, b: false, a: [], o: {} });
  });

  it("skips a required name the schema does not actually describe", () => {
    expect(
      buildArgsSkeleton({ type: "object", properties: {}, required: ["ghost"] }),
    ).toStrictEqual({});
  });

  it("copes with no properties and no required list at all", () => {
    expect(buildArgsSkeleton({ type: "object" })).toStrictEqual({});
  });
});
