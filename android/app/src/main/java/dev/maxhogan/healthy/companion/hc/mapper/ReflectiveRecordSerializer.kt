package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import androidx.health.connect.client.units.Velocity
import androidx.health.connect.client.units.Volume
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.util.IdentityHashMap
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Fallback for a Record class with no hand-written mapper (a type a newer library adds).
 *
 * Walks public getters, so it needs R8 keep rules; see the module's proguard file:
 * `-keep class androidx.health.connect.client.records.** { public *; }` and the same for
 * `...units.**` and `...records.metadata.**`, plus `-keepnames` on all three so `type` and `_type`
 * survive minification.
 *
 * Rendering rules: unit-typed values are normalised (design section 2), `Instant` is epoch ms,
 * `ZoneOffset` is minutes, `Duration` is ms, enums are their name, int enums stay numbers under
 * the property name, collections and beans recurse. A value of a type it cannot render goes under
 * `<property>_raw` as its `toString()`. It never throws.
 */
class ReflectiveRecordSerializer : RecordSerializer {
    override fun serialize(record: Record): JsonObject =
        try {
            val cls = record.javaClass
            val type = cls.simpleName.removeSuffix("Record")
            val timing = timingOrFallback(record)
            val data = buildJsonObject {
                for ((name, getter) in getters(cls)) {
                    if (name in ENVELOPE_PROPERTIES) continue
                    putProperty(name, getter, record, 0, IdentityHashMap())
                }
            }
            Envelope.build(type, record.metadata, timing, data)
        } catch (e: Exception) {
            // Last resort: the envelope alone, so the batch still goes out. It keeps the
            // record's own times; the server refuses a record that has none.
            Envelope.build(
                record.javaClass.simpleName.removeSuffix("Record"),
                record.metadata,
                timingOrFallback(record),
                buildJsonObject { put("serializeError_raw", JsonPrimitive(e.javaClass.simpleName)) },
            )
        }

    /**
     * The record's times, or, for a class that exposes none this code recognises (or an
     * interval that ends before it starts), the instant it was last modified. The wire contract
     * requires every record to carry `time`, or `start` and `end` with `end >= start`; a record
     * without them would be rejected by the server, which is a dropped record by another name.
     */
    private fun timingOrFallback(record: Record): Timing {
        val timing = try {
            timingOf(record)
        } catch (e: Exception) {
            null
        }
        return when {
            timing is IntervalTiming && timing.end.isBefore(timing.start) ->
                InstantTiming(timing.start, timing.startOffset)
            timing != null -> timing
            else -> InstantTiming(record.metadata.lastModifiedTime, null)
        }
    }

    private fun timingOf(record: Record): Timing? {
        val cls = record.javaClass
        val start = call(cls, record, "getStartTime") as? Instant
        val end = call(cls, record, "getEndTime") as? Instant
        if (start != null && end != null) {
            return IntervalTiming(
                start,
                call(cls, record, "getStartZoneOffset") as? ZoneOffset,
                end,
                call(cls, record, "getEndZoneOffset") as? ZoneOffset,
            )
        }
        val time = call(cls, record, "getTime") as? Instant
        if (time != null) return InstantTiming(time, call(cls, record, "getZoneOffset") as? ZoneOffset)
        return null
    }

    private fun call(cls: Class<*>, target: Any, method: String): Any? =
        try {
            cls.getMethod(method).invoke(target)
        } catch (e: Exception) {
            null
        }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putProperty(
        name: String,
        getter: Method,
        target: Any,
        depth: Int,
        seen: IdentityHashMap<Any, Boolean>,
    ) {
        val value =
            try {
                getter.invoke(target)
            } catch (e: Exception) {
                put("${name}_raw", JsonPrimitive("unreadable:" + e.javaClass.simpleName))
                return
            }
        val encoded = encode(value, depth, seen)
        if (encoded != null) put(name, encoded) else put("${name}_raw", JsonPrimitive(safeToString(value)))
    }

    /** `null` means "not renderable": the caller stores `toString()` under a `_raw` key. */
    private fun encode(v: Any?, depth: Int, seen: IdentityHashMap<Any, Boolean>): JsonElement? =
        when (v) {
            null -> JsonNull
            is Boolean -> JsonPrimitive(v)
            is Int -> num(v)
            is Long -> num(v)
            is Short -> num(v.toInt())
            is Byte -> num(v.toInt())
            is Float -> num(v.toDouble())
            is Double -> num(v)
            is String -> JsonPrimitive(v)
            is Char -> JsonPrimitive(v.toString())
            is Enum<*> -> JsonPrimitive(v.name)
            is Instant -> epochMs(v)
            is ZoneOffset -> offsetMin(v)
            is Duration -> durationMs(v)
            is Length -> num(v.metres())
            is Mass -> num(v.kg())
            is Energy -> num(v.kcal())
            is Power -> num(v.watts())
            is Pressure -> num(v.mmHg())
            is Temperature -> num(v.celsius())
            is TemperatureDelta -> num(v.celsius())
            is Volume -> num(v.litres())
            is Velocity -> num(v.mps())
            is Percentage -> num(v.pct())
            is BloodGlucose -> num(v.mmolPerL())
            is Map<*, *> -> encodeMap(v, depth, seen)
            is Iterable<*> -> encodeList(v, depth, seen)
            is Array<*> -> encodeList(v.asList(), depth, seen)
            is IntArray -> JsonArray(v.map { num(it) })
            is LongArray -> JsonArray(v.map { num(it) })
            is DoubleArray -> JsonArray(v.map { num(it) })
            else -> encodeBean(v, depth, seen)
        }

    private fun encodeList(items: Iterable<*>, depth: Int, seen: IdentityHashMap<Any, Boolean>) =
        JsonArray(
            items.map { item ->
                encode(item, depth + 1, seen)
                    ?: buildJsonObject { put("_raw", JsonPrimitive(safeToString(item))) }
            }
        )

    private fun encodeMap(m: Map<*, *>, depth: Int, seen: IdentityHashMap<Any, Boolean>) =
        buildJsonObject {
            for ((k, value) in m) {
                val key = safeToString(k)
                val e = encode(value, depth + 1, seen)
                if (e != null) put(key, e) else put("${key}_raw", JsonPrimitive(safeToString(value)))
            }
        }

    private fun encodeBean(v: Any, depth: Int, seen: IdentityHashMap<Any, Boolean>): JsonElement? {
        if (depth >= MAX_DEPTH || seen.containsKey(v)) return null
        val props = getters(v.javaClass)
        if (props.isEmpty()) return null
        seen[v] = true
        try {
            return buildJsonObject {
                put("_type", JsonPrimitive(v.javaClass.simpleName))
                for ((name, getter) in props) putProperty(name, getter, v, depth + 1, seen)
            }
        } finally {
            seen.remove(v)
        }
    }

    private fun getters(cls: Class<*>): List<Pair<String, Method>> =
        cls.methods
            .asSequence()
            .filter {
                it.parameterCount == 0 &&
                    !Modifier.isStatic(it.modifiers) &&
                    !it.isBridge &&
                    !it.isSynthetic &&
                    it.returnType != Void.TYPE &&
                    it.declaringClass != Any::class.java
            }
            .mapNotNull { m -> propertyName(m)?.let { it to m } }
            .distinctBy { it.first }
            .sortedBy { it.first }
            .toList()

    private fun propertyName(m: Method): String? {
        val n = m.name
        return when {
            n.length > 3 && n.startsWith("get") && n[3].isUpperCase() ->
                n[3].lowercaseChar() + n.substring(4)
            // Kotlin `isFoo` / `hasFoo` Boolean properties keep their own name.
            (n.startsWith("is") || n.startsWith("has")) &&
                (m.returnType == java.lang.Boolean.TYPE || m.returnType == Boolean::class.javaObjectType) -> n
            else -> null
        }
    }

    private fun safeToString(v: Any?): String =
        try {
            v.toString()
        } catch (e: Exception) {
            "unprintable:" + (v?.javaClass?.simpleName ?: "null")
        }

    private companion object {
        const val MAX_DEPTH = 12

        /** Already carried by the envelope. */
        val ENVELOPE_PROPERTIES =
            setOf(
                "metadata",
                "startTime",
                "endTime",
                "time",
                "startZoneOffset",
                "endZoneOffset",
                "zoneOffset",
            )
    }
}
