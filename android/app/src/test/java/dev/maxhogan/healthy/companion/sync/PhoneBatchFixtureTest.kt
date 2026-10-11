package dev.maxhogan.healthy.companion.sync

import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.metadata.Metadata
import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import dev.maxhogan.healthy.companion.hc.RecordTypes
import dev.maxhogan.healthy.companion.hc.mapper.Fx
import dev.maxhogan.healthy.companion.hc.mapper.HcRecordSerializer
import dev.maxhogan.healthy.companion.hc.mapper.RecordFixtures
import java.io.ByteArrayInputStream
import java.io.File
import java.time.Instant
import java.util.zip.GZIPInputStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A record class no mapper knows, with a time of its own: the reflection fallback handles it. */
class FixturePointRecord(val time: Instant, override val metadata: Metadata, val reading: Double) : Record

/** A record class that exposes no time at all: the fallback has to give it one. */
class FixtureTimelessRecord(override val metadata: Metadata, val label: String) : Record

/**
 * The contract between the two languages, as a file both read.
 *
 * This test builds a handful of batches with the real serializer and the real batcher, from
 * fully synthetic records, and compares them with `worker/test/fixtures/hc/phone-batches.json`.
 * The Worker's own tests run every batch in that file through its validator. So a change on
 * either side that the other would not accept fails a test instead of failing on a phone.
 *
 * The file cannot go stale: when what this test would write differs from what is checked in, it
 * fails. To accept an intended change, run the test once with `HEALTHY_WRITE_FIXTURES=1` in the
 * environment and commit the file. The comparison is of the parsed JSON, so a formatter may
 * re-indent the file without breaking it.
 */
class PhoneBatchFixtureTest {
    private val serializer = HcRecordSerializer()
    private val encoder = BatchEncoder(DEVICE, "0.1.0")
    private val pretty = Json {
        prettyPrint = true
        prettyPrintIndent = "  "
    }
    private val phoneTime = Fx.T0 + 600_000

    /** Every mapped record type, each under an id of its own. */
    private fun mapped(): List<JsonObject> = RecordFixtures.all.map { case ->
        withId(serializer.serialize(case.record), "rec-${case.type}")
    }

    private fun withId(wire: JsonObject, id: String) = JsonObject(wire + ("id" to JsonPrimitive(id)))

    private fun syncState(): String {
        val types = RecordTypes.ALL.map(RecordTypes::typeName)
        val access = HealthAccess(
            status = HealthConnectStatus.AVAILABLE,
            types = types.withIndex().associate { (index, type) ->
                type to when (index % 5) {
                    3 -> Grant.DENIED
                    4 -> Grant.UNAVAILABLE
                    else -> Grant.GRANTED
                }
            },
            backgroundRead = Grant.GRANTED,
            historyRead = Grant.DENIED,
            exerciseRoutes = Grant.DENIED,
        )
        val snapshot = SyncSnapshot(
            GlobalState(deviceId = DEVICE, backfillRequested = true, lastError = StoredError("network", Fx.T0)),
            mapOf(
                types[0] to TypeState(
                    token = "t",
                    tokenCreatedMs = Fx.T0,
                    backlog = 3,
                    backfill = BackfillState(started = true, complete = true, oldestDoneMs = Months.floor(Fx.T0)),
                ),
                types[1] to TypeState(backfill = BackfillState(started = true, monthMs = Months.floor(Fx.T0))),
            ),
        )
        return SyncStateReport.build(types, access, snapshot, FACTS, phoneTime).toString()
    }

    private class Built(val name: String, val description: String, val body: JsonObject)

    private fun build(
        name: String,
        description: String,
        items: List<BatchItem>,
        syncState: String?,
        fixedId: String? = null,
    ): Built {
        val batch = encoder.plan("fixture\u001f$name", items, syncState, phoneTime).single()
        val raw = GZIPInputStream(ByteArrayInputStream(batch.gzip)).readBytes().toString(Charsets.UTF_8)
        var body = Json.parseToJsonElement(raw).jsonObject
        // A batch with no items gets a random id; the fixture needs the same one every time.
        if (fixedId != null) body = JsonObject(body + ("batchId" to JsonPrimitive(fixedId)))
        return Built(name, description, body)
    }

    private fun batches(): List<Built> {
        val hour = Hours.floor(Fx.T0)
        val records = mapped().map(BatchItem::record)
        val total = BatchItem.aggregate(
            AggMetric.STEPS,
            HourAggregate(hour, 1234.0, listOf("com.example.wearable", "com.example.phone")),
            phoneTime,
        )
        val sleep = BatchItem.aggregate(
            AggMetric.SLEEP_DURATION,
            HourAggregate(hour - Hours.MS, 3_540_000.0, listOf("com.example.wearable")),
            phoneTime,
        )
        val unmapped = listOf(
            serializer.serialize(FixturePointRecord(Fx.ms(Fx.T1), Fx.meta(id = "rec-unmapped-point"), 7.5)),
            serializer.serialize(FixtureTimelessRecord(Fx.meta(id = "rec-unmapped-timeless", device = null, clientId = null), "x")),
        ).map(BatchItem::record)
        val huge = BatchItem.record(withId(serializer.serialize(RecordFixtures.all.first { it.type == "ExerciseSession" }.record), "rec-oversize"))
        val stub = BatchItem.oversizeStub(huge)!!

        return listOf(
            build(
                "changes",
                "One page of changes: every mapped record type, platform aggregates for the hours " +
                    "they touch (one total, one hour left empty and so deleted), two deletions, and the state report.",
                records + total + BatchItem.Delete(AggMetric.STEPS.recordId(hour + Hours.MS), synthetic = true) +
                    BatchItem.Delete("rec-gone-1") + BatchItem.Delete("rec-gone-2"),
                syncState(),
            ),
            build(
                "backfill-month",
                "The last page of a backfilled month: records, then the totals of the hours that have one. No deletes.",
                records.take(3) + total + sleep,
                syncState(),
            ),
            build(
                "unmapped-records",
                "Record classes without a hand-written mapper, through the reflection fallback: " +
                    "one with a time of its own, one with none (it is filed under its lastModified).",
                unmapped,
                null,
            ),
            build(
                "oversize-stub",
                "What goes up in place of a record too large to send: its envelope, with data " +
                    "replaced by {oversize, bytes}.",
                listOf(stub),
                null,
            ),
            build("deletes-only", "Deletions and nothing else.", listOf(BatchItem.Delete("rec-gone-3")), null),
            build(
                "state-only",
                "The batch that closes every run: no records, only the state report.",
                emptyList(),
                syncState(),
                fixedId = "fixture-state-only-0001",
            ),
        )
    }

    private fun document(): JsonObject = buildJsonObject {
        put("generatedBy", JsonPrimitive("android/app/src/test/java/dev/maxhogan/healthy/companion/sync/PhoneBatchFixtureTest.kt"))
        put(
            "note",
            JsonPrimitive(
                "Generated, do not edit. Batches exactly as the companion app builds them, from synthetic " +
                    "records. Regenerate with HEALTHY_WRITE_FIXTURES=1 gradlew testDebugUnitTest.",
            ),
        )
        put(
            "batches",
            JsonArray(
                batches().map { built ->
                    buildJsonObject {
                        put("name", JsonPrimitive(built.name))
                        put("description", JsonPrimitive(built.description))
                        put(
                            "expect",
                            buildJsonObject {
                                put("upserts", JsonPrimitive(built.body.getValue("upserts").jsonArray.size))
                                put("deletes", JsonPrimitive(built.body.getValue("deletes").jsonArray.size))
                                put("rejected", JsonPrimitive(0))
                                put("hasSyncState", JsonPrimitive("syncState" in built.body))
                            },
                        )
                        put("body", built.body)
                    }
                },
            ),
        )
    }

    @Test
    fun `every fixture batch passes the server's validation`() {
        val built = batches()
        assertEquals(6, built.size)
        for (batch in built) {
            assertNull("${batch.name}: envelope", WireContract.envelopeProblem(batch.body))
            assertTrue("${batch.name}: deletes", WireContract.badDeletes(batch.body).isEmpty())
            for (record in batch.body.getValue("upserts").jsonArray) {
                val wire = record.jsonObject
                assertNull("${batch.name}: ${wire["id"]}", WireContract.recordProblem(wire))
            }
        }
        // The first batch really does cover the whole registry, and nothing shares an id.
        val changes = built.first().body.getValue("upserts").jsonArray.map { it.jsonObject }
        val typeNames = changes.map { (it.getValue("type") as JsonPrimitive).content }.toSet()
        assertTrue(typeNames.containsAll(RecordTypes.ALL.map(RecordTypes::typeName)))
        assertTrue("Agg.Steps" in typeNames)
        assertEquals(changes.size, changes.map { it.getValue("id") }.toSet().size)
    }

    @Test
    fun `the fixtures are synthetic and the same every time`() {
        val first = document()
        assertEquals(first, document())
        val text = first.toString()
        for (origin in Regex("\"origin\":\"([^\"]+)\"").findAll(text).map { it.groupValues[1] }) {
            assertTrue(origin, origin.startsWith("com.example.") || origin == BatchItem.AGG_ORIGIN)
        }
    }

    @Test
    fun `the checked-in fixture file is what the app builds today`() {
        // Unit tests run with the module directory (android/app) as the working directory.
        val file = File("../../worker/test/fixtures/hc/phone-batches.json")
        val expected: JsonElement = document()
        if (System.getenv("HEALTHY_WRITE_FIXTURES") == "1") {
            file.parentFile?.mkdirs()
            file.writeText(pretty.encodeToString(JsonElement.serializer(), expected) + "\n", Charsets.UTF_8)
            return
        }
        if (!file.exists()) {
            fail("${file.path} is missing. Run this test once with HEALTHY_WRITE_FIXTURES=1 and commit the file.")
        }
        val actual = Json.parseToJsonElement(file.readText(Charsets.UTF_8))
        if (actual != expected) {
            fail(
                "${file.path} is not what the app builds now. If the change is intended, run this test " +
                    "once with HEALTHY_WRITE_FIXTURES=1 and commit the file; the Worker's tests then check it.",
            )
        }
    }
}
