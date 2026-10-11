package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.RecordTypes
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The first real run on a phone with years of data, and the re-run after it: how many requests
 * it makes, what it holds in memory, and what a re-run takes away.
 */
class BackfillFirstRunTest {
    private val thisMonth = Months.floor(NOW)
    private val lastMonth = Months.previous(thisMonth)

    private fun monthsBack(n: Int): Long = (0 until n).fold(thisMonth) { month, _ -> Months.previous(month) }

    private fun hr(id: String, start: Long) = record(id, type = "HeartRate", start = start)

    private fun reads(rig: Rig, type: String) = rig.source.calls.count { it.startsWith("read:$type:") }

    // --- request counts -------------------------------------------------------------------------

    @Test
    fun `a type with a reading every few years costs a handful of requests, not one a month`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        val tenYears = monthsBack(120)
        val fiveYears = monthsBack(60)
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("mid", fiveYears + Hours.MS), hr("old", tenYears + Hours.MS))
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)

        // Two probes for the range; then per stretch of empty months one empty read and one
        // probe, and one read for each month that has something: 2 + 3 + 2 * 2.
        assertEquals(9, reads(rig, "HeartRate"))
        assertEquals(listOf(listOf("now"), listOf("mid"), listOf("old")), rig.transport.data.map { it.upsertIds })
        val backfill = rig.type("HeartRate").backfill
        assertTrue(backfill.complete)
        assertEquals(tenYears, backfill.oldestDoneMs)
        assertEquals(tenYears, backfill.floorMonthMs)
        // Skipped months count as done: the bar runs to the end.
        val progress = SyncUiStates.progress(listOf("HeartRate"), rig.access, rig.store.snapshot(), running = false)
        assertEquals(121, progress.totalUnits)
        assertEquals(121, progress.doneUnits)
        assertEquals(BackfillPhase.COMPLETE, progress.phase)
    }

    @Test
    fun `skipping is resumable, and progress shows the months skipped as done`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        val old = monthsBack(30)
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("old", old + Hours.MS))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        // Setup, this month, then the empty month below it, which jumps.
        repeat(3) { assertTrue(rig.engine.backfillStep(rig.session(), run) is BackfillStep.Progress) }
        val jumped = rig.type("HeartRate").backfill
        assertEquals(old, jumped.monthMs)
        assertEquals(Months.next(old), jumped.oldestDoneMs)
        assertFalse(jumped.complete)
        assertEquals(30, SyncUiStates.progress(listOf("HeartRate"), rig.access, rig.store.snapshot(), running = true).doneUnits)

        // "Process death": a new session finishes from the stored cursor.
        assertEquals(BackfillStep.Complete, rig.drive(BackfillRun()).first)
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `a record older than the measured range that turns up meanwhile is still fetched`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("mid", monthsBack(4) + 1))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        repeat(2) { rig.engine.backfillStep(rig.session(), run) }
        rig.source.add("HeartRate", hr("older", monthsBack(9) + 1))
        assertEquals(BackfillStep.Complete, rig.drive(run).first)
        // Not by the walk (its floor was measured before the record existed), and that is right:
        // it was written after the changes token was taken, so incremental sync delivers it.
        assertEquals(monthsBack(4), rig.type("HeartRate").backfill.floorMonthMs)
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `three years of history for forty-one types, eight of them in use`() = runTest {
        val all = RecordTypes.ALL.map(RecordTypes::typeName)
        assertEquals(41, all.size)
        val withTotals = listOf("Steps", "Distance", "ActiveCaloriesBurned", "SleepSession", "ExerciseSession")
        val plain = listOf("HeartRate", "Weight", "RestingHeartRate")
        val active = withTotals + plain
        assertTrue(all.containsAll(active))
        val rig = Rig(types = all)
        val months = 37
        for (type in active) {
            for (back in 0 until months) {
                val month = monthsBack(back)
                // One page of records a month; the first day of the month, so none is in the future.
                rig.source.add(type, record("$type-$back", type = type, start = month + Hours.MS))
            }
        }
        for (type in withTotals) {
            val metric = AggMetric.forType(type)!!
            for (back in 0 until months) rig.source.total(metric, monthsBack(back) + Hours.MS, 1.0, "com.example.wearable")
        }
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        var steps = 0
        var requests = 0
        while (true) {
            val step = rig.engine.backfillStep(rig.session(), run)
            if (step !is BackfillStep.Progress) {
                assertEquals(BackfillStep.Complete, step)
                break
            }
            steps++
            requests += step.requests
        }

        val calls = rig.source.calls
        val tokens = calls.count { it.startsWith("token:") }
        val probes = calls.count { it.startsWith("read:") && it.split(':')[2] == "0" }
        val monthReads = calls.count { it.startsWith("read:") && it.split(':')[2] != "0" }
        val aggregates = calls.count { it.startsWith("aggregate:") }
        // The figures quoted for this shape of history. Health Connect: a token per type; one
        // probe per type and a second for each type that has records; one read per type-month
        // with records (more only when a month has over a page); one aggregate per type-month
        // of the types that have platform totals. The server: one upload per page.
        assertEquals(41, tokens)
        assertEquals(41 + 8, probes)
        assertEquals(8 * months, monthReads)
        assertEquals(5 * months, aggregates)
        assertEquals(8 * months, rig.transport.data.size)
        assertEquals(rig.transport.sent.size, requests)
        assertEquals(41 + 8 * months, steps)
        assertEquals(41 + 49 + 296 + 185, calls.size)
        assertEquals((8 * months).toLong(), active.sumOf { rig.type(it).uploaded })
        // Not one request for a type-month with nothing in it: the 33 unused types cost a token
        // and a probe each, and that is all.
        assertEquals(33, all.count { type -> type !in active && calls.count { it.startsWith("read:$type:") } == 1 })
    }

    // --- pacing ------------------------------------------------------------------------------------

    @Test
    fun `a step reports every request it made, so each one can be paced`() = runTest {
        val rig = Rig(types = listOf("HeartRate"), limits = BatchLimits(targetItems = 2))
        rig.source.add("HeartRate", *(0 until 5).map { hr("r$it", NOW - 5000 + it) }.toTypedArray())
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        assertEquals(BackfillStep.Progress(uploaded = false, requests = 0), rig.engine.backfillStep(rig.session(), run))
        // One page, three batches: three requests against the server's per-minute limit.
        assertEquals(BackfillStep.Progress(uploaded = true, requests = 3), rig.engine.backfillStep(rig.session(), run))
        assertEquals(3, rig.transport.data.size)
    }

    // --- memory: the size of a page ---------------------------------------------------------------------

    @Test
    fun `the page size follows what the records weigh`() {
        val pages = PageSizer()
        // Nothing known about the type: a cautious size, growing in steps while pages are light.
        assertEquals(200, pages.size("Steps"))
        pages.measured("Steps", count = 200, bytes = 200 * 300L)
        assertEquals(800, pages.size("Steps"))
        pages.measured("Steps", count = 800, bytes = 800 * 300L)
        assertEquals(1000, pages.size("Steps"))

        // The record the range probe read anyway is the first guess: a light one means full pages
        // from the start, a session with its route means one at a time until pages are weighed.
        pages.seed("Weight", recordBytes = 300)
        assertEquals(1000, pages.size("Weight"))
        pages.seed("ExerciseSession", recordBytes = 600_000)
        assertEquals(1, pages.size("ExerciseSession"))
        pages.measured("ExerciseSession", count = 1, bytes = 500_000)
        assertEquals(4, pages.size("ExerciseSession"))
        // Half a megabyte each: eight to a page keeps a page near 4 MiB.
        pages.measured("ExerciseSession", count = 4, bytes = 4 * 500_000L)
        assertEquals(8, pages.size("ExerciseSession"))
        pages.measured("ExerciseSession", count = 8, bytes = 8 * 500_000L)
        assertEquals(8, pages.size("ExerciseSession"))
        // One record bigger than a whole page's budget still gets read, alone.
        pages.measured("ExerciseSession", count = 8, bytes = 8 * 50_000_000L)
        assertEquals(1, pages.size("ExerciseSession"))
        // An empty page says nothing, and a seed does not overrule what pages have shown.
        pages.measured("ExerciseSession", count = 0, bytes = 0)
        pages.seed("ExerciseSession", recordBytes = 100)
        assertEquals(1, pages.size("ExerciseSession"))
        // One type's records say nothing about another's.
        assertEquals(1000, pages.size("Steps"))

        assertTrue(pages.shrink("Steps", from = 1000))
        assertEquals(125, pages.size("Steps"))
        assertTrue(pages.shrink("Steps", from = 125))
        assertTrue(pages.shrink("Steps", from = 15))
        assertEquals(1, pages.size("Steps"))
        assertFalse(pages.shrink("Steps", from = 1))
    }

    private fun tooLarge() = HealthSourceException(HealthSourceException.Kind.TRANSIENT, HealthConnectSource.ERROR_PAGE_TOO_LARGE)

    @Test
    fun `a page too large to hold is read again smaller, at once, and nothing is skipped`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.source.honourPageSize = true
        rig.source.add("HeartRate", *(0 until 60).map { hr("r$it", NOW - 60_000 + it) }.toTypedArray())
        // What an exhausted heap looks like from here: any page of more than thirty fails.
        rig.source.readFailure = { _, size -> if (size > 30) tooLarge() else null }
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        val (end, backoffs) = rig.drive(run)
        assertEquals(BackfillStep.Complete, end)
        // No wait and no strike against the type: the retry is immediate.
        assertEquals(0, backoffs)
        assertTrue(run.skipped.isEmpty())
        assertEquals(60, rig.type("HeartRate").uploaded)
        assertEquals((0 until 60).map { "r$it" }, rig.transport.data.flatMap { it.upsertIds })
        // Probes ask for one. The month was asked for at the size its light records suggested,
        // then smaller until it fitted, and at that size to its end.
        assertEquals(listOf(1000, 125, 15, 15, 15, 15), rig.source.pageSizes.filter { it != 1 })
        assertNull(rig.type("HeartRate").backfillError)
        assertNull(rig.type("HeartRate").backfill.pageSize)
    }

    @Test
    fun `a month is read to its end at one page size, and starts over when that has to change`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.source.pageSize = 40
        rig.source.add("HeartRate", *(0 until 100).map { hr("r$it", NOW - 100_000 + it) }.toTypedArray())
        // The second page of the month does not fit, once.
        var failed = false
        rig.source.readFailure = { _, _ ->
            if (!failed && rig.source.calls.last().endsWith(":40")) tooLarge().also { failed = true } else null
        }
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        // Setup, then the first page: its token is stored with the size that produced it.
        repeat(2) { rig.engine.backfillStep(rig.session(), run) }
        assertEquals("40", rig.type("HeartRate").backfill.pageToken)
        assertEquals(1000, rig.type("HeartRate").backfill.pageSize)

        // The failed page: the month goes back to its first page, to be read at a smaller size.
        assertEquals(BackfillStep.Progress(uploaded = false), rig.engine.backfillStep(rig.session(), run))
        assertNull(rig.type("HeartRate").backfill.pageToken)
        assertNull(rig.type("HeartRate").backfill.pageSize)

        assertEquals(BackfillStep.Complete, rig.drive(run).first)
        // Never a token from one size handed back with another.
        assertEquals(listOf(1000, 1000, 125, 125, 125), rig.source.pageSizes.filter { it != 1 })
        // The first page went twice, which the server takes as the same records; nothing is missing.
        assertEquals(4, rig.transport.data.size)
        assertEquals((0 until 100).map { "r$it" }.toSet(), rig.transport.data.flatMap { it.upsertIds }.toSet())
        assertEquals(rig.transport.data[0].upsertIds, rig.transport.data[1].upsertIds)
    }

    @Test
    fun `a session resumed part-way through a month keeps the page size the month was started with`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.source.pageSize = 2
        rig.source.add("HeartRate", *(0 until 5).map { hr("r$it", NOW - 5_000 + it) }.toTypedArray())
        rig.engine.requestBackfill(rig.session())
        val first = BackfillRun()
        repeat(2) { rig.engine.backfillStep(rig.session(), first) }
        assertEquals("2", rig.type("HeartRate").backfill.pageToken)
        assertEquals(1000, rig.type("HeartRate").backfill.pageSize)
        // "Process death": a new session knows nothing of the type's sizes, and must not guess.
        assertEquals(BackfillStep.Complete, rig.drive(BackfillRun()).first)
        assertEquals(listOf(1000, 1000, 1000), rig.source.pageSizes.filter { it != 1 })

        // A cursor left mid-month by a build that did not store the size was read at its default.
        rig.store.updateType("HeartRate") {
            it.copy(backfill = it.backfill.copy(complete = false, pageToken = "2", pageSize = null))
        }
        rig.source.pageSizes.clear()
        assertEquals(BackfillStep.Complete, rig.drive(BackfillRun()).first)
        assertEquals(HealthSource.DEFAULT_PAGE_SIZE, rig.source.pageSizes.first())
    }

    @Test
    fun `a read that keeps failing is tried smaller before the type is set aside`() = runTest {
        val rig = Rig(types = listOf("Steps", "HeartRate"))
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        rig.source.add("Steps", record("s", start = NOW - 1000))
        // Probes (one record) work; every larger page fails, as if on its size.
        rig.source.readFailure = { type, size ->
            if (type == "HeartRate" && size > 1) HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote") else null
        }
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        // Twice as it was at each size (Health Connect does stumble), then smaller; at one
        // record a page it works, and the type finishes after all.
        val (done, waits) = rig.drive(run)
        assertEquals(BackfillStep.Complete, done)
        assertEquals(3 * SyncEngine.SHRINK_AFTER_STRIKES, waits)
        assertEquals(1, rig.type("HeartRate").uploaded)

        // A type that fails at every size, down to one, is set aside as before.
        val stuck = Rig(types = listOf("Steps", "HeartRate"))
        stuck.source.add("HeartRate", hr("a", NOW - 1000))
        stuck.source.add("Steps", record("s", start = NOW - 1000))
        var broken = false
        stuck.source.readFailure = { type, _ ->
            if (type == "HeartRate" && broken) HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote") else null
        }
        stuck.engine.requestBackfill(stuck.session())
        val stuckRun = BackfillRun()
        // Let both ranges be measured, then fail every read of the type.
        repeat(2) { stuck.engine.backfillStep(stuck.session(), stuckRun) }
        broken = true
        val (end, backoffs) = stuck.drive(stuckRun)
        assertEquals(BackfillStep.Incomplete("hc_remote"), end)
        assertEquals(3 * SyncEngine.SHRINK_AFTER_STRIKES + SyncEngine.MAX_TRANSIENT_STRIKES - 1, backoffs)
        assertTrue(stuck.type("Steps").backfill.complete)
        assertFalse(stuck.type("HeartRate").backfill.complete)
    }

    // --- platform totals ---------------------------------------------------------------------------------

    @Test
    fun `a record that runs into a month with nothing of its own still gets that month's totals`() = runTest {
        val rig = Rig(types = listOf("SleepSession"))
        // Asleep across the turn of the month, and nothing else this month.
        val start = thisMonth - 2 * Hours.MS
        rig.source.add("SleepSession", record("night", type = "SleepSession", start = start, end = thisMonth + 3 * Hours.MS))
        rig.source.total(AggMetric.SLEEP_DURATION, thisMonth - Hours.MS, 3_600_000.0, "com.example.wearable")
        rig.source.total(AggMetric.SLEEP_DURATION, thisMonth + Hours.MS, 3_600_000.0, "com.example.wearable")
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)
        val ids = rig.transport.data.flatMap { it.upsertIds }
        assertTrue("agg:SleepDuration:${thisMonth - Hours.MS}" in ids)
        // The hour that lies in the skipped month.
        assertTrue("agg:SleepDuration:${thisMonth + Hours.MS}" in ids)
        assertTrue(rig.transport.data.all { it.deletes.isEmpty() })
    }

    @Test
    fun `a re-run takes away the totals of hours that have none any more`() = runTest {
        val rig = Rig(types = listOf("Steps", "HeartRate"))
        val kept = Hours.floor(NOW - 2 * Hours.MS)
        val gone = lastMonth + 5 * Hours.MS
        rig.source.add("Steps", record("today", start = kept + 1), record("then", start = gone + 1))
        rig.source.add("HeartRate", hr("h", NOW - 1000))
        rig.source.total(AggMetric.STEPS, kept, 42.0, "com.example.phone")
        rig.source.total(AggMetric.STEPS, gone, 7.0, "com.example.phone")

        // The first backfill only adds.
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)
        assertTrue(rig.transport.data.all { it.deletes.isEmpty() })
        assertTrue("agg:Steps:$gone" in rig.transport.data.flatMap { it.upsertIds })
        assertFalse(rig.type("Steps").backfill.rerun)

        // Last month's record is deleted in Health Connect at a moment incremental sync missed,
        // so the server still holds its hourly total.
        rig.source.records.getValue("Steps").removeIf { it.getValue("id").toString() == "\"then\"" }
        rig.source.aggregates.getValue(AggMetric.STEPS).remove(gone)
        rig.transport.sent.clear()
        rig.source.calls.clear()

        // The owner runs the full backfill again.
        rig.engine.requestBackfill(rig.session())
        assertTrue(rig.type("Steps").backfill.rerun)
        assertEquals(BackfillStep.Complete, rig.drive().first)
        val deletes = rig.transport.data.flatMap { it.deletes }
        val upserts = rig.transport.data.flatMap { it.upsertIds }
        // The stale hour goes, in a month that now has no record at all and is walked anyway.
        assertTrue("agg:Steps:$gone" in deletes)
        assertTrue("read:Steps:$lastMonth:$thisMonth:-" in rig.source.calls)
        // The hour that still has a total is sent, not deleted.
        assertTrue("agg:Steps:$kept" in upserts)
        assertFalse("agg:Steps:$kept" in deletes)
        // Every hour of both months is accounted for: a total or a delete, never neither.
        val hours = (Hours.covering(lastMonth, Months.next(thisMonth))).count()
        assertEquals(hours - 1, deletes.size)
        assertTrue(deletes.all { it.startsWith("agg:Steps:") })
        // Deletes of the phone's own totals are not records: the count is the records'.
        assertEquals(1, rig.type("Steps").uploaded)
        // A type without platform totals has nothing to take away.
        assertTrue(rig.transport.data.filter { "h" in it.upsertIds }.all { it.deletes.isEmpty() })
        assertTrue(rig.type("Steps").backfill.complete)
    }

    @Test
    fun `a re-run of a type that has lost every record still clears what the earlier run uploaded`() = runTest {
        val rig = Rig(types = listOf("Steps"))
        val hour = lastMonth + 5 * Hours.MS
        rig.source.add("Steps", record("then", start = hour + 1))
        rig.source.total(AggMetric.STEPS, hour, 7.0, "com.example.phone")
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)

        rig.source.records.getValue("Steps").clear()
        rig.source.aggregates.getValue(AggMetric.STEPS).clear()
        rig.transport.sent.clear()
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)
        val deletes = rig.transport.data.flatMap { it.deletes }
        assertTrue("agg:Steps:$hour" in deletes)
        assertTrue(rig.transport.data.all { it.upserts.isEmpty() })
        assertEquals(0, rig.type("Steps").uploaded)

        // And the re-run after that walks the same range again rather than forgetting it.
        rig.transport.sent.clear()
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)
        assertTrue("agg:Steps:$hour" in rig.transport.data.flatMap { it.deletes })
    }
}
