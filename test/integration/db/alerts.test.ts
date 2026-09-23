import { beforeEach, describe, expect, it } from "vitest";

import { GOOGLE_SUBJECT, healthSystemSubject } from "../../../worker/db/repos/alerts.ts";

import { T0, clock, resetDb, seedHealthSystem, testRepos } from "./helpers.ts";

beforeEach(resetDb);

describe("alerts.openOrGet", () => {
  it("opens one alert and says it created it", async () => {
    const repos = testRepos();
    const healthSystemId = await seedHealthSystem(repos);

    const { alert, created } = await repos.alerts.openOrGet(healthSystemSubject(healthSystemId));

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

    const first = await repos.alerts.openOrGet(subject);
    const second = await repos.alerts.openOrGet(subject);

    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
    expect(await repos.alerts.listOpen()).toHaveLength(1);
  });

  it("lets exactly one of two concurrent callers create the alert", async () => {
    const repos = testRepos();
    const subject = healthSystemSubject(await seedHealthSystem(repos));

    const results = await Promise.all([
      repos.alerts.openOrGet(subject),
      repos.alerts.openOrGet(subject),
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

    await repos.alerts.openOrGet(first);
    await repos.alerts.openOrGet(second);
    await repos.alerts.openOrGet(GOOGLE_SUBJECT);

    expect(await repos.alerts.listOpen()).toHaveLength(3);
  });
});

describe("alerts.resolve", () => {
  it("closes the open alert and hands it back so its card can be completed", async () => {
    const time = clock();
    const repos = testRepos({ now: time.now });
    const subject = healthSystemSubject(await seedHealthSystem(repos));
    const { alert } = await repos.alerts.openOrGet(subject);
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
    const { alert: first } = await repos.alerts.openOrGet(subject);
    await repos.alerts.resolve(subject);

    const { alert: second, created } = await repos.alerts.openOrGet(subject);

    expect(created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await repos.alerts.listRecent()).toHaveLength(2);
  });

  it("reports nothing changed when setting a card on an alert that is gone", async () => {
    const repos = testRepos();

    expect(await repos.alerts.setCard("NOPE", "trello-card-1")).toBe(false);
  });
});
