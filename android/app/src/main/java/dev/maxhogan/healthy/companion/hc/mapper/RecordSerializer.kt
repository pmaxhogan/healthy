package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.Record
import kotlinx.serialization.json.JsonObject

/**
 * Seam between the sync engine and the Record -> JSON mappers.
 *
 * One call turns one Health Connect [Record] into the wire `Record` object the Worker's
 * `POST /ingest/health-connect` accepts: the envelope (`id`, `type`, `origin`, `device`,
 * `recordingMethod`, `lastModified`, client ids, `start`/`end` or `time` in epoch milliseconds
 * with zone offsets in minutes) plus a type-specific `data` object with units normalised.
 *
 * Contract for implementations:
 * - total: every [Record] subclass yields an object, including one a newer library adds; an
 *   implementation never throws and never drops a record;
 * - pure: no I/O and no shared mutable state, so the engine may call it from any dispatcher;
 * - lossless: nested lists (`samples`, `stages`, `segments`, `laps`, `route`, `deltas`) stay
 *   nested and are never truncated.
 *
 * The sync engine depends on this interface only.
 */
interface RecordSerializer {
    fun serialize(record: Record): JsonObject
}
