package dev.maxhogan.healthy.companion.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The trailing re-read of the session types: what the change feed did not surface still arrives,
 * and what has arrived is not sent again.
 */
class SessionSweepTest {
    private val hour = Hours.MS
    private val nightStart = Hours.floor(NOW) - 9 * hour
    private val nightEnd = nightStart + 8 * hour

    private fun sleep(id: String, start: Long = nightStart, end: Long = nightEnd, lastModified: Long = end): JsonObject =
        record(id, type = "SleepSession", start = start, end = end, lastModified = lastModified)

    private fun page(changes: List<HcChange>, next: String) = ChangesPage(changes, next, hasMore = false, expired = false)

    private fun rig(vararg types: String = arrayOf("SleepSession", "HeartRate")) = Rig(types = types.toList())

    private fun reads(rig: Rig, type: String) = rig.source.calls.filter { it.startsWith("read:$type:") }

    @Test
    fun `a session the change feed never surfaced is uploaded by the next sync, with its hours' totals`() = runTest {
        val rig = rig()
        assertEquals(RunResult.Success, rig.sync())
        assertTrue(rig.transport.data.isEmpty())

        // Written to Health Connect, and the change feed says nothing happened.
        rig.source.add("SleepSession", sleep("night"))
        rig.source.total(AggMetric.SLEEP_DURATION, nightStart, 3_600_000.0, "com.example.wearable")
        rig.source.total(AggMetric.SLEEP_DURATION, nightStart + hour, 3_600_000.0, "com.example.wearable")
        assertEquals(RunResult.Success, rig.sync())

        val batch = rig.transport.data.single()
        assertEquals(
            listOf("night", "agg:SleepDuration:$nightStart", "agg:SleepDuration:${nightStart + hour}"),
            batch.upsertIds,
        )
        // Every hour of the night was asked about, and the ones without a total are taken away.
        assertEquals((2 until 8).map { "agg:SleepDuration:${nightStart + it * hour}" }, batch.deletes)
        assertEquals(1, rig.type("SleepSession").uploaded)
        assertEquals(mapOf("night" to nightEnd), rig.type("SleepSession").recent)
        // The change feed's token is not what moved.
        assertEquals("SleepSession#1", rig.type("SleepSession").token)
    }

    @Test
    fun `the window is the trailing 48 hours, read on every sync, and only for session types`() = runTest {
        val rig = rig("SleepSession", "ExerciseSession", "MindfulnessSession", "HeartRate", "Steps")
        rig.sync()
        rig.now += SyncCadence.PERIOD_MS
        rig.sync()
        for (type in SyncEngine.SWEEP_TYPES) {
            assertEquals(
                listOf(NOW, rig.now).map { "read:$type:${it - 48 * hour}:${SyncEngine.FAR_FUTURE_MS}:-" },
                reads(rig, type),
            )
        }
        // A series is never read by time in an incremental sync.
        assertTrue(reads(rig, "HeartRate").isEmpty())
        assertTrue(reads(rig, "Steps").isEmpty())
        assertEquals(setOf("SleepSession", "ExerciseSession", "MindfulnessSession"), SyncEngine.SWEEP_TYPES)
    }

    @Test
    fun `what was acknowledged is not sent again, and an edit is`() = runTest {
        val rig = rig()
        rig.source.add("SleepSession", sleep("night"), sleep("nap", start = NOW - 2 * hour, end = NOW - hour))
        rig.sync()
        assertEquals(listOf("night", "nap"), rig.transport.data.single().upsertIds.filter { !it.startsWith("agg:") })

        // Nothing changed: the window is read and nothing but the state report goes up.
        rig.transport.sent.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertTrue(rig.transport.data.isEmpty())
        assertEquals(2, rig.type("SleepSession").uploaded)

        // The wearable's app rewrites the night in place: same id, later lastModified.
        rig.source.records.getValue("SleepSession")[0] = sleep("night", lastModified = rig.now)
        rig.now += SyncCadence.PERIOD_MS
        rig.sync()
        assertEquals(listOf("night"), rig.transport.data.single().upsertIds)
        assertEquals(rig.now - SyncCadence.PERIOD_MS, rig.type("SleepSession").recent["night"])
    }

    @Test
    fun `a session that arrived through the change feed is not sent a second time by the re-read`() = runTest {
        val rig = rig()
        rig.sync()
        rig.source.add("SleepSession", sleep("night"))
        rig.source.changePages["SleepSession#1"] = page(listOf(HcChange.Upsert(sleep("night"))), "SleepSession#2")
        rig.sync()
        assertEquals(listOf("night"), rig.transport.data.single().upsertIds)
        assertEquals("SleepSession#2", rig.type("SleepSession").token)
        assertEquals(1, rig.type("SleepSession").uploaded)

        // A deletion through the feed forgets it, so a record written again under the same id
        // (and so with a new lastModified, or none of the old one's) would be sent.
        rig.source.records.getValue("SleepSession").clear()
        rig.source.changePages["SleepSession#2"] = page(listOf(HcChange.Delete("night")), "SleepSession#3")
        rig.sync()
        assertEquals(listOf("night"), rig.transport.data.last().deletes.filter { !it.startsWith("agg:") })
        assertTrue(rig.type("SleepSession").recent.isEmpty())
    }

    @Test
    fun `a session deleted and written again under the same id in one answer is uploaded, not deleted`() = runTest {
        val rig = rig()
        rig.sync()
        rig.source.add("SleepSession", sleep("night", lastModified = NOW))
        rig.source.changePages["SleepSession#1"] =
            page(listOf(HcChange.Upsert(sleep("night", lastModified = NOW)), HcChange.Delete("night")), "SleepSession#2")
        rig.sync()
        assertEquals(listOf("night"), rig.transport.data.flatMap { it.upsertIds })
        assertTrue(rig.transport.data.flatMap { it.deletes }.none { it == "night" })
    }

    @Test
    fun `nothing is remembered until the server acknowledges, so a failed upload is sent again`() = runTest {
        val rig = rig()
        rig.sync()
        rig.source.add("SleepSession", sleep("night"))
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(500, "oops") }
        assertEquals(RunResult.Failed("http_500"), rig.sync())
        assertTrue(rig.type("SleepSession").recent.isEmpty())
        assertEquals(0, rig.type("SleepSession").uploaded)

        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("night"), rig.transport.data.last().upsertIds)
        assertEquals(mapOf("night" to nightEnd), rig.type("SleepSession").recent)
    }

    @Test
    fun `the re-read still runs when the type's change feed fails, and the failure is still reported`() = runTest {
        val rig = rig()
        rig.sync()
        rig.source.add("SleepSession", sleep("night"))
        // Only the change feed fails; reads by time work.
        rig.source.changesFailure["SleepSession"] = HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_error")
        // The other type synced, so the run as a whole did.
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("night"), rig.transport.data.single().upsertIds)
        assertEquals("hc_error", rig.type("SleepSession").lastError?.errorCode)
        assertEquals("SleepSession#1", rig.type("SleepSession").token)

        rig.source.changesFailure.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.type("SleepSession").lastError)
        // And the session is not sent again once the feed is back.
        assertEquals(1, rig.transport.data.size)
    }

    @Test
    fun `Health Connect saying not now stops the run instead of asking again by time`() = runTest {
        val rig = rig("SleepSession")
        rig.sync()
        rig.source.calls.clear()
        rig.source.changesFailure["SleepSession"] =
            HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited")
        assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync())
        assertTrue(reads(rig, "SleepSession").isEmpty())
    }

    @Test
    fun `records that leave the window are forgotten, and one that left is not sent again`() = runTest {
        val rig = rig()
        rig.source.add("SleepSession", sleep("old", start = NOW - 47 * hour, end = NOW - 40 * hour), sleep("night"))
        rig.sync()
        assertEquals(setOf("old", "night"), rig.type("SleepSession").recent.keys)

        rig.transport.sent.clear()
        rig.now += 2 * hour
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(setOf("night"), rig.type("SleepSession").recent.keys)
        assertTrue(rig.transport.data.isEmpty())
    }

    @Test
    fun `a window of several pages is read to its end`() = runTest {
        val rig = rig("ExerciseSession")
        rig.source.pageSize = 2
        val walks = (0 until 5).map {
            record("walk$it", type = "ExerciseSession", start = NOW - (it + 1) * hour, end = NOW - (it + 1) * hour + 60_000)
        }
        rig.source.add("ExerciseSession", *walks.toTypedArray())
        rig.sync()
        assertEquals(3, reads(rig, "ExerciseSession").size)
        val sent = rig.transport.data.flatMap { it.upsertIds }.filter { !it.startsWith("agg:") }
        assertEquals(walks.map { it.getValue("id").toString().trim('"') }.toSet(), sent.toSet())
        assertEquals(5, rig.type("ExerciseSession").recent.size)
        assertFalse(rig.transport.data.isEmpty())
    }

    @Test
    fun `a sync that starts is stamped, whatever becomes of it`() = runTest {
        val rig = rig()
        assertNull(rig.store.snapshot().global.lastAttemptMs)
        rig.transport.rule = { FakeTransport.status(503, "down") }
        rig.sync()
        assertEquals(NOW, rig.store.snapshot().global.lastAttemptMs)
        assertNull(rig.store.snapshot().global.lastSyncMs)
        rig.now += 5_000_000
        rig.transport.rule = { null }
        rig.sync()
        assertEquals(rig.now, rig.store.snapshot().global.lastAttemptMs)
    }
}
