// What an MCP client is shown of the pipeline's error codes: stored data and
// pipeline health, never what the phone was or was not allowed to read. The
// admin Phone page keeps the true codes (test/integration/api/phone.test.ts).

import { beforeEach, describe, expect, it } from "vitest";

import { PHONE_NOT_READING, mcpErrorCode } from "../../../../src/mcp/hc/phone-errors.ts";
import { DEVICE_ID, hcWorld } from "../hc-fake.ts";
import { NOW, callTool, connectTools, fakeDeps, fakeState } from "../helpers.ts";

import type { FakeState } from "../helpers.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const NOW_MS = NOW * 1000;

/** No wording about access may reach a client, in a code or anywhere else in an answer. */
const ACCESS_WORDING = /permi|denied|grant/i;

/** The companion app's and the server's codes that say nothing about access. */
const ORDINARY = [
  "unauthorized",
  "backfill_not_started",
  "hc_unavailable",
  "hc_rate_limited",
  "hc_remote",
  "hc_io",
  "hc_error",
  "hc_invalid_argument",
  "network",
  "bad_request",
  "unsupported_media_type",
  "payload_too_large",
  "record_too_large",
  "record_oversize_stubbed",
  "records_rejected",
  "batch_id_conflict",
  "pairing_changed",
  "aggregate_failed",
  "changes_token_unstable",
  "page_token_invalid",
  "rate_limited",
  "backlogged",
  "bad_response",
  "internal_error",
  "backfill_state_invalid",
  "unknown_record_type",
  "sync_failed",
  "state_store_failed",
  "hc_page_too_large",
  "waiting_for_wifi",
  "http_403",
  "http_502",
  "apply_gave_up",
  "batch_unreadable",
  "chunk_malformed",
  "crypto",
];

describe("mcpErrorCode", () => {
  it("reports no error for a type the phone was not let read", () => {
    expect(mcpErrorCode("permission_denied")).toBeNull();
  });

  it.each(["no_permissions", "background_read_missing"])(
    "says only that the phone is not reading for %s",
    (code) => {
      expect(mcpErrorCode(code)).toBe(PHONE_NOT_READING);
    },
  );

  it.each(["route_permission_missing", "ACCESS_DENIED", "history_grant_revoked", "not_granted"])(
    "replaces a code it has never heard of that talks about access: %s",
    (code) => {
      expect(mcpErrorCode(code)).toBe(PHONE_NOT_READING);
    },
  );

  it.each(ORDINARY)("passes %s on unchanged", (code) => {
    expect(mcpErrorCode(code)).toBe(code);
  });

  it("never returns a code worded about access", () => {
    expect(PHONE_NOT_READING).not.toMatch(ACCESS_WORDING);
    for (const code of ORDINARY) expect(code).not.toMatch(ACCESS_WORDING);
  });
});

describe("hc_sync_status error codes", () => {
  const world: { state: FakeState; client: Client } = {
    state: undefined as unknown as FakeState,
    client: undefined as unknown as Client,
  };

  beforeEach(async () => {
    world.state = fakeState({ hc: hcWorld(NOW) });
    world.client = await connectTools(fakeDeps(world.state));
  });

  const phoneSays = (errorCode: string): void => {
    const report = world.state.hc.reports.get(DEVICE_ID);
    if (report === undefined) throw new Error("the fake phone has no report");
    world.state.hc.reports.set(DEVICE_ID, { ...report, lastError: { errorCode, at: NOW_MS } });
  };

  const uploadsFailedWith = (...codes: string[]): void => {
    const [template] = world.state.hc.ingestLog.get(DEVICE_ID) ?? [];
    if (template === undefined) throw new Error("the fake phone has no uploads");
    world.state.hc.ingestLog.set(
      DEVICE_ID,
      codes.map((errorCode) => ({ ...template, status: "failed", appliedAt: null, errorCode })),
    );
  };

  const status = async (): Promise<{ phone: Record<string, unknown>; text: string }> => {
    const answer = await callTool(world.client, "hc_sync_status");
    const [phone] = answer.items;
    if (phone === undefined) throw new Error("no device row");
    return { phone, text: answer.text };
  };

  it("leaves out the phone's error when it is about one type it was not let read", async () => {
    phoneSays("permission_denied");

    const { phone, text } = await status();

    expect(phone.lastPhoneError).toBeNull();
    expect(text).not.toMatch(ACCESS_WORDING);
  });

  it.each(["no_permissions", "background_read_missing", "some_future_grant_problem"])(
    "says the phone is not reading for %s, in neutral words",
    async (code) => {
      phoneSays(code);

      const { phone, text } = await status();

      expect(phone.lastPhoneError).toMatchObject({ errorCode: PHONE_NOT_READING });
      expect(text).not.toMatch(ACCESS_WORDING);
    },
  );

  it("passes an ordinary phone error on as it is", async () => {
    phoneSays("hc_rate_limited");

    const { phone } = await status();

    expect(phone.lastPhoneError).toMatchObject({ errorCode: "hc_rate_limited" });
  });

  it("holds failed uploads to the same rule", async () => {
    uploadsFailedWith("apply_gave_up", "permission_denied", "upload_not_permitted");

    const { phone, text } = await status();

    expect((phone.recentFailures as { errorCode: string }[]).map((row) => row.errorCode)).toEqual([
      "apply_gave_up",
      PHONE_NOT_READING,
    ]);
    expect(text).not.toMatch(ACCESS_WORDING);
  });
});
