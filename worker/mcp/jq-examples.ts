/**
 * Worked `jq` examples, per tool, for each tool's `jq` argument description.
 *
 * One generic example on every tool taught a model nothing about the fields
 * that tool actually returns, so each tool names its own: real field names off
 * that tool's items (`worker/fhir/normalize/types.ts`, the projections in
 * `worker/mcp/**`), doing the things a caller most often wants of that tool.
 *
 * `satisfies Record<ToolName, ...>` makes a new tool without examples a compile
 * error, and `test/unit/mcp/jq-examples.test.ts` runs every program here through
 * the real jq engine against the real tools over synthetic data, so an example
 * that stops compiling, or names a field an item no longer has, fails the build.
 *
 * Nothing here may name a real health system, practitioner or value from a
 * record: the strings are published in every client's tool list.
 */

import type { ToolName } from "./tool-names.ts";

export const JQ_EXAMPLES = {
  get_health_summary: [
    '.[] | select(.kind == "count") | {healthSystem, resourceType, count}',
    '.[] | select(.kind == "recent" and .section == "labs") | {code, value, effective}',
  ],
  list_health_systems: [
    ".[] | {healthSystem, healthSystemId, status, lastSyncAt}",
    '.[] | select(.status != "connected" or .needsReauthSince != null)',
  ],
  get_sync_status: [
    '.[] | select(.kind == "resource_sync" and .status != "ok" and .status != "unsupported") | {healthSystem, resourceType, status, lastError}',
    '.[] | select(.kind == "resource_sync") | select(any(.warnings[]; .severity != "info")) | {healthSystem, resourceType, warnings: [.warnings[] | select(.severity != "info")]}',
    String.raw`map(select(.kind == "resource_sync")) | group_by(.healthSystemId)[] | {healthSystem: .[0].healthSystem, notOk: [.[] | select(.status != "ok") | "\(.resourceType): \(.status)"]}`,
  ],
  get_patient_profile: [".[] | {healthSystem, name, gender, address}"],
  get_appointments: [
    ".[] | {start, visitType, practitioner, department, telehealth, source}",
    '.[] | select(.start < "2026-12-01") | {start, practitioner, location: .location.name}',
  ],
  get_encounters: [
    ".[] | {start, visitType, status, department, practitioners: [.practitioners[].name]}",
    '.[] | select(.visitType | test("physical"; "i")) | {start, department}',
  ],
  get_conditions: [
    '.[] | select(.clinicalStatus == "active") | {code: .code.text, recorded, category}',
    '.[] | select(.code.text | test("allerg"; "i")) | {code: .code.text, onset, clinicalStatus}',
  ],
  get_medications: [
    '.[] | select(.status == "active") | {medication, dosageText, authoredOn, requester}',
    '.[] | select(.medication | test("amoxicillin"; "i")) | {authoredOn, status}',
  ],
  get_medication_fills: [
    ".[] | {medication, whenHandedOver, quantity, daysSupply}",
    "group_by(.medication)[] | {medication: .[0].medication, fills: length, lastFill: (map(.whenHandedOver) | max)}",
  ],
  get_allergies: [
    ".[] | {substance, criticality, clinicalStatus, reactions: [.reactions[].manifestation[]]}",
    '.[] | select(.criticality == "high") | .substance',
  ],
  get_immunizations: [
    ".[] | {vaccine, occurrence, status}",
    '.[] | select(.vaccine | test("influenza"; "i")) | .occurrence',
  ],
  get_lab_results: [
    '.[] | select(.effective >= "2026-01-01") | {code, value, referenceRange, interpretation, effective}',
    "group_by(.code)[] | max_by(.effective) | {code, value, effective}",
  ],
  get_vitals: [
    '.[] | select(.code | test("weight"; "i")) | {effective, value}',
    '.[] | select(.code | test("blood pressure"; "i")) | {effective, components}',
  ],
  get_social_history: [".[] | {code, value, effective}"],
  get_procedures: [
    ".[] | {code, performed, status, performers: [.performers[].name], reasons}",
    '.[] | select(.performed >= "2025-01-01") | .code',
  ],
  get_diagnostic_reports: [
    ".[] | {code, category, effective, conclusion}",
    ".[] | select(.conclusion != null) | {code, effective, conclusion}",
  ],
  get_documents: [
    '.[] | select(.date >= "2026-01-01") | {id, type, date}',
    '.[] | select(.type | test("progress"; "i")) | {id, date, author}',
  ],
  get_document_text: [".[] | {id, chars}", '.[] | .text | test("follow"; "i")'],
  get_messages: [
    ".[] | {sent, subject, direction, from: .from.role, threadId}",
    '.[] | select(.body | test("refill"; "i")) | {sent, subject, body}',
  ],
  get_message_thread: [".[] | {sent, from: .from.role, body}"],
  get_care_team: [".[] | {name, status, participants}", ".[] | .participants[] | {name, role}"],
  get_care_plans: ['.[] | select(.status == "active") | {title, period, activities}'],
  get_goals: [".[] | {description, lifecycleStatus, achievementStatus, targets, startDate}"],
  get_devices: [".[] | {type, manufacturer, model, udi, status}"],
  get_coverage: [".[] | {payor, type, status}"],
  get_service_requests: [
    ".[] | {code, status, occurrence, requester, reasons}",
    '.[] | select(.status == "active") | {code, occurrence}',
  ],
} as const satisfies Record<ToolName, readonly string[]>;
