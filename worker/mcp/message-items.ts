/**
 * Secure messages as MCP items: one item per message, deduped across health
 * systems, windowed, with honest coverage.
 *
 * The portal pass stores every message each health system's Message Center shows
 * (`portal_messages`), including the copies one portal shows of another
 * organisation's conversations. This module turns those rows into the
 * per-message items both message tools hand the exposure policy; only what the
 * policy releases is then grouped into conversations (`message-threads.ts`).
 *
 * ### One message, one item
 *
 * Exactly the visits' rule (`worker/mcp/appointment-items.ts`), with the message
 * identity of `worker/sync/message-dedupe.ts`: every health system's copies are
 * read, the copies of one message are collapsed to the one that outranks the rest
 * -- the first-party copy, whose own organisation the conversation belongs to --
 * and only then are the caller's health systems picked out. A copy is kept as a
 * fallback, marked `firstParty: false` with `via`, only when no first-party copy
 * is stored anywhere.
 *
 * A denied health system is read too, for matching only: another organisation's
 * portal can show its messages, stored under the showing organisation, and any
 * such copy is dropped (the same rule as appointments, security review M1). A
 * copy it has no stored record of cannot be recognised -- the limit SECURITY.md
 * states for visits applies here as well.
 *
 * ### Policy
 *
 * Items are tagged `resourceType: "Communication"`, so a `resource` rule on
 * Communication removes them and every `Communication.<field>` rule reaches them.
 * The names in an item are addressable as the people they are: the sender's name
 * (`from.name`) and the care team (`practitioners[].name`) are reference fields
 * (`worker/policy/references.ts`), judged by the role of whoever they name --
 * a clinician's name goes wherever the owner's rules withhold clinicians' names,
 * the patient's wherever the patient's name is withheld. The judging uses a
 * synthetic FHIR-shaped `source` per item that names only those roles; it is never
 * returned. There is no raw resource behind a message, so `raw` is not offered.
 */

import { toIso } from "../lib/time.ts";
import { isHealthSystemDenied } from "../policy/rules.ts";
import {
  collapseMessages,
  messageRank,
  sameMessageAcrossHealthSystems,
} from "../sync/message-dedupe.ts";

import { withinWindow } from "./collect.ts";

import type { TaggedItem } from "./collect.ts";
import type { CoverageEntry, CoverageStatus } from "./coverage.ts";
import type {
  HealthSystemInfo,
  PortalMessageRecord,
  PortalMessageSyncEntry,
  ToolDeps,
} from "./deps.ts";
import type { MessageAuthorRole, MessageFolder } from "../ehr/mychart/index.ts";
import type { RawEntry } from "../policy/filter.ts";
import type { PolicyRules } from "../policy/rules.ts";
import type { MessageSighting } from "../sync/message-dedupe.ts";

/** The resource type every message item carries: FHIR's name for a message. */
const MESSAGE_RESOURCE_TYPE = "Communication";

/**
 * How long since a health system's Message Center was last read before its
 * messages are called `stale`. The portal pass runs hourly; six hours is the
 * slack the portal's visits get too.
 */
const MESSAGES_STALE_AFTER_SECONDS = 6 * 60 * 60;

/** Who a message is from, as a FHIR reference type: what the policy judges a name by. */
const SENDER_TYPE: Readonly<Record<MessageAuthorRole, string>> = {
  patient: "Patient",
  proxy: "RelatedPerson",
  practitioner: "Practitioner",
  system: "Organization",
};

export interface MessageFilters {
  /** On the conversation's newest message: a conversation active in the window is kept whole. */
  from?: string | undefined;
  to?: string | undefined;
  threadId?: string | undefined;
  folder?: MessageFolder | undefined;
}

export interface Messages {
  items: TaggedItem[];
  /** For the policy's judging only. Index-aligned with `items`; never returned. */
  sources: RawEntry[];
  healthSystemIds: string[];
}

interface Entry {
  healthSystem: HealthSystemInfo;
  record: PortalMessageRecord;
  sighting: MessageSighting;
}

function directionOf(role: MessageAuthorRole): "from_patient" | "to_patient" {
  return role === "patient" || role === "proxy" ? "from_patient" : "to_patient";
}

/** One stored message as the item the tools answer with. */
function messageItem(healthSystem: HealthSystemInfo, record: PortalMessageRecord): TaggedItem {
  const { thread, message } = record;
  return {
    resourceType: MESSAGE_RESOURCE_TYPE,
    id: record.messageId,
    threadId: record.threadId,
    subject: thread.subject,
    folder: thread.folder,
    sent: message.sent,
    direction: directionOf(message.role),
    from: {
      role: message.role,
      ...(message.author !== undefined && { name: message.author }),
    },
    practitioners: thread.practitioners.map((practitioner) => ({ name: practitioner.name })),
    body: message.body,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    ...(message.unread !== undefined && { unread: message.unread }),
    ...(thread.organization !== undefined && { organization: thread.organization }),
    source: "portal",
    // A copy another organisation's portal showed: which portal it was seen in.
    firstParty: !thread.external,
    ...(thread.external && { via: healthSystem.id }),
    ...(record.missing && { noLongerListed: true }),
    healthSystem: healthSystem.displayName,
    healthSystemId: healthSystem.id,
  };
}

/** What the policy judges the item's names by. Names no one; never returned. */
function messageSource(healthSystem: HealthSystemInfo, record: PortalMessageRecord): RawEntry {
  return {
    healthSystem: healthSystem.displayName,
    healthSystemId: healthSystem.id,
    resource: {
      resourceType: MESSAGE_RESOURCE_TYPE,
      sender: { type: SENDER_TYPE[record.message.role] },
      recipient: record.thread.practitioners.map(() => ({ type: "Practitioner" })),
    },
  };
}

/** True when a filter is unset or the value is the one it asks for. */
function matches<T>(wanted: T | undefined, actual: T): boolean {
  return wanted === undefined || wanted === actual;
}

function keep(record: PortalMessageRecord, filters: MessageFilters): boolean {
  return (
    matches(filters.threadId, record.threadId) && matches(filters.folder, record.thread.folder)
  );
}

/** The conversation a kept message is grouped into (see `message-threads.ts`). */
const conversationOf = (entry: Entry): string =>
  `${entry.healthSystem.id}\u{0}${entry.record.threadId}`;

/**
 * Only the conversations whose newest message falls inside the window, every
 * message of each: a window picks conversations, it does not cut them in half.
 */
function inWindow(entries: readonly Entry[], filters: MessageFilters): Entry[] {
  if (filters.from === undefined && filters.to === undefined) return [...entries];
  const newest = new Map<string, string>();
  for (const entry of entries) {
    const key = conversationOf(entry);
    const seen = newest.get(key);
    if (seen === undefined || entry.record.message.sent > seen) {
      newest.set(key, entry.record.message.sent);
    }
  }
  return entries.filter((entry) =>
    withinWindow(newest.get(conversationOf(entry)), filters.from, filters.to),
  );
}

function compare(a: Entry, b: Entry): number {
  const left = a.record.message.sent;
  const right = b.record.message.sent;
  if (left !== right) return left < right ? -1 : 1;
  return a.record.messageId < b.record.messageId
    ? -1
    : Number(a.record.messageId > b.record.messageId);
}

/**
 * Every message the selected health systems speak for, one item per message.
 *
 * `all` is every health system that has not been deleted, deny-list not applied:
 * each one's copies take part in the dedupe (see the module comment). Only the
 * `selected` ones are answered from.
 */
export async function collectMessages(
  deps: ToolDeps,
  all: readonly HealthSystemInfo[],
  selected: readonly HealthSystemInfo[],
  rules: PolicyRules,
  filters: MessageFilters,
): Promise<Messages> {
  const now = deps.now();
  const syncs = await deps.portalMessageSync();
  const lastRead = new Map(syncs.map((entry) => [entry.healthSystemId, entry.lastOkAt]));
  const entries: Entry[] = [];
  for (const healthSystem of all) {
    const records = await deps.portalMessages(healthSystem.id);
    for (const record of records) {
      entries.push({
        healthSystem,
        record,
        sighting: {
          healthSystemId: healthSystem.id,
          fingerprint: record.fingerprint,
          rank: messageRank(record.thread.external, lastRead.get(healthSystem.id) ?? null, now),
        },
      });
    }
  }

  const denied = entries
    .filter((entry) => isHealthSystemDenied(rules, entry.healthSystem.id))
    .map((entry) => entry.sighting);
  const wanted = new Set(selected.map((healthSystem) => healthSystem.id));
  // The collapse first, over every health system, and the denied ones' copies
  // after it regardless of rank: a denied organisation's own copy may lose on
  // freshness and must still take the allowed copy with it.
  const kept = collapseMessages(entries).filter(
    (entry) =>
      wanted.has(entry.healthSystem.id) &&
      denied.every((sighting) => !sameMessageAcrossHealthSystems(sighting, entry.sighting)) &&
      keep(entry.record, filters),
  );
  const windowed = inWindow(kept, filters);
  windowed.sort(compare);

  return {
    items: windowed.map((entry) => messageItem(entry.healthSystem, entry.record)),
    sources: windowed.map((entry) => messageSource(entry.healthSystem, entry.record)),
    healthSystemIds: selected.map((healthSystem) => healthSystem.id),
  };
}

function coverageStatus(
  sync: PortalMessageSyncEntry | undefined,
  now: number,
): Pick<CoverageEntry, "status" | "errorCode" | "lastOkAt" | "ageHours"> {
  if (sync === undefined) return { status: "never" };
  const lastOkAt = sync.lastOkAt === null ? undefined : toIso(sync.lastOkAt);
  const since = { ...(lastOkAt !== undefined && { lastOkAt }) };
  if (sync.lastErrorCode !== null) {
    const status: CoverageStatus = "failed";
    return { status, errorCode: sync.lastErrorCode, ...since };
  }
  if (!sync.complete) return { status: "partial", ...since };
  const age = sync.lastOkAt === null ? Infinity : now - sync.lastOkAt;
  if (age > MESSAGES_STALE_AFTER_SECONDS) {
    return {
      status: "stale",
      ...(Number.isFinite(age) && { ageHours: Math.floor(age / 3600) }),
      ...since,
    };
  }
  return { status: "ok", ...since };
}

/**
 * Per health system: is the stored Message Center current? From the portal pass's
 * own record of its last read, not a proxy for it. A `Communication` resource rule
 * hides the coverage with the items, and a denied health system never appears.
 */
export async function messageCoverage(
  deps: ToolDeps,
  selected: readonly HealthSystemInfo[],
  rules: PolicyRules,
  now: number,
): Promise<CoverageEntry[]> {
  if (rules.resources.has(MESSAGE_RESOURCE_TYPE)) return [];
  const entries = await deps.portalMessageSync();
  const syncs = new Map(entries.map((entry) => [entry.healthSystemId, entry]));
  return selected
    .filter((healthSystem) => !isHealthSystemDenied(rules, healthSystem.id))
    .map((healthSystem) => ({
      healthSystemId: healthSystem.id,
      healthSystem: healthSystem.displayName,
      resourceType: MESSAGE_RESOURCE_TYPE,
      ...coverageStatus(syncs.get(healthSystem.id), now),
    }));
}
