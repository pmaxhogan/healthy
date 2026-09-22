// `/api/alerts` -- the reconnect alert history and the Trello test card.
//
// Trello is stubbed through the injected fetch, so what is exercised is the real
// client in worker/alerts/trello.ts (its URL building, its credentials-as-query-
// params convention, its `urlSource` fallback) against a fake server.
//
// The credentials assertion is the one worth keeping: Trello puts `key` and `token`
// in the query string of every request, so those two values are one careless log line
// away from being in a response body.

import { afterEach, describe, expect, it } from "vitest";

import { AppError } from "../../../worker/lib/errors.ts";

import { freshOwner, json, resetPorts, stubFetch, testRepos, usePorts } from "./helpers.ts";

import type { AlertDto, ApiError } from "@shared/types.ts";

const owner = freshOwner();

afterEach(() => {
  resetPorts();
});

describe("GET /api/alerts", () => {
  it("starts empty", async () => {
    expect(await json<AlertDto[]>(await owner().get("/api/alerts"))).toStrictEqual([]);
  });

  it("lists open and resolved alerts, newest first", async () => {
    const repos = testRepos();
    const opened = await repos.alerts.openOrGet("google");
    await repos.alerts.setCard(opened.alert.id, "card-1");
    await repos.alerts.resolve("google");
    await repos.alerts.openOrGet("provider:PROV1");

    const alerts = await json<AlertDto[]>(await owner().get("/api/alerts"));

    expect(alerts).toHaveLength(2);
    const google = alerts.find((alert) => alert.subject === "google");
    expect(google?.trelloCardId).toBe("card-1");
    expect(google?.resolvedAt).not.toBeNull();
    expect(google?.providerId).toBeNull();
    const provider = alerts.find((alert) => alert.subject === "provider:PROV1");
    expect(provider?.providerId).toBe("PROV1");
    expect(provider?.resolvedAt).toBeNull();
  });

  it("honours ?limit=", async () => {
    const repos = testRepos();
    for (const subject of ["a", "b", "c"]) await repos.alerts.openOrGet(subject);

    expect(await json<AlertDto[]>(await owner().get("/api/alerts?limit=2"))).toHaveLength(2);
  });
});

describe("POST /api/alerts/test", () => {
  it("creates a card and answers with its id", async () => {
    const stub = stubFetch([
      { match: "api.trello.com/1/cards", method: "POST", body: { id: "card-99" } },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("POST", "/api/alerts/test");

    expect(response.status).toBe(201);
    expect(await json<{ cardId: string }>(response)).toStrictEqual({ cardId: "card-99" });
    expect(stub.requests).toHaveLength(1);
    // The card goes on the MUST list, with the app's own link.
    const url = stub.requests[0]?.url ?? "";
    expect(url).toContain("idList=must-list");
    expect(url).toContain("urlSource=");
  });

  it("writes no alerts row, so the dashboard's open-alert count stays honest", async () => {
    const stub = stubFetch([
      { match: "api.trello.com/1/cards", method: "POST", body: { id: "card-99" } },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    await owner().send("POST", "/api/alerts/test");

    expect(await json<AlertDto[]>(await owner().get("/api/alerts"))).toStrictEqual([]);
  });

  it("never puts the Trello credentials in the response", async () => {
    const stub = stubFetch([
      { match: "api.trello.com/1/cards", method: "POST", body: { id: "card-99" } },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("POST", "/api/alerts/test");
    const body = await response.text();

    expect(body).not.toContain("test-trello-key");
    expect(body).not.toContain("test-trello-token");
    // They really were sent, so the assertion above is testing something.
    expect(stub.requests[0]?.url).toContain("test-trello-token");
  });

  it("reports a Trello rejection as an upstream failure, code only", async () => {
    const stub = stubFetch([
      { match: "api.trello.com", method: "POST", status: 401, body: { message: "invalid key" } },
    ]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("POST", "/api/alerts/test");
    const body = await json<ApiError>(response);

    expect(response.status).toBe(502);
    expect(body.error).toBe("upstream_auth");
    expect(body.message).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("invalid key");
  });

  it("reports a deployment with no Trello secrets as not_connected, not as a crash", async () => {
    // A legitimate state: alerting is simply off. 409 tells the UI to show "Trello
    // is not configured" rather than "something went wrong".
    usePorts({
      trello: () => {
        throw new AppError("not_connected", "Trello alerting is not configured");
      },
    });

    const response = await owner().send("POST", "/api/alerts/test");
    const body = await json<ApiError>(response);

    expect(response.status).toBe(409);
    expect(body.error).toBe("not_connected");
  });
});

describe("DELETE /api/alerts/test/:cardId", () => {
  it("archives the card", async () => {
    const stub = stubFetch([{ match: "api.trello.com/1/cards/card-99", method: "PUT", body: {} }]);
    usePorts({ fetch: stub.fetchImpl });

    const response = await owner().send("DELETE", "/api/alerts/test/card-99");

    expect(response.status).toBe(200);
    expect(stub.requests[0]?.url).toContain("closed=true");
  });
});
