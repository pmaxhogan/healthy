/**
The server instructions a client receives on `initialize`.

Shared by the Durable Object server (`server.ts`) and the admin console's
in-process one (`admin-call.ts`), so the two cannot describe the surface
differently. Short on purpose: a client typically puts this into the model's
context on every turn, and each tool's own description carries the detail.
*/
export const MCP_INSTRUCTIONS =
  "A copy of one person's health record, cached from their health systems. " +
  "Every tool reads that cache and changes nothing, except sync_health_systems, " +
  "which asks the server to refresh it. The cache is already refreshed on a " +
  "schedule, so do not call sync_health_systems before a read as a matter of " +
  "course or in a loop: call it only when the person asks for a refresh or " +
  "`coverage` shows that what they need is stale or failed, and read its " +
  "description first. Start with get_health_summary. For 'what conditions do I have', " +
  'use get_conditions with category ["problem-list-item"] or collapse: true. ' +
  "Patient-portal secure messages (inbox conversations with a care team, and " +
  "the letters and notices the portal sends) come from get_messages, one item " +
  "per conversation with a short preview of its newest message (search the " +
  "full text with its `search` argument); get_message_thread returns one " +
  "conversation with every message in full, and get_message_attachment one " +
  "attached file (text, or an image). get_documents holds clinical documents such as visit " +
  "notes, not messages. " +
  "A paired phone's Health Connect data (steps, heart rate, sleep, workouts, " +
  "blood pressure, weight) is a separate source with its own tools: start " +
  "with hc_coverage, then daily_summary, hc_aggregate, hr_series, hr_events, " +
  "sleep_sessions, exercise_sessions, blood_pressure, data_quality or " +
  "hc_records. hc_coverage lists the record types the phone has data for; a " +
  "type that is not listed has no data, which is normal and not a fault. " +
  "Their rows are tagged `device:<id>` and `hc:<Type>`, their " +
  "answers stop at a soft byte budget (`truncated` plus a `cursor`; raise " +
  "`max_bytes` or project with `jq`), and get_vitals does not include them. " +
  "Phone data is only as current as the phone's last upload (about every " +
  "fifteen minutes): each of these answers carries `freshness`, per phone, " +
  "with `lastUploadAt`, `hoursSinceUpload` and `dataThrough` (the end of the " +
  "newest stored record of each `hc:<Type>` it covers), and warns " +
  "`hc_upload_stale:device:<id>:<hours>h` once the last upload is more than " +
  "an hour old. Read that warning before treating a quiet stretch at the end " +
  "of a range as rest, a missing night or a low day: it may simply not have " +
  "arrived yet, and say so. In a `start`/`end` range an `end` written as a " +
  "calendar date includes that whole local day, while an `end` written as an " +
  "instant is exclusive. " +
  "Every tool that reads a resource " +
  "type returns { items, total, matched, coverage, warnings, truncated, " +
  "generatedAt } and accepts an optional `jq` argument: a real jq program run " +
  "server-side on `items` (after the owner's exposure policy, before `limit`), " +
  "so you can filter and project a large result instead of reading all of it. " +
  "The filter runs on the items array; every value it emits becomes one " +
  "element of items -- so write " +
  '`.[] | select(.effective >= "2026-01-01") | {code, value}`, not that ' +
  "wrapped in `[...]` (which would emit one output, itself an array, giving " +
  "you a one-element items). A program that starts `.[] |` also works on a " +
  "result of any size (it is run over the items a piece at a time); one that " +
  "needs the whole array (`length`, `sort_by`, `[.[] | ...]`) fails " +
  "`jq_out_of_memory` on a result past a few megabytes, so project with " +
  "`.[] | ...` first. ISO dates compare correctly as strings. A jq " +
  "error comes back as a tool error carrying jq's message; a `jq_result_empty` " +
  "warning means your filter matched nothing in a non-empty input, so check it " +
  "before concluding there is no data. `coverage` says, per health system and " +
  "resource type, whether the cache is `ok`, `partial` (one part of the search " +
  "was rejected), `stale`, `failed`, `unsupported` (the health system does not " +
  "offer that type -- not a problem), or `never` synced yet; its `notices` " +
  "explain any code the health system returned that is more than " +
  "informational (get_sync_status lists every code, each with a meaning and " +
  "a severity). Any pair that is " +
  "not ok or unsupported also gets a plain-text `warnings` entry -- " +
  "`sync_failed:<type>:<healthSystemId>:<errorCode>`, " +
  "`never_synced:<type>:<healthSystemId>`, `stale:<type>:<healthSystemId>:<age>h` " +
  "or `partial:<type>:<healthSystemId>` -- whether or not `items` is empty, so " +
  "a gap in one health system cannot hide behind another health system's data. " +
  "Check `coverage` and `warnings` -- especially `incomplete_no_data_is_not_absence` " +
  "on an empty `items` -- before concluding something does not exist: it may " +
  "mean the last refresh failed or has not run.";
