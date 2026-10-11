import { describe, expect, it } from "vitest";

import { gunzipText, gzipText, packJson, unpackJson } from "../../../src/hc/codec.ts";

describe("hc codec", () => {
  it("round-trips a JSON value through gzip", async () => {
    const value = {
      origin: "com.example.wearable",
      records: [
        { id: "a", data: { count: 12, note: "café \u{1F600}" } },
        { id: "b", data: {} },
      ],
    };

    const packed = await packJson(value);

    expect(await unpackJson(packed)).toStrictEqual(value);
    // A gzip stream, by its magic number.
    expect([packed[0], packed[1]]).toStrictEqual([0x1f, 0x8b]);
  });

  it("compresses repetitive JSON, which is the reason it exists", async () => {
    const samples = Array.from({ length: 2000 }, (_, index) => ({
      t: 1_790_000_000_000 + index,
      bpm: 60,
    }));
    const json = JSON.stringify({ samples });

    const packed = await gzipText(json);

    expect(packed.length).toBeLessThan(json.length / 4);
    expect(await gunzipText(packed)).toBe(json);
  });

  it("round-trips the empty string", async () => {
    expect(await gunzipText(await gzipText(""))).toBe("");
  });

  it("rejects bytes that are not gzip", async () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    await expect(unpackJson(plain)).rejects.toThrow();
  });

  it("rejects gzip that does not hold JSON", async () => {
    await expect(unpackJson(await gzipText("{ not json"))).rejects.toThrow(SyntaxError);
  });

  it("rejects gzip that does not hold UTF-8", async () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd]);
    const { body } = new Response(bad);
    const stream = body?.pipeThrough(new CompressionStream("gzip"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());

    await expect(gunzipText(packed)).rejects.toThrow(TypeError);
  });
});
