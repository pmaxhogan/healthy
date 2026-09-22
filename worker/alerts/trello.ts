/**
 * Trello REST client for the reconnect-alert flow.
 *
 * Pure module: no D1, no Env. Every dependency (credentials, list ids, fetch,
 * logger, clock) is injected via `createTrelloAlerts(cfg)`, so this file is
 * unit-testable without a Worker runtime and callers own where the config
 * comes from (Worker secrets, in production).
 *
 * Auth is Trello's REST convention: `key` and `token` as query params on
 * every request (see ../../trello-mcp/src/trello-client.ts). Those two values
 * -- and every other query param, since card creation puts the (user-data)
 * provider display name and description there too -- must never reach a log
 * line or an error message. `stripCredentials` is exported and tested for
 * callers that need to log a full URL, but this module's own logging never
 * does: it logs only the method and path, never the query string, and every
 * thrown message below is a fixed string that never interpolates the request
 * URL or its params.
 *
 * Transport goes through `retriedFetch` (worker/lib/retry.ts), which already
 * classifies 429/5xx as transient (backoff honoring Retry-After) and returns
 * 401/403 to the caller instead of retrying. This module turns that outcome
 * into the shared `AppError` taxonomy: 401/403 -> "upstream_auth", other 4xx
 * -> "upstream_error", retry exhaustion -> "upstream_unavailable".
 */

import { AppError, isAppError } from "../lib/errors.ts";
import { noopLogger } from "../lib/log.ts";
import { PermanentError, retriedFetch, TransientError } from "../lib/retry.ts";

import type { Logger } from "../lib/log.ts";

const API_BASE = "https://api.trello.com/1";

export interface TrelloAlertsConfig {
  key: string;
  token: string;
  mustListId: string;
  doneListId: string;
  /** Injected fetch. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to a logger that drops everything. */
  logger?: Logger;
  /** Injected clock, used for the test-card title. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface TrelloCard {
  id: string;
  name: string;
  closed: boolean;
  dueComplete: boolean;
  desc: string;
}

export interface OpenReconnectCardInput {
  title: string;
  description: string;
  url: string;
}

export interface OpenReconnectCardResult {
  cardId: string;
  created: boolean;
}

export interface TrelloAlerts {
  findOpenCard(title: string): Promise<TrelloCard | null>;
  openReconnectCard(input: OpenReconnectCardInput): Promise<OpenReconnectCardResult>;
  /** Resolves false if the card was already gone (404 treated as success). */
  completeCard(cardId: string): Promise<boolean>;
  /** Opens a disposable test card and returns its id. */
  createTestCard(url: string): Promise<string>;
  archiveCard(cardId: string): Promise<void>;
}

const CARD_FIELDS = "id,name,closed,dueComplete,desc";

/** Strips `key`/`token` query params from a URL before it is ever logged. */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("key");
    parsed.searchParams.delete("token");
    return parsed.href;
  } catch {
    return "[unparseable-url]";
  }
}

function isTrelloCard(value: unknown): value is TrelloCard {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.closed === "boolean" &&
    typeof record.dueComplete === "boolean" &&
    typeof record.desc === "string"
  );
}

function isCardWithId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string"
  );
}

function extractId(raw: unknown): string {
  if (isCardWithId(raw)) return raw.id;
  throw new AppError("upstream_error", "Trello response did not include a card id");
}

export function createTrelloAlerts(cfg: TrelloAlertsConfig): TrelloAlerts {
  const logger = cfg.logger ?? noopLogger;
  const clock = cfg.now ?? ((): Date => new Date());
  const fetchImpl = cfg.fetchImpl ?? fetch;

  function buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${API_BASE}${path}`);
    url.searchParams.set("key", cfg.key);
    url.searchParams.set("token", cfg.token);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url.href;
  }

  /** Sends one Trello request and maps the outcome onto the shared AppError taxonomy. */
  async function request(
    method: "GET" | "POST" | "PUT",
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    const url = buildUrl(path, params);

    let response: Response;
    try {
      ({ value: response } = await retriedFetch(
        url,
        { method },
        { fetchImpl, now: () => clock().getTime() },
      ));
    } catch (error) {
      if (error instanceof PermanentError) {
        // Never log `params` or the URL here: for POST /cards they carry the
        // (user-data) provider name and card description. `method`/`path`
        // alone are enough to diagnose which call failed.
        logger.warn("alerts.trello.upstream_error", { method, path, status: error.status });
        throw new AppError(
          "upstream_error",
          "Trello request failed",
          error.status === undefined ? undefined : { status: error.status },
          { cause: error },
        );
      }
      if (error instanceof TransientError) {
        logger.warn("alerts.trello.upstream_unavailable", { method, path });
        throw new AppError(
          "upstream_unavailable",
          "Trello request failed after retries",
          undefined,
          { cause: error },
        );
      }
      throw error;
    }

    if (response.status === 401 || response.status === 403) {
      logger.warn("alerts.trello.upstream_auth", { method, path, status: response.status });
      throw new AppError("upstream_auth", "Trello rejected the request credentials");
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async function findOpenCard(title: string): Promise<TrelloCard | null> {
    const raw = await request("GET", `/lists/${cfg.mustListId}/cards`, { fields: CARD_FIELDS });
    if (!Array.isArray(raw))
      throw new AppError("upstream_error", "Trello returned an unexpected cards payload");
    const wanted = title.toLowerCase();
    const match = raw.find(
      (item): item is TrelloCard =>
        isTrelloCard(item) && !item.closed && item.name.toLowerCase() === wanted,
    );
    return match ?? null;
  }

  /** POST /cards, retrying once without `urlSource` if Trello rejects it as a permanent 4xx. */
  async function createCard(params: Record<string, string>, urlSource: string): Promise<string> {
    let raw: unknown;
    try {
      raw = await request("POST", "/cards", { ...params, urlSource });
    } catch (error) {
      // Only retry when Trello itself returned a 4xx (details.status is set
      // by `request` for a PermanentError) -- never for a malformed response
      // from a POST that already went through, which would create a duplicate.
      if (
        isAppError(error) &&
        error.code === "upstream_error" &&
        error.details?.status !== undefined
      ) {
        raw = await request("POST", "/cards", params);
      } else {
        throw error;
      }
    }
    return extractId(raw);
  }

  async function openReconnectCard(
    input: OpenReconnectCardInput,
  ): Promise<OpenReconnectCardResult> {
    const existing = await findOpenCard(input.title);
    if (existing) return { cardId: existing.id, created: false };

    const cardId = await createCard(
      { idList: cfg.mustListId, name: input.title, desc: input.description, pos: "top" },
      input.url,
    );
    return { cardId, created: true };
  }

  async function completeCard(cardId: string): Promise<boolean> {
    try {
      await request("PUT", `/cards/${cardId}`, {
        dueComplete: "true",
        idList: cfg.doneListId,
        pos: "top",
      });
      return true;
    } catch (error) {
      if (isAppError(error) && error.code === "upstream_error" && error.details?.status === 404)
        return false;
      throw error;
    }
  }

  async function createTestCard(url: string): Promise<string> {
    const isoMinute = clock().toISOString().slice(0, 16);
    const title = `Healthy test card ${isoMinute}`;
    // The link is also in `desc` (not just `urlSource`), so it survives the
    // urlSource-rejected fallback path in createCard.
    const desc = `This is a test card sent by Healthy to confirm Trello alerts are working. It can be archived.\n\n${url}`;
    return createCard({ idList: cfg.mustListId, name: title, desc, pos: "top" }, url);
  }

  async function archiveCard(cardId: string): Promise<void> {
    await request("PUT", `/cards/${cardId}`, { closed: "true" });
  }

  return { findOpenCard, openReconnectCard, completeCard, createTestCard, archiveCard };
}
