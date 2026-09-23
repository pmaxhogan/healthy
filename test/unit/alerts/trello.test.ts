import { describe, expect, it, vi } from "vitest";

import { createTrelloAlerts, stripCredentials } from "../../../worker/alerts/trello.ts";
import { makeLogger } from "../../../worker/lib/log.ts";

// Privacy: no real board/list ids or URLs. These are synthetic stand-ins,
// matching the convention documented for this module's tests.
const MUST_LIST_ID = "list_must_test";
const DONE_LIST_ID = "list_done_test";
const RECONNECT_URL = "https://healthy.example.test/reconnect/abc";
const TITLE = "Reconnect Test Health system to Healthy";

interface RecordedCall {
  url: URL;
  method: string;
}

function baseConfig(
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createTrelloAlerts>[0]> = {},
) {
  return {
    key: "k_test_key",
    token: "t_test_token",
    mustListId: MUST_LIST_ID,
    doneListId: DONE_LIST_ID,
    fetchImpl,
    now: () => new Date("2026-09-21T21:34:56.000Z"),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? "" : JSON.stringify(body), { status, headers });
}

function recordingFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  // retriedFetch always calls fetchImpl with a plain string URL (see worker/lib/retry.ts),
  // never a Request or URL object, so the mock only needs to accept a string.
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    const call: RecordedCall = { url: new URL(input), method: init?.method ?? "GET" };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("findOpenCard", () => {
  it("matches an open card by exact, case-insensitive name and only searches the MUST list", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse([
        {
          id: "card_closed",
          name: TITLE.toUpperCase(),
          closed: true,
          dueComplete: false,
          desc: "",
        },
        { id: "card_open", name: TITLE.toUpperCase(), closed: false, dueComplete: false, desc: "" },
      ]),
    );
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const found = await alerts.findOpenCard(TITLE);

    expect(found?.id).toBe("card_open");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe(`/1/lists/${MUST_LIST_ID}/cards`);
    expect(calls[0]?.url.toString()).not.toContain(DONE_LIST_ID);
  });

  it("returns null when no open card matches", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse([]));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    expect(await alerts.findOpenCard(TITLE)).toBeNull();
  });
});

describe("openReconnectCard", () => {
  it("is idempotent: an existing open card is returned as-is, no POST is made", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse([
        { id: "card_existing", name: TITLE, closed: false, dueComplete: false, desc: "" },
      ]),
    );
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const result = await alerts.openReconnectCard({
      title: TITLE,
      description: "desc",
      url: RECONNECT_URL,
    });

    expect(result).toEqual({ cardId: "card_existing", created: false });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates a card with idList, name, desc, pos=top and urlSource when none is open", async () => {
    const { fetchImpl, calls } = recordingFetch((call) =>
      jsonResponse(call.method === "GET" ? [] : { id: "card_new" }),
    );
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const result = await alerts.openReconnectCard({
      title: TITLE,
      description: "The desc",
      url: RECONNECT_URL,
    });

    expect(result).toEqual({ cardId: "card_new", created: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url.pathname).toBe("/1/cards");
    expect(post?.url.searchParams.get("idList")).toBe(MUST_LIST_ID);
    expect(post?.url.searchParams.get("name")).toBe(TITLE);
    expect(post?.url.searchParams.get("desc")).toBe("The desc");
    expect(post?.url.searchParams.get("pos")).toBe("top");
    expect(post?.url.searchParams.get("urlSource")).toBe(RECONNECT_URL);
  });

  it("falls back to a card without urlSource if Trello rejects it as a permanent 4xx", async () => {
    let postCount = 0;
    const { fetchImpl, calls } = recordingFetch((call) => {
      if (call.method === "GET") return jsonResponse([]);
      postCount += 1;
      return postCount === 1
        ? jsonResponse({ message: "invalid urlSource" }, 400)
        : jsonResponse({ id: "card_fallback" });
    });
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const result = await alerts.openReconnectCard({
      title: TITLE,
      description: "desc",
      url: RECONNECT_URL,
    });

    expect(result).toEqual({ cardId: "card_fallback", created: true });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url.searchParams.has("urlSource")).toBe(true);
    expect(posts[1]?.url.searchParams.has("urlSource")).toBe(false);
  });
});

describe("completeCard", () => {
  it("sets dueComplete=true, moves to the DONE list, and returns true", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ id: "card_1", dueComplete: true }),
    );
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const ok = await alerts.completeCard("card_1");

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url.pathname).toBe("/1/cards/card_1");
    expect(calls[0]?.url.searchParams.get("dueComplete")).toBe("true");
    expect(calls[0]?.url.searchParams.get("idList")).toBe(DONE_LIST_ID);
    expect(calls[0]?.url.searchParams.get("pos")).toBe("top");
  });

  it("treats a 404 (card already gone) as false rather than an error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: "not found" }, 404));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    await expect(alerts.completeCard("card_gone")).resolves.toBe(false);
  });
});

describe("createTestCard / archiveCard", () => {
  it("opens a titled, timestamped, archivable test card", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ id: "card_test" }));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const id = await alerts.createTestCard(RECONNECT_URL);

    expect(id).toBe("card_test");
    const post = calls[0];
    expect(post?.url.searchParams.get("name")).toBe("Healthy test card 2026-09-21T21:34");
    expect(post?.url.searchParams.get("desc")).toContain("test");
    expect(post?.url.searchParams.get("desc")).toContain("archived");
    expect(post?.url.searchParams.get("urlSource")).toBe(RECONNECT_URL);
  });

  it("archives a card with closed=true", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(null));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    await alerts.archiveCard("card_test");

    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url.searchParams.get("closed")).toBe("true");
  });
});

describe("error mapping", () => {
  it("maps 401/403 to upstream_auth", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 401));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    await expect(alerts.findOpenCard(TITLE)).rejects.toMatchObject({ code: "upstream_auth" });
  });

  it("maps other 4xx to upstream_error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 422));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    await expect(alerts.findOpenCard(TITLE)).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("retries a 429, waiting at least as long as Retry-After demands, then succeeds", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      attempts += 1;
      // 1s is well above the ~150-250ms the default exponential backoff would
      // pick on its own, so a fast retry here means Retry-After was ignored.
      return attempts === 1 ? jsonResponse({}, 429, { "retry-after": "1" }) : jsonResponse([]);
    });
    const alerts = createTrelloAlerts(baseConfig(fetchImpl));

    const start = Date.now();
    await expect(alerts.findOpenCard(TITLE)).resolves.toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(950);
    expect(calls).toHaveLength(2);
  }, 10_000);

  it("maps exhausted transient retries to upstream_unavailable", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 503));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl, {}));

    await expect(alerts.findOpenCard(TITLE)).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  }, 15_000);
});

describe("credential hygiene", () => {
  it("stripCredentials removes key and token from a URL", () => {
    const dirty = "https://api.trello.com/1/cards?key=SECRET_KEY&token=SECRET_TOKEN&name=x";
    const clean = stripCredentials(dirty);

    expect(clean).not.toContain("SECRET_KEY");
    expect(clean).not.toContain("SECRET_TOKEN");
    expect(clean).toContain("name=x");
  });

  it("never logs or throws the key/token, even on failure", async () => {
    const lines: string[] = [];
    const logger = makeLogger(
      {},
      {
        sink: (_level, line) => {
          lines.push(line);
        },
      },
    );
    const { fetchImpl } = recordingFetch(() => jsonResponse({}, 400));
    const alerts = createTrelloAlerts(baseConfig(fetchImpl, { logger }));

    let thrown: unknown;
    try {
      await alerts.findOpenCard(TITLE);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
    expect(thrownMessage).not.toContain("k_test_key");
    expect(thrownMessage).not.toContain("t_test_token");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("k_test_key");
      expect(line).not.toContain("t_test_token");
    }
  });

  it("never logs the health system name or card body, even when card creation fails", async () => {
    // The health system display name is user data (see this module's header
    // comment): it must not reach a log line just because it is part of the
    // POST /cards query string.
    const lines: string[] = [];
    const logger = makeLogger(
      {},
      {
        sink: (_level, line) => {
          lines.push(line);
        },
      },
    );
    const { fetchImpl } = recordingFetch((call) =>
      call.method === "GET" ? jsonResponse([]) : jsonResponse({ message: "nope" }, 400),
    );
    const alerts = createTrelloAlerts(baseConfig(fetchImpl, { logger }));

    await expect(
      alerts.openReconnectCard({
        title: TITLE,
        description: "Reconnect Some Health system desc",
        url: RECONNECT_URL,
      }),
    ).rejects.toMatchObject({ code: "upstream_error" });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TITLE);
      expect(line).not.toContain("Reconnect Some Health system desc");
      expect(line).not.toContain(RECONNECT_URL);
    }
  });
});
