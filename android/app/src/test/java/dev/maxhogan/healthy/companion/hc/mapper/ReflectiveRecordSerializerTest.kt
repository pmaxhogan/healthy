package dev.maxhogan.healthy.companion.hc.mapper

import dev.maxhogan.healthy.companion.sync.WireContract
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Stand-ins for a record class a newer library adds. */
class FakeWidgetRecord(
    val startTime: Instant,
    val startZoneOffset: ZoneOffset?,
    val endTime: Instant,
    val endZoneOffset: ZoneOffset?,
    override val metadata: Metadata,
    val pressure: Pressure,
    val mass: Mass,
    val energy: Energy,
    val temperature: Temperature,
    val percentage: Percentage,
    val length: Length?,
    val modeInt: Int,
    val label: String?,
    val isActive: Boolean,
    val span: Duration,
    val readings: List<FakeReading>,
    val nested: FakeNested,
    val opaque: Opaque,
    val kind: FakeKind,
) : Record {
    val exploding: Int
        get() = error("boom")
}

class FakeReading(val time: Instant, val value: Double)

class FakeNested(val offset: ZoneOffset, val inner: FakeReading)

enum class FakeKind {
    ALPHA
}

/** No getters. */
class Opaque {
    override fun toString(): String = "opaque-thing"
}

class FakePointRecord(
    val time: Instant,
    val zoneOffset: ZoneOffset?,
    override val metadata: Metadata,
    val count: Long,
) : Record

class FakeLoop {
    var self: FakeLoop? = null
    val tag: String
        get() = "t"
}

class FakeLoopRecord(override val metadata: Metadata, val loop: FakeLoop) : Record

class FakeThingsRecord(override val metadata: Metadata, val things: List<Opaque>) : Record

class ReflectiveRecordSerializerTest {
    private val s0 = Instant.ofEpochMilli(Fx.T0)
    private val s1 = Instant.ofEpochMilli(Fx.T1)
    private val serializer = ReflectiveRecordSerializer()

    private fun widget() =
        FakeWidgetRecord(
            startTime = s0,
            startZoneOffset = Fx.minus5h,
            endTime = s1,
            endZoneOffset = null,
            metadata = Fx.meta(),
            pressure = Pressure.millimetersOfMercury(120.0),
            mass = Mass.pounds(10.0),
            energy = Energy.kilojoules(418.4),
            temperature = Temperature.fahrenheit(212.0),
            percentage = Percentage(50.0),
            length = null,
            modeInt = 3,
            label = "x",
            isActive = true,
            span = Duration.ofSeconds(90),
            readings = listOf(FakeReading(s0, 1.5)),
            nested = FakeNested(Fx.minus4h, FakeReading(s1, 2.0)),
            opaque = Opaque(),
            kind = FakeKind.ALPHA,
        )

    @Test
    fun envelopeAndNormalisedDataForAnUnknownRecordClass() {
        val out = serializer.serialize(widget())
        assertEquals("FakeWidget", (out["type"] as JsonPrimitive).content)
        assertEquals("rec-1", (out["id"] as JsonPrimitive).content)
        assertEquals(Fx.T0, (out["start"] as JsonPrimitive).content.toLong())
        assertEquals(Fx.T1, (out["end"] as JsonPrimitive).content.toLong())
        assertEquals(-300, (out["startOffsetMin"] as JsonPrimitive).content.toInt())
        assertEquals(JsonNull, out["endOffsetMin"])
        val data = out["data"]!!.jsonObject
        val expected =
            Fx.json(
                """{"pressure": 120, "mass": 4.5359237, "energy": 100, "temperature": 100,
                  "percentage": 50, "length": null, "modeInt": 3, "label": "x", "isActive": true,
                  "span": 90000,
                  "readings": [{"_type": "FakeReading", "time": ${Fx.T0}, "value": 1.5}],
                  "nested": {"_type": "FakeNested", "offset": -240,
                    "inner": {"_type": "FakeReading", "time": ${Fx.T1}, "value": 2}},
                  "kind": "ALPHA",
                  "opaque_raw": "opaque-thing",
                  "exploding_raw": "unreadable:InvocationTargetException"}"""
            )
        Fx.assertJson(expected, data)
        // Envelope properties are not repeated inside data.
        for (k in listOf("metadata", "startTime", "endTime", "startZoneOffset", "endZoneOffset")) {
            assertFalse("$k leaked into data", k in data)
        }
    }

    @Test
    fun instantaneousUnknownRecordUsesTimeAndOffset() {
        val out = serializer.serialize(FakePointRecord(s0, Fx.minus5h, Fx.meta(), 7))
        assertEquals("FakePoint", (out["type"] as JsonPrimitive).content)
        assertEquals(Fx.T0, (out["time"] as JsonPrimitive).content.toLong())
        assertEquals(-300, (out["offsetMin"] as JsonPrimitive).content.toInt())
        Fx.assertJson(Fx.json("""{"count": 7}"""), out["data"]!!)
    }

    @Test
    fun hcRecordSerializerRoutesAnUnmappedClassToTheFallback() {
        val out = HcRecordSerializer().serialize(FakePointRecord(s0, null, Fx.meta(), 7))
        assertEquals("FakePoint", (out["type"] as JsonPrimitive).content)
        assertEquals(JsonNull, out["offsetMin"])
        assertTrue(out["data"] is JsonObject)
    }

    @Test
    fun cyclicObjectGraphsDoNotRecurseForever() {
        val loop = FakeLoop().also { it.self = it }
        val data = serializer.serialize(FakeLoopRecord(Fx.meta(), loop))["data"]!!.jsonObject
        val inner = data.getValue("loop").jsonObject
        assertEquals("t", (inner.getValue("tag") as JsonPrimitive).content)
        // The back-reference is cut and rendered raw instead of recursing.
        assertTrue("self_raw" in inner)
    }

    @Test
    fun collectionsOfUnknownThingsKeepPerElementRawFallbacks() {
        val rec = FakeThingsRecord(Fx.meta(), listOf(Opaque()))
        val things = serializer.serialize(rec)["data"]!!.jsonObject.getValue("things").jsonArray
        assertEquals("opaque-thing", (things[0].jsonObject.getValue("_raw") as JsonPrimitive).content)
    }

    @Test
    fun aRecordClassWithNoTimesIsFiledUnderItsLastModified() {
        val out = serializer.serialize(FakeLoopRecord(Fx.meta(), FakeLoop()))
        assertEquals(Fx.MODIFIED, (out["time"] as JsonPrimitive).content.toLong())
        assertEquals(null, out["start"])
        assertEquals(null, WireContract.recordProblem(out))
    }

    @Test
    fun anIntervalThatEndsBeforeItStartsStillYieldsARecordTheServerTakes() {
        val backwards = FakeWidgetRecord(
            startTime = s1,
            startZoneOffset = null,
            endTime = s0,
            endZoneOffset = null,
            metadata = Fx.meta(),
            pressure = Pressure.millimetersOfMercury(120.0),
            mass = Mass.pounds(10.0),
            energy = Energy.kilojoules(418.4),
            temperature = Temperature.fahrenheit(212.0),
            percentage = Percentage(50.0),
            length = null,
            modeInt = 3,
            label = "x",
            isActive = true,
            span = Duration.ofSeconds(90),
            readings = emptyList(),
            nested = FakeNested(Fx.minus4h, FakeReading(s1, 2.0)),
            opaque = Opaque(),
            kind = FakeKind.ALPHA,
        )
        val out = serializer.serialize(backwards)
        assertEquals(Fx.T1, (out["time"] as JsonPrimitive).content.toLong())
        assertEquals(null, WireContract.recordProblem(out))
    }

    @Test
    fun everythingTheFallbackProducesPassesTheServersRecordValidation() {
        val records = listOf(
            widget(),
            FakePointRecord(s0, Fx.minus5h, Fx.meta(), 7),
            FakePointRecord(s0, null, Fx.meta(clientId = null, device = null), 7),
            FakeLoopRecord(Fx.meta(), FakeLoop().also { it.self = it }),
            FakeThingsRecord(Fx.meta(), listOf(Opaque())),
        )
        for (record in records) {
            assertEquals(record.javaClass.simpleName, null, WireContract.recordProblem(serializer.serialize(record)))
        }
        // And so does every hand-mapped type.
        for (case in RecordFixtures.all) {
            assertEquals(case.type, null, WireContract.recordProblem(HcRecordSerializer().serialize(case.record)))
        }
    }

    @Test
    fun anUnknownRouteResultIsNamedInTheOneRouteStateKey() {
        class SomethingNewer
        assertEquals("UNKNOWN_SOMETHING_NEWER", unknownRouteState(SomethingNewer()))
        assertEquals("UNKNOWN_OPAQUE", unknownRouteState(Opaque()))
        assertTrue(Regex("^UNKNOWN(_[A-Z0-9_]+)?$").matches(unknownRouteState(object {})))
    }
}
