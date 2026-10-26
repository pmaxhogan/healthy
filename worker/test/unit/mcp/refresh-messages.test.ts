// `refresh_messages`: the second tool that acts, its token bucket, and every
// way it says no.
//
// Driven over the SDK's in-memory transport against the real `McpServer`, the
// real schema and the real bucket arithmetic; only the sync engine behind
// `ToolDeps.sync` is faked, and the fake records every refresh a call ran. So
// "nothing was read" below is a fact about what reached the engine.
//
// Every health system here is synthetic.

import { beforeEach, describe, expect, it } from "vitest";

import { MESSAGE_REFRESH_LIMITS } from "../../../src/mcp/message-refresh.ts";
import { buildRules } from "../../../src/policy/rules.ts";

import {
  HEALTH_SYSTEM_A,
  HEALTH_SYSTEM_B,
  NAME_A,
  NOW,
  callTool,
  connectTools,
  fakeDeps,
  fakeState,
} from "./helpers.ts";

import type { FakeState } from "./helpers.ts";
import type { HealthSystemInfo } from "../../../src/mcp/deps.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const TOOL = "refresh_messages";
const { capacity, refillSeconds } = MESSAGE_REFRESH_LIMITS;

const world: { state: FakeState; client: Client } = {
  state: fakeState(),
  client: undefined as unknown as Client,
};

beforeEach(async () => {
  world.state = fakeState();
  world.client = await connectTools(fakeDeps(world.state));
});

function patchPortal(id: string, change: Partial<NonNullable<HealthSystemInfo["portal"]>>): void {
  world.state.healthSystems = world.state.healthSystems.map((healthSystem) =>
    healthSystem.id === id && healthSystem.portal !== null
      ? { ...healthSystem, portal: { ...healthSystem.portal, ...change } }
      : healthSystem,
  );
}

async function refresh(healthSystem: string = HEALTH_SYSTEM_A) {
  return callTool(world.client, TOOL, { healthSystem });
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe("naming the health system", () => {
  it("takes an id", async () => {
    const answer = await refresh(HEALTH_SYSTEM_A);
    expect(answer.items).toMatchObject([{ healthSystemId: HEALTH_SYSTEM_A, healthSystem: NAME_A }]);
    expect(world.state.sync.refreshes).toStrictEqual([HEALTH_SYSTEM_A]);
  });

  it("takes a part of a name that matches only one", async () => {
    await refresh("example");
    expect(world.state.sync.refreshes).toStrictEqual([HEALTH_SYSTEM_A]);
  });

  it("refuses a name that matches none or several, and reads nothing", async () => {
    const none = await refresh("nowhere");
    // "prov_" is in neither display name, but both share an "e".
    const several = await refresh("e");

    expect(none.error).toBe("invalid_health_system");
    expect(several.error).toBe("invalid_health_system");
    expect(world.state.sync.refreshes).toStrictEqual([]);
  });

  it("cannot reach a health system the owner's policy denies", async () => {
    world.state.rules = buildRules([
      { rule_type: "health_system", target: HEALTH_SYSTEM_B, enabled: 1 },
    ]);
    const answer = await refresh(HEALTH_SYSTEM_B);

    expect(answer.error).toBe("invalid_health_system");
    expect(world.state.sync.refreshes).toStrictEqual([]);
  });

  it("is switched off by a tool rule like any other tool", async () => {
    world.state.rules = buildRules([{ rule_type: "tool", target: TOOL, enabled: 1 }]);
    const answer = await refresh();

    expect(answer.error).toBe("policy_denied");
    expect(world.state.sync.refreshes).toStrictEqual([]);
  });
});

describe("a refresh that runs", () => {
  it("answers what was read, and says to read the messages now", async () => {
    const answer = await refresh();

    expect(answer.isError).toBe(false);
    expect(answer.items).toStrictEqual([
      {
        kind: "message_refresh",
        healthSystem: NAME_A,
        healthSystemId: HEALTH_SYSTEM_A,
        outcome: "refreshed",
        code: "refreshed",
        changed: 1,
        threads: 3,
        messages: 7,
        complete: true,
        refreshesLeft: capacity - 1,
        nextAllowedAt: null,
        capacity,
        refillSeconds,
      },
    ]);
    expect(answer.warnings).toContain("messages_refreshed_read_get_messages_now");
  });

  it("reports a failed read with its code and spends the token", async () => {
    world.state.sync.refreshAnswer = { outcome: "failed", code: "portal_session_expired" };
    const answer = await refresh();

    expect(answer.items[0]).toMatchObject({
      outcome: "failed",
      code: "portal_session_expired",
      changed: null,
      refreshesLeft: capacity - 1,
    });
    expect(answer.warnings).not.toContain("messages_refreshed_read_get_messages_now");
  });

  it("gives the token back when another refresh or a sign-in held the portal", async () => {
    world.state.sync.refreshAnswer = { outcome: "busy", code: "portal_signin_busy" };
    const answer = await refresh();

    expect(answer.items[0]).toMatchObject({
      outcome: "busy",
      code: "portal_signin_busy",
      refreshesLeft: capacity,
    });
  });
});

describe("what it never reads", () => {
  it.each([
    ["portal_not_signed_in", { state: "none" as const }],
    ["portal_needs_reauth", { state: "needs_reauth" as const }],
    ["portal_no_credentials", { hasCredentials: false }],
  ])("skips %s without a token or a read", async (code, change) => {
    patchPortal(HEALTH_SYSTEM_A, change);
    const answer = await refresh();

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code, refreshesLeft: capacity });
    expect(world.state.sync.refreshes).toStrictEqual([]);
  });

  it("skips a health system with no portal account", async () => {
    world.state.healthSystems = world.state.healthSystems.map((healthSystem) =>
      healthSystem.id === HEALTH_SYSTEM_A ? { ...healthSystem, portal: null } : healthSystem,
    );
    const answer = await refresh();

    expect(answer.items[0]).toMatchObject({ outcome: "skipped", code: "portal_not_configured" });
    expect(world.state.sync.refreshes).toStrictEqual([]);
  });
});

describe("the token bucket", () => {
  it("allows a burst of `capacity` refreshes in the same second, then refuses", async () => {
    for (let call = 1; call <= capacity; call += 1) {
      const answer = await refresh();
      expect(answer.items[0]).toMatchObject({
        outcome: "refreshed",
        refreshesLeft: capacity - call,
      });
    }
    const refused = await refresh();

    expect(refused.isError).toBe(false);
    expect(refused.items[0]).toMatchObject({
      outcome: "refused",
      code: "rate_limited",
      refreshesLeft: 0,
      nextAllowedAt: iso(NOW + refillSeconds),
      changed: null,
    });
    expect(world.state.sync.refreshes).toHaveLength(capacity);
  });

  it("earns one refresh back per refill period", async () => {
    for (let call = 0; call < capacity; call += 1) await refresh();

    world.state.now = NOW + refillSeconds - 1;
    const early = await refresh();
    expect(early.items[0]).toMatchObject({
      outcome: "refused",
      nextAllowedAt: iso(NOW + refillSeconds),
    });

    world.state.now = NOW + refillSeconds;
    const earned = await refresh();
    expect(earned.items[0]).toMatchObject({ outcome: "refreshed", refreshesLeft: 0 });
  });

  it("keeps each health system's bucket apart", async () => {
    for (let call = 0; call < capacity; call += 1) await refresh(HEALTH_SYSTEM_A);

    const a = await refresh(HEALTH_SYSTEM_A);
    const b = await refresh(HEALTH_SYSTEM_B);
    expect(a.items[0]).toMatchObject({ outcome: "refused" });
    expect(b.items[0]).toMatchObject({ outcome: "refreshed" });
  });

  it("is far less strict than sync_health_systems' portal kind", async () => {
    // The point of the tool: a back and forth in a few minutes is allowed.
    const times = [0, 5, 20, 45, 90];
    for (const offset of times) {
      world.state.now = NOW + offset;
      const answer = await refresh();
      expect(answer.items[0]).toMatchObject({ outcome: "refreshed" });
    }
  });
});
