import { beforeEach, describe, expect, it } from "vitest";

import { GOOGLE_SUBJECT, healthSystemSubject } from "../../../src/db/repos/alerts.ts";

import { T0, clock, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("alerts.openOrGet", () => {
  it("opens one alert and says it created it", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const { alert, created } = await repos.alerts.openOrGet(
      healthSystemSubject(healthSystemId),
      "reconnect",
    );

    expect(created).toBe(true);
    expect(alert.kind).toBe("reconnect");
    expect(alert.subject).toBe(`health_system:${healthSystemId}`);
    expect(alert.opened_at).toBe(T0);
    expect(alert.resolved_at).toBeNull();
  });

  it("returns the same alert without creating a second one", async () => {
    // This is what stops the hourly sync opening a Trello card every hour for as
    // long as a connection stays broken.
    const repos = testRepos();
    const subject = healthSystemSubject(await seedHealthSystem(repos));

    const first = await repos.alerts.openOrGet(subject, "reconnect");
    const second = await repos.alerts.openOrGet(subject, "reconnect");

    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
    expect(await repos.alerts.listOpen()).toHaveLength(1);
  });

  it("lets exactly one of two concurrent callers create the alert", async () => {
    const repos = testRepos();
    const subject = healthSystemSubject(await seedHealthSystem(repos));

    const results = await Promise.all([
      repos.alerts.openOrGet(subject, "reconnect"),
      repos.alerts.openOrGet(subject, "reconnect"),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.alert.id)).size).toBe(1);
  });

  it("keeps separate alerts for separate subjects", async () => {
    const repos = testRepos();
    const first = healthSystemSubject(
      await seedHealthSystem(repos, { displayName: "A Example Health" }),
    );
    const second = healthSystemSubject(
      await seedHealthSystem(repos, { displayName: "B Example Health" }),
    );

    await repos.alerts.openOrGet(first, "reconnect");
    await repos.alerts.openOrGet(second, "reconnect");
    await repos.alerts.openOrGet(GOOGLE_SUBJECT, "reconnect");

    expect(await repos.alerts.listOpen()).toHaveLength(3);
  });
});

describe("alerts.resolve", () => {
  it("closes the open alert and hands it back so its card can be completed", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const subject = healthSystemSubject(await seedHealthSystem(repos));
    const { alert } = await repos.alerts.openOrGet(subject, "reconnect");
    await repos.alerts.setCard(alert.id, "trello-card-1");

    time.advance(3600);
    const resolved = await repos.alerts.resolve(subject);

    expect(resolved?.id).toBe(alert.id);
    expect(resolved?.trello_card_id).toBe("trello-card-1");
    expect(resolved?.resolved_at).toBe(T0 + 3600);
    expect(await repos.alerts.listOpen()).toStrictEqual([]);
    expect(await repos.alerts.getOpen(subject)).toBeNull();
  });

  it("returns null when there is nothing open", async () => {
    const repos = testRepos();

    expect(await repos.alerts.resolve(GOOGLE_SUBJECT)).toBeNull();
  });

  it("lets a new alert open for the same subject afterwards", async () => {
    // The unique index is partial -- on unresolved rows only -- which is exactly
    // what makes a second cycle possible while still deduping within one.
    const repos = testRepos();
    const subject = healthSystemSubject(await seedHealthSystem(repos));
    const { alert: first } = await repos.alerts.openOrGet(subject, "reconnect");
    await repos.alerts.resolve(subject);

    const { alert: second, created } = await repos.alerts.openOrGet(subject, "reconnect");

    expect(created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await repos.alerts.listRecent()).toHaveLength(2);
  });

  it("reports nothing changed when setting a card on an alert that is gone", async () => {
    const repos = testRepos();

    expect(await repos.alerts.setCard("NOPE", "trello-card-1")).toBe(false);
  });
});

describe("alerts.openOrGet, kinds and reasons", () => {
  it("records the kind and the code a new alert was opened with", async () => {
    const repos = testRepos();

    const { alert } = await repos.alerts.openOrGet(GOOGLE_SUBJECT, "sync_failing", "upstream_auth");

    expect(alert.kind).toBe("sync_failing");
    expect(alert.reason_code).toBe("upstream_auth");
  });

  it("leaves the reason null when none is given", async () => {
    const repos = testRepos();

    const { alert } = await repos.alerts.openOrGet(GOOGLE_SUBJECT, "reconnect");

    expect(alert.reason_code).toBeNull();
  });

  it("hands back the alert that is already open, whatever kind was asked for", async () => {
    // One open alert per subject: the caller reads `kind` to see which it got.
    const repos = testRepos();
    const first = await repos.alerts.openOrGet(GOOGLE_SUBJECT, "reconnect", "needs_reauth");

    const second = await repos.alerts.openOrGet(GOOGLE_SUBJECT, "sync_failing", "upstream_error");

    expect(second.created).toBe(false);
    expect(second.alert).toMatchObject({
      id: first.alert.id,
      kind: "reconnect",
      reason_code: "needs_reauth",
    });
  });
});

describe("syncFailures", () => {
  it("starts a streak at one and remembers when it began", async () => {
    const repos = testRepos();

    const row = await repos.syncFailures.fail("google", "calendar", "upstream_error");

    expect(row).toStrictEqual({
      subject: "google",
      check_name: "calendar",
      failures: 1,
      first_failed_at: T0,
      last_failed_at: T0,
      last_error_code: "upstream_error",
    });
  });

  it("counts each further failure, keeping the start and taking the newest code", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    await repos.syncFailures.fail("google", "calendar", "upstream_error");

    time.advance(3600);
    await repos.syncFailures.fail("google", "calendar", "upstream_error");
    time.advance(3600);
    const row = await repos.syncFailures.fail("google", "calendar", "upstream_unavailable");

    expect(row).toMatchObject({
      failures: 3,
      first_failed_at: T0,
      last_failed_at: T0 + 7200,
      last_error_code: "upstream_unavailable",
    });
  });

  it("counts both of two failures that land at once", async () => {
    const repos = testRepos();

    await Promise.all([
      repos.syncFailures.fail("google", "calendar", "upstream_error"),
      repos.syncFailures.fail("google", "calendar", "upstream_error"),
    ]);

    expect(await repos.syncFailures.listForSubject("google")).toMatchObject([{ failures: 2 }]);
  });

  it("keeps one streak per pass of a subject", async () => {
    const repos = testRepos();
    const subject = healthSystemSubject(await seedHealthSystem(repos));
    await repos.syncFailures.fail(subject, "refresh", "upstream_auth");
    await repos.syncFailures.fail(subject, "calendar", "upstream_error");
    await repos.syncFailures.fail(subject, "calendar", "upstream_error");

    const rows = await repos.syncFailures.listForSubject(subject);

    expect(rows.map((row) => [row.check_name, row.failures])).toStrictEqual([
      ["calendar", 2],
      ["refresh", 1],
    ]);
  });

  it("ends a streak on success, and says whether there was one", async () => {
    const repos = testRepos();
    await repos.syncFailures.fail("google", "calendar", "upstream_error");

    expect(await repos.syncFailures.clear("google", "calendar")).toBe(true);
    expect(await repos.syncFailures.clear("google", "calendar")).toBe(false);
    expect(await repos.syncFailures.listForSubject("google")).toStrictEqual([]);

    // A streak after a success starts from one again.
    const again = await repos.syncFailures.fail("google", "calendar", "upstream_error");
    expect(again.failures).toBe(1);
  });

  it("forgets every streak of a subject, and only that subject's", async () => {
    const repos = testRepos();
    await repos.syncFailures.fail("portal:P1", "visits", "portal_parse_failed");
    await repos.syncFailures.fail("portal:P1", "messages", "portal_unreachable");
    await repos.syncFailures.fail("google", "calendar", "upstream_error");

    expect(await repos.syncFailures.clearSubject("portal:P1")).toBe(2);

    expect(await repos.syncFailures.listForSubject("portal:P1")).toStrictEqual([]);
    expect(await repos.syncFailures.listForSubject("google")).toHaveLength(1);
  });

  it("refuses a pass the schema does not know", async () => {
    const repos = testRepos();

    await expect(
      repos.syncFailures.fail("google", "everything" as "calendar", "upstream_error"),
    ).rejects.toThrow();
  });
});
