package dev.maxhogan.healthy.companion.sync

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The server's list of stale platform totals, and the repair of them: the hours a deleted
 * record covered, which the change feed cannot say, worked out again from the server's word.
 * Every value is made up; origins are `com.example.*`.
 */
class StaleTotalsTest {
    private val day = 24 * Hours.MS

    /** Two hours of a day two months back, a few hours apart: one span. */
    private val first = Hours.floor(NOW) - 60 * day
    private val second = first + 3 * Hours.MS

    /** A 200 that names [stale] (or leaves the field out, for null). */
    private fun okWith(batch: SentBatch, stale: Map<String, List<Long>>?): HttpReply {
        val base = FakeTransport.ok(batch)
        if (stale == null) return base
        val listed = stale.entries.joinToString(",") { (type, hours) -> "\"$type\":[${hours.joinToString(",")}]" }
        return base.copy(body = base.body.dropLast(1) + ",\"staleHours\":{$listed}}")
    }

    /** A rig whose server names [stale] in every answer until [stale] is set to null. */
    private class Told(val rig: Rig) {
        var stale: Map<String, List<Long>>? = null
    }

    private fun told(): Told {
        val told = Told(Rig())
        told.rig.transport.rule = { batch -> okWith(batch, told.stale) }
        return told
    }

    @Test
    fun `the hours an answer names are kept per type, and an answer without them changes nothing`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(second, first), "HeartRate" to listOf(first))
        told.rig.sync()
        assertEquals(listOf(first, second), told.rig.type("Steps").staleHours)
        // HeartRate has no platform total: nothing is kept for it.
        assertTrue(told.rig.type("HeartRate").staleHours.isEmpty())

        // The server cannot say this time, and the repair fails at Health Connect's door.
        told.stale = null
        told.rig.source.aggregateFailure = HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
        told.rig.sync()
        assertEquals(listOf(first, second), told.rig.type("Steps").staleHours)
    }

    @Test
    fun `a stale hour is worked out again and uploaded, and leaves the list once acknowledged`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(first, second))
        told.rig.sync()
        told.stale = null
        told.rig.source.total(AggMetric.STEPS, first, 120.0, "com.example.phone")
        told.rig.transport.sent.clear()

        assertEquals(RunResult.Success, told.rig.sync())

        // One request covers both hours, and each hour goes up: a total, or the deletion of its
        // record when it has none any more.
        assertEquals(listOf(Triple(AggMetric.STEPS, first, second + Hours.MS)), told.rig.source.aggregateRequests)
        val repair = told.rig.transport.data.single()
        assertEquals(listOf("agg:Steps:$first"), repair.upsertIds)
        assertEquals(120.0, repair.data.single().getValue("value").jsonPrimitive.content.toDouble(), 0.0)
        assertEquals(listOf("agg:Steps:$second"), repair.deletes)
        assertTrue(told.rig.type("Steps").staleHours.isEmpty())
    }

    @Test
    fun `a repair the server did not acknowledge keeps its hours`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(first, second))
        told.rig.sync()
        told.rig.transport.rule = { batch -> if (batch.isStateOnly) okWith(batch, null) else FakeTransport.status(500, "oops") }

        told.rig.sync()

        assertEquals(listOf(first, second), told.rig.type("Steps").staleHours)
    }

    @Test
    fun `an answer that names the stale hours replaces the list, and an empty one clears it`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(first, second))
        told.rig.sync()
        told.rig.source.aggregateFailure = HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
        told.stale = mapOf("Steps" to listOf(second))
        told.rig.sync()
        assertEquals(listOf(second), told.rig.type("Steps").staleHours)

        told.stale = emptyMap()
        told.rig.sync()
        assertTrue(told.rig.type("Steps").staleHours.isEmpty())
    }

    @Test
    fun `a long repair is spread over runs, a few requests each, and nothing is dropped`() = runTest {
        val told = told()
        // Twenty hours, each three days from the next: twenty spans.
        val hours = (0 until 20).map { first + it * 3 * day }
        told.stale = mapOf("Steps" to hours)
        told.rig.sync()
        told.stale = null

        told.rig.sync()
        assertEquals(SyncEngine.MAX_REPAIR_REQUESTS, told.rig.source.aggregateRequests.size)
        assertEquals(hours.drop(SyncEngine.MAX_REPAIR_REQUESTS), told.rig.type("Steps").staleHours)

        told.rig.sync()
        told.rig.sync()
        assertEquals(hours.size, told.rig.source.aggregateRequests.size)
        assertTrue(told.rig.type("Steps").staleHours.isEmpty())
        // Every hour went up once, as the deletion of its total (Health Connect has none).
        val deleted = told.rig.transport.data.flatMap { it.deletes }.toSet()
        assertEquals(hours.map { AggMetric.STEPS.recordId(it) }.toSet(), deleted)
    }

    @Test
    fun `a type that is not granted keeps its stale hours and is not asked about`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(first))
        told.rig.sync()
        told.stale = null
        told.rig.access = access("HeartRate", denied = listOf("Steps", "TotalCaloriesBurned"))

        told.rig.sync()

        assertTrue(told.rig.source.aggregateRequests.isEmpty())
        assertEquals(listOf(first), told.rig.type("Steps").staleHours)
    }

    @Test
    fun `a total uploaded by an ordinary sync takes its hour off the list`() = runTest {
        val told = told()
        val recent = Hours.floor(NOW)
        told.stale = mapOf("Steps" to listOf(first, recent))
        told.rig.sync()
        told.stale = null
        told.rig.source.changePages["Steps#1"] = ChangesPage(
            listOf(HcChange.Upsert(record("s-1", start = recent + 60_000))),
            "Steps#2",
            hasMore = false,
            expired = false,
        )

        told.rig.sync()

        // The change feed worked out its own hour, and the upload that carried it took the hour
        // off the list before the repair began: the repair asks only for the other one.
        assertEquals(
            listOf(
                Triple(AggMetric.STEPS, recent, recent + Hours.MS),
                Triple(AggMetric.STEPS, first, first + Hours.MS),
            ),
            told.rig.source.aggregateRequests,
        )
        assertTrue(told.rig.type("Steps").staleHours.isEmpty())
    }

    @Test
    fun `a platform total id names its metric and hour`() {
        assertEquals(AggMetric.DISTANCE to first, AggMetric.hourOf(AggMetric.DISTANCE.recordId(first)))
        assertEquals(null, AggMetric.hourOf("agg:Nonsense:$first"))
        assertEquals(null, AggMetric.hourOf("0f4a2c1e-0000-4000-8000-000000000000"))
        assertEquals(null, AggMetric.hourOf("agg:Steps:soon"))
    }

    @Test
    fun `the repair batch is one the server takes`() = runTest {
        val told = told()
        told.stale = mapOf("Steps" to listOf(first, second))
        told.rig.sync()
        told.stale = null
        told.rig.source.total(AggMetric.STEPS, first, 7.0, "com.example.phone")
        told.rig.transport.sent.clear()
        told.rig.sync()
        for (upsert in told.rig.transport.data.single().upserts) {
            assertEquals(null, WireContract.recordProblem(upsert.jsonObject))
        }
    }
}
