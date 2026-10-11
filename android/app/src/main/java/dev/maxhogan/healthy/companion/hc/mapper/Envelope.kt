package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.metadata.Metadata
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** Where a record sits in time: an interval or a single instant. */
internal sealed interface Timing

internal class IntervalTiming(
    val start: Instant,
    val startOffset: ZoneOffset?,
    val end: Instant,
    val endOffset: ZoneOffset?,
) : Timing

internal class InstantTiming(val time: Instant, val offset: ZoneOffset?) : Timing

/** The wire envelope shared by hand-written mappers and the reflection fallback. */
internal object Envelope {
    fun build(type: String, metadata: Metadata, timing: Timing?, data: JsonObject): JsonObject =
        buildJsonObject {
            put("id", JsonPrimitive(metadata.id))
            put("type", JsonPrimitive(type))
            put("origin", JsonPrimitive(metadata.dataOrigin.packageName))
            val device = metadata.device
            if (device != null) {
                put(
                    "device",
                    buildJsonObject {
                        put(
                            "type",
                            JsonPrimitive(EnumTables.name(EnumTables.deviceType, device.type)),
                        )
                        putStr("manufacturer", device.manufacturer)
                        putStr("model", device.model)
                    },
                )
            }
            put(
                "recordingMethod",
                JsonPrimitive(EnumTables.name(EnumTables.recordingMethod, metadata.recordingMethod)),
            )
            put("lastModified", epochMs(metadata.lastModifiedTime))
            val clientId = metadata.clientRecordId
            if (clientId != null) {
                put("clientRecordId", JsonPrimitive(clientId))
                put("clientRecordVersion", JsonPrimitive(metadata.clientRecordVersion))
            }
            when (timing) {
                is IntervalTiming -> {
                    put("start", epochMs(timing.start))
                    put("end", epochMs(timing.end))
                    put("startOffsetMin", offsetMin(timing.startOffset))
                    put("endOffsetMin", offsetMin(timing.endOffset))
                }
                is InstantTiming -> {
                    put("time", epochMs(timing.time))
                    put("offsetMin", offsetMin(timing.offset))
                }
                null -> Unit
            }
            put("data", data)
        }
}
