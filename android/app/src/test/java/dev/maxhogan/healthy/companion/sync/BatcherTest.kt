package dev.maxhogan.healthy.companion.sync

import java.io.ByteArrayInputStream
import java.util.zip.GZIPInputStream
import kotlin.random.Random
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BatcherTest {
    private val encoder = BatchEncoder(DEVICE, "0.1.0")
    private val idPattern = Regex("^[A-Za-z0-9_-]{8,64}$")

    private fun items(count: Int, padding: String = "") =
        (0 until count).map { BatchItem.record(record("id-$it", padding = padding)) }

    private fun ids(batches: List<EncodedBatch>) =
        batches.map { batch -> batch.items.map { (it as BatchItem.Upsert).id } }

    private fun decode(batch: EncodedBatch) =
        Json.parseToJsonElement(
            GZIPInputStream(ByteArrayInputStream(batch.gzip)).readBytes().toString(Charsets.UTF_8),
        ).jsonObject

    private fun noise(length: Int, seed: Int): String {
        val random = Random(seed)
        return buildString { repeat(length) { append('a' + random.nextInt(26)) } }
    }

    @Test
    fun `the envelope carries what the server validates`() {
        val all = items(2) + BatchItem.Delete("gone-1")
        val batch = encoder.plan("p", all, """{"types":[]}""", 123).single()
        val json = decode(batch)
        assertEquals(1L, json.getValue("v").jsonPrimitive.long)
        assertEquals(DEVICE, json.getValue("deviceId").jsonPrimitive.content)
        assertEquals("0.1.0", json.getValue("appVersion").jsonPrimitive.content)
        assertEquals(batch.batchId, json.getValue("batchId").jsonPrimitive.content)
        assertEquals(123L, json.getValue("phoneTime").jsonPrimitive.long)
        assertEquals(2, json.getValue("upserts").jsonArray.size)
        assertEquals(listOf("gone-1"), json.getValue("deletes").jsonArray.map { it.jsonPrimitive.content })
        assertTrue("syncState" in json)
        assertEquals(batch.rawBytes, GZIPInputStream(ByteArrayInputStream(batch.gzip)).readBytes().size)
        assertTrue(idPattern.matches(batch.batchId))
    }

    @Test
    fun `items are split by raw size, in order, each exactly once`() {
        val small = BatchEncoder(DEVICE, "0.1.0", BatchLimits(targetGzipBytes = 1 shl 20, targetRawBytes = 4_000))
        val all = items(50, padding = "x".repeat(300))
        val batches = small.plan("p", all, null, 0)
        assertTrue(batches.size > 1)
        assertTrue(batches.all { it.rawBytes <= 4_000 })
        assertEquals(all.map { it.id }, ids(batches).flatten())
    }

    @Test
    fun `a batch whose compressed size is over the target is halved until it fits`() {
        val small = BatchEncoder(DEVICE, "0.1.0", BatchLimits(targetGzipBytes = 3_000, targetRawBytes = 1 shl 20))
        val all = (0 until 40).map { BatchItem.record(record("id-$it", padding = noise(600, it))) }
        val batches = small.plan("p", all, null, 0)
        assertTrue(batches.size > 1)
        assertTrue(batches.all { it.gzip.size <= 3_000 })
        assertEquals(all.map { it.id }, ids(batches).flatten())
    }

    @Test
    fun `a single record over both targets still goes, alone`() {
        val small = BatchEncoder(DEVICE, "0.1.0", BatchLimits(targetGzipBytes = 500, targetRawBytes = 1_000))
        val huge = BatchItem.record(record("huge", padding = noise(20_000, 1)))
        val all = listOf(BatchItem.record(record("a")), huge, BatchItem.record(record("b")))
        val batches = small.plan("p", all, null, 0)
        assertEquals(listOf(listOf("a"), listOf("huge"), listOf("b")), ids(batches))
        assertTrue(batches[1].rawBytes > 1_000)
        assertNull(small.halve("p", batches[1], null, 0))
    }

    @Test
    fun `hard caps are reported, never silently enforced`() {
        val limits = BatchLimits(hardGzipBytes = 100, hardRawBytes = 200)
        val batch = BatchEncoder(DEVICE, "0.1.0", limits).plan("p", items(1, noise(2_000, 3)), null, 0).single()
        assertTrue(batch.exceeds(limits))
        assertFalse(encoder.plan("p", items(1), null, 0).single().exceeds(BatchLimits()))
    }

    @Test
    fun `halving keeps every item`() {
        val batch = encoder.plan("p", items(5), null, 0).single()
        val halves = encoder.halve("p", batch, null, 0)!!
        assertEquals(listOf(2, 3), halves.map { it.items.size })
        assertNotEquals(halves[0].batchId, halves[1].batchId)
    }

    @Test
    fun `the same bytes always carry the same batch id, and different bytes never do`() {
        val state = """{"types":[]}"""
        fun id(
            position: String = "changes:Steps:t1",
            content: List<BatchItem> = items(3),
            syncState: String? = state,
            phoneTime: Long = 1,
            from: BatchEncoder = encoder,
        ) = from.plan(position, content, syncState, phoneTime).single()

        val first = id()
        val again = id()
        assertEquals(first.batchId, again.batchId)
        assertTrue(first.gzip.contentEquals(again.gzip))
        assertFalse(first.freshId)

        val edited = items(3).dropLast(1) + BatchItem.record(record("id-2", lastModified = NOW + 5))
        val others = listOf(
            id(position = "changes:Steps:t2"),
            id(content = items(4)),
            id(content = edited),
            id(content = items(3) + BatchItem.Delete("x")),
            id(syncState = """{"types":[],"androidSdk":37}"""),
            id(syncState = null),
            id(phoneTime = 2),
            id(from = BatchEncoder("OTHER", "0.1.0")),
            id(from = BatchEncoder(DEVICE, "0.1.1")),
        )
        assertEquals(others.size + 1, (others + first).map { it.batchId }.toSet().size)
        assertTrue(others.all { idPattern.matches(it.batchId) })
    }

    @Test
    fun `a reminted batch has the same content under a new id`() {
        val batch = encoder.plan("p", items(3), null, 1).single()
        val reminted = encoder.remint("p", batch, null, 1)
        assertNotEquals(batch.batchId, reminted.batchId)
        assertTrue(reminted.freshId)
        assertEquals(decode(batch).getValue("upserts"), decode(reminted).getValue("upserts"))
        assertTrue(idPattern.matches(reminted.batchId))
    }

    @Test
    fun `a batch never holds more items than the target count`() {
        val small = BatchEncoder(DEVICE, "0.1.0", BatchLimits(targetItems = 7))
        val all = items(20) + (0 until 3).map { BatchItem.Delete("gone-$it") }
        val batches = small.plan("p", all, null, 0)
        assertEquals(listOf(7, 7, 7, 2), batches.map { it.items.size })
        assertEquals(20_000, BatchLimits().targetItems)
        assertTrue(BatchLimits().targetItems < BatchLimits().hardItems)
        val limits = BatchLimits(hardItems = 5)
        assertTrue(BatchEncoder(DEVICE, "0.1.0").plan("p", items(6), null, 0).single().exceeds(limits))
    }

    @Test
    fun `a batch with nothing but sync state gets a fresh id every time`() {
        val one = encoder.plan("state", emptyList(), "{}", 1).single()
        val two = encoder.plan("state", emptyList(), "{}", 1).single()
        assertTrue(one.items.isEmpty())
        assertNotEquals(one.batchId, two.batchId)
        assertTrue(idPattern.matches(one.batchId))
    }

    @Test
    fun `an aggregate record is a synthetic hour-long record from the platform`() {
        val hour = HourAggregate(Hours.floor(NOW), 120.0, listOf("com.example.wearable"))
        val first = BatchItem.aggregate(AggMetric.STEPS, hour, NOW)
        val json = Json.parseToJsonElement(first.json).jsonObject
        assertEquals("Agg.Steps", json.getValue("type").jsonPrimitive.content)
        assertEquals("healthconnect", json.getValue("origin").jsonPrimitive.content)
        assertEquals("agg:Steps:${hour.hourStartMs}", json.getValue("id").jsonPrimitive.content)
        assertEquals(hour.hourStartMs, json.getValue("start").jsonPrimitive.long)
        assertEquals(hour.hourStartMs + 3_600_000, json.getValue("end").jsonPrimitive.long)
        assertEquals(NOW, json.getValue("lastModified").jsonPrimitive.long)
        val data = json.getValue("data").jsonObject
        assertEquals("count", data.getValue("unit").jsonPrimitive.content)
        assertEquals(listOf("com.example.wearable"), data.getValue("origins").jsonArray.map { it.jsonPrimitive.content })
        assertTrue(first.synthetic)
    }

    @Test
    fun `utf8 length matches the real encoding`() {
        for (text in listOf("", "abc", "é", "日本語", "a😀b")) {
            assertEquals(text, text.toByteArray(Charsets.UTF_8).size, utf8Length(text))
        }
    }
}
