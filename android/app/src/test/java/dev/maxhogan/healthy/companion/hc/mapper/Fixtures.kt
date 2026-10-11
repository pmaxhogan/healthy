package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.records.metadata.DataOrigin
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.abs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue

/** Synthetic values only: example package names, no real device, no real times. */
internal object Fx {
    const val ORIGIN = "com.example.wearable"
    const val T0 = 1_790_000_000_000L
    const val T1 = T0 + 60_000L
    const val T2 = T0 + 120_000L
    const val MODIFIED = T0 + 5_000L

    val minus5h: ZoneOffset = ZoneOffset.ofHours(-5)
    val minus4h: ZoneOffset = ZoneOffset.ofHours(-4)

    fun ms(v: Long): Instant = Instant.ofEpochMilli(v)

    val device = Device(type = Device.TYPE_WATCH, manufacturer = "Example Co", model = "Model 1")

    /**
     * `Metadata`'s constructor is internal to the library (the public factories cannot set
     * `lastModifiedTime`), so tests reach it reflectively.
     */
    fun meta(
        id: String = "rec-1",
        method: Int = Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED,
        origin: String = ORIGIN,
        modified: Long = MODIFIED,
        clientId: String? = "client-1",
        clientVersion: Long = 3,
        device: Device? = this.device,
    ): Metadata {
        val ctor =
            Metadata::class.java.declaredConstructors.first {
                it.parameterCount == 7 && it.parameterTypes[0] == Int::class.javaPrimitiveType
            }
        ctor.isAccessible = true
        return ctor.newInstance(
            method,
            id,
            DataOrigin(origin),
            ms(modified),
            clientId,
            clientVersion,
            device,
        ) as Metadata
    }

    fun json(s: String): JsonObject = Json.parseToJsonElement(s) as JsonObject

    /** Structural equality; numbers compare by value so `3` and `3.0` and tiny float noise agree. */
    fun assertJson(expected: JsonElement, actual: JsonElement, path: String = "$") {
        when {
            expected is JsonObject && actual is JsonObject -> {
                assertEquals("keys at $path", expected.keys.sorted(), actual.keys.sorted())
                for (k in expected.keys) assertJson(expected.getValue(k), actual.getValue(k), "$path.$k")
            }
            expected is JsonArray && actual is JsonArray -> {
                assertEquals("length at $path", expected.size, actual.size)
                expected.indices.forEach { assertJson(expected[it], actual[it], "$path[$it]") }
            }
            expected is JsonNull || actual is JsonNull ->
                assertTrue("null mismatch at $path: $expected vs $actual", expected == actual)
            expected is JsonPrimitive && actual is JsonPrimitive -> {
                val e = expected.doubleOrNull
                val a = actual.doubleOrNull
                if (e != null && a != null && !expected.isString && !actual.isString) {
                    assertTrue(
                        "number at $path: expected $e, was $a",
                        abs(e - a) <= 1e-9 * maxOf(1.0, abs(e)),
                    )
                } else {
                    assertEquals("value at $path", expected, actual)
                }
            }
            else -> throw AssertionError("shape mismatch at $path: $expected vs $actual")
        }
    }
}
