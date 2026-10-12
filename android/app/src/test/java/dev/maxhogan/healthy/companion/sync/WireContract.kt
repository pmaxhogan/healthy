package dev.maxhogan.healthy.companion.sync

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The server's batch validation (`worker/src/hc/wire.ts` and the limits in the ingest route),
 * restated in Kotlin so the phone's tests can ask "would the server take this?" without a
 * server. It is a mirror, kept deliberately literal: when the TypeScript changes, this changes
 * with it, and the fixture file the two sides share is what proves they still agree.
 */
object WireContract {
    private val TYPE = Regex("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
    private val BATCH_ID = Regex("^[A-Za-z0-9_-]{8,64}$")

    /** What started a sync run, and how one ended: checked for their shape, not against a list. */
    private val RUN_TRIGGER = Regex("^[a-z][a-z0-9_]{0,23}$")
    private val RUN_END = Regex("^[a-z][a-z0-9_]{0,39}$")
    private const val MAX_ID = 200
    private const val MAX_ORIGIN = 255

    /** Device manufacturer and model, and a writer's own record id: other apps' free text. */
    private const val MAX_DEVICE_TEXT = 1024

    /** The latest instant the server accepts anywhere (the first instant of the year 2200). */
    const val MAX_INSTANT = 7_258_118_400_000L
    const val MAX_ITEMS = 25_000
    const val MAX_TYPES = 500

    /** Why the server would reject this record, or null when it would take it. */
    fun recordProblem(record: JsonObject): String? {
        string(record["id"], 1, MAX_ID) ?: return "id"
        if (string(record["type"])?.let(TYPE::matches) != true) return "type"
        string(record["origin"], 1, MAX_ORIGIN) ?: return "origin"
        record["device"]?.let { device ->
            if (device !is JsonObject) return "device"
            if (!optionalString(device["type"], 64)) return "device.type"
            if (!optionalString(device["manufacturer"], MAX_DEVICE_TEXT)) return "device.manufacturer"
            if (!optionalString(device["model"], MAX_DEVICE_TEXT)) return "device.model"
        }
        if (!optionalString(record["recordingMethod"], 64)) return "recordingMethod"
        instant(record["lastModified"]) ?: return "lastModified"
        if (!nullable(record["clientRecordId"]) { string(it, 0, MAX_DEVICE_TEXT) != null }) return "clientRecordId"
        if (!nullable(record["clientRecordVersion"]) { integer(it) != null }) return "clientRecordVersion"
        for (key in listOf("start", "end", "time")) {
            if (key in record && instant(record[key]) == null) return key
        }
        for (key in listOf("startOffsetMin", "endOffsetMin", "offsetMin")) {
            if (!nullable(record[key]) { integer(it)?.let { minutes -> minutes in -1080..1080 } == true }) return key
        }
        if (record["data"] !is JsonObject) return "data"

        val time = instant(record["time"])
        val start = instant(record["start"])
        val end = instant(record["end"])
        val timed = if (time == null) start != null && end != null && end >= start else start == null && end == null
        return if (timed) null else "a record carries either time, or start and end with end >= start"
    }

    /** Why the server would refuse the whole batch, or null when it would queue it. */
    fun envelopeProblem(batch: JsonObject): String? {
        if (integer(batch["v"]) != 1L) return "v"
        string(batch["deviceId"], 1, 64) ?: return "deviceId"
        string(batch["appVersion"], 1, 64) ?: return "appVersion"
        if (string(batch["batchId"])?.let(BATCH_ID::matches) != true) return "batchId"
        instant(batch["phoneTime"]) ?: return "phoneTime"
        val upserts = batch["upserts"] ?: JsonArray(emptyList())
        val deletes = batch["deletes"] ?: JsonArray(emptyList())
        if (upserts !is JsonArray || deletes !is JsonArray) return "upserts/deletes"
        if (upserts.size + deletes.size > MAX_ITEMS) return "too many items"
        return batch["syncState"]?.let { syncStateProblem(it) }
    }

    /** Positions in `deletes` the server would reject. */
    fun badDeletes(batch: JsonObject): List<Int> =
        (batch["deletes"] as? JsonArray).orEmpty().withIndex()
            .filter { string(it.value, 1, MAX_ID) == null }.map { it.index }

    private fun syncStateProblem(state: JsonElement): String? {
        if (state !is JsonObject) return "syncState"
        val types = state["types"] as? JsonArray ?: return "syncState.types"
        if (types.size > MAX_TYPES) return "syncState.types is too long"
        for (entry in types) {
            if (entry !is JsonObject) return "syncState.types[]"
            if (string(entry["type"])?.let(TYPE::matches) != true) return "syncState.types[].type"
            if (string(entry["permission"]) !in setOf("granted", "denied", "unavailable")) return "permission"
            for (key in listOf("tokenAgeS", "backlog")) {
                if (!nullable(entry[key]) { integer(it)?.let { n -> n >= 0 } == true }) return key
            }
            entry["backfill"]?.let { backfill ->
                if (backfill !is JsonObject) return "backfill"
                if ((backfill["complete"] as? JsonPrimitive)?.booleanOrNull == null) return "backfill.complete"
                if (!nullable(backfill["oldestDoneMs"]) { instant(it) != null }) return "backfill.oldestDoneMs"
            }
        }
        for (key in listOf("backgroundRead", "historyRead", "batteryExempt", "backfillComplete")) {
            val value = state[key] ?: continue
            if ((value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull == null) return key
        }
        if (!optionalString(state["hcProviderVersion"], 64)) return "hcProviderVersion"
        // Exercise routes are a permission, not a record type: a field of their own.
        state["exerciseRoutes"]?.let {
            if (string(it) !in setOf("granted", "denied", "unavailable")) return "exerciseRoutes"
        }
        state["skipReason"]?.let { skip ->
            if (skip !is JsonObject) return "skipReason"
            string(skip["errorCode"], 0, 64) ?: return "skipReason.errorCode"
            instant(skip["at"]) ?: return "skipReason.at"
        }
        if (state["androidSdk"] != null && integer(state["androidSdk"]) == null) return "androidSdk"
        val error = state["lastError"]
        if (error != null && error !is JsonNull) {
            if (error !is JsonObject) return "lastError"
            string(error["errorCode"], 0, 64) ?: return "lastError.errorCode"
            instant(error["at"]) ?: return "lastError.at"
        }
        // Which run the batch was uploaded in. All three are optional, and one that is there
        // and malformed refuses the batch.
        state["runTrigger"]?.let { if (string(it)?.let(RUN_TRIGGER::matches) != true) return "runTrigger" }
        state["runStartedAt"]?.let { instant(it) ?: return "runStartedAt" }
        state["previousRun"]?.let { previous ->
            if (previous !is JsonObject) return "previousRun"
            instant(previous["startedAt"]) ?: return "previousRun.startedAt"
            if (string(previous["end"])?.let(RUN_END::matches) != true) return "previousRun.end"
        }
        return null
    }

    private fun string(value: JsonElement?, min: Int = 0, max: Int = Int.MAX_VALUE): String? =
        (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.length in min..max }

    private fun optionalString(value: JsonElement?, max: Int): Boolean = value == null || string(value, 0, max) != null

    /** A JSON number with no fractional part. */
    private fun integer(value: JsonElement?): Long? {
        val primitive = (value as? JsonPrimitive)?.takeUnless { it.isString } ?: return null
        primitive.longOrNull?.let { return it }
        val double = primitive.doubleOrNull ?: return null
        return double.toLong().takeIf { it.toDouble() == double }
    }

    private fun instant(value: JsonElement?): Long? = integer(value)?.takeIf { it in 0..MAX_INSTANT }

    /** `.nullable().optional()`: absent and null both pass. */
    private fun nullable(value: JsonElement?, check: (JsonElement) -> Boolean): Boolean =
        value == null || value is JsonNull || check(value)
}
