package dev.maxhogan.healthy.companion.sync

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.long
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import dev.maxhogan.healthy.companion.hc.Grant
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BackfillTest {
    private val thisMonth = Months.floor(NOW)
    private val lastMonth = Months.previous(thisMonth)
    private val twoBack = Months.previous(lastMonth)
    private val threeBack = Months.previous(twoBack)

    private fun rig() = Rig(types = listOf("Steps", "HeartRate"))

    private fun hr(id: String, start: Long) = record(id, type = "HeartRate", start = start)

    /** The months a type was read for, in the order they were read (range probes left out). */
    private fun monthsRead(rig: Rig, type: String): List<Long> =
        rig.source.calls.filter { it.startsWith("read:$type:") }
            .map { it.split(':')[2].toLong() }
            .filter { it != 0L }

    @Test
    fun `the changes token is taken before the first read of history`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        assertEquals(BackfillStep.Complete, rig.backfill())
        val calls = rig.source.calls
        assertTrue(calls.indexOf("token:HeartRate") in 0 until calls.indexOfFirst { it.startsWith("read:HeartRate") })
        assertTrue(calls.indexOf("token:Steps") in 0 until calls.indexOfFirst { it.startsWith("read:Steps") })
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    @Test
    fun `months are read newest first, down to the month of the oldest record`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("mid", lastMonth + 5 * Hours.MS), hr("old", threeBack + Hours.MS))
        assertEquals(BackfillStep.Complete, rig.backfill())

        assertEquals(listOf(thisMonth, lastMonth, twoBack, threeBack), monthsRead(rig, "HeartRate"))
        assertEquals(listOf(listOf("now"), listOf("mid"), listOf("old")), rig.transport.data.map { it.upsertIds })
        val backfill = rig.type("HeartRate").backfill
        assertTrue(backfill.complete)
        assertEquals(threeBack, backfill.oldestDoneMs)
        assertEquals(threeBack, backfill.floorMonthMs)
        assertEquals(thisMonth, backfill.topMonthMs)
        assertEquals(3, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `a record on a month boundary belongs to the month that starts there`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("first-instant", lastMonth), hr("last-instant", lastMonth - 1))
        assertEquals(BackfillStep.Complete, rig.backfill())
        assertEquals(listOf(thisMonth, lastMonth, twoBack), monthsRead(rig, "HeartRate"))
        assertEquals(listOf(listOf("first-instant"), listOf("last-instant")), rig.transport.data.map { it.upsertIds })
        // Each month is asked for as [its first instant, the next month's first instant).
        assertTrue("read:HeartRate:$lastMonth:$thisMonth:-" in rig.source.calls)
    }

    @Test
    fun `a record dated in the future is not left out`() = runTest {
        val rig = rig()
        val nextMonth = Months.next(thisMonth)
        rig.source.add("HeartRate", hr("planned", nextMonth + Hours.MS), hr("now", NOW))
        assertEquals(BackfillStep.Complete, rig.backfill())
        assertEquals(listOf(nextMonth, thisMonth), monthsRead(rig, "HeartRate"))
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `a type with no records is complete at once`() = runTest {
        val rig = rig()
        assertEquals(BackfillStep.Complete, rig.backfill())
        assertTrue(rig.type("Steps").backfill.complete)
        assertTrue(rig.transport.data.isEmpty())
        assertTrue(rig.store.snapshot().global.backfillRequested)
    }

    @Test
    fun `the cursor moves page by page and a failed page is resumed, not restarted`() = runTest {
        val rig = rig()
        rig.source.pageSize = 2
        rig.source.add("HeartRate", *(0 until 5).map { hr("r$it", thisMonth + it * Hours.MS) }.toTypedArray())
        rig.transport.rule = { if ("r2" in it.upsertIds) FakeTransport.status(500, "oops") else null }

        assertEquals(BackfillStep.Backoff("http_500"), rig.backfill())
        val paused = rig.type("HeartRate")
        assertEquals("2", paused.backfill.pageToken)
        assertEquals(thisMonth, paused.backfill.monthMs)
        assertEquals(2, paused.uploaded)
        assertEquals(2, paused.backlog)
        assertFalse(paused.backfill.complete)

        // "Process death": a new session against the same store.
        rig.transport.rule = { null }
        rig.transport.sent.clear()
        rig.source.calls.clear()
        assertEquals(BackfillStep.Complete, rig.backfill(BackfillRun()))
        assertEquals("read:HeartRate:$thisMonth:${Months.next(thisMonth)}:2", rig.source.calls.first { it.startsWith("read:HeartRate") })
        assertEquals(listOf(listOf("r2", "r3"), listOf("r4")), rig.transport.data.map { it.upsertIds })
        assertEquals(5, rig.type("HeartRate").uploaded)
        assertNull(rig.type("HeartRate").backfill.pageToken)
    }

    @Test
    fun `a quota error backs off and resumes, never abandoning the backfill`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000), hr("b", lastMonth + 1))
        val run = BackfillRun()
        rig.engine.requestBackfill(rig.session())
        var backoffs = 0
        var steps = 0
        while (true) {
            if (steps++ == 2) {
                repeat(3) {
                    rig.source.failNext.add(HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited"))
                }
            }
            when (val step = rig.engine.backfillStep(rig.session(), run)) {
                is BackfillStep.Progress -> Unit
                is BackfillStep.Backoff -> {
                    assertEquals("hc_rate_limited", step.errorCode)
                    backoffs++
                    // What the service loop does with a backoff: it waits it out.
                    rig.now += step.retryAfterMs ?: 0
                }
                else -> {
                    assertEquals(BackfillStep.Complete, step)
                    break
                }
            }
        }
        assertEquals(3, backoffs)
        assertTrue(run.skipped.isEmpty())
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `a type the platform refuses is set aside and the others finish`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        rig.source.failing["Steps"] = HealthSourceException(HealthSourceException.Kind.PERMISSION, "permission_denied")
        val run = BackfillRun()
        assertEquals(BackfillStep.Incomplete("permission_denied"), rig.backfill(run))
        assertEquals(mapOf("Steps" to "permission_denied"), run.skipped.toMap())
        assertTrue(rig.type("HeartRate").backfill.complete)
        assertFalse(rig.type("Steps").backfill.complete)
        assertEquals("permission_denied", rig.type("Steps").lastError?.errorCode)
    }

    @Test
    fun `a type that keeps hitting a platform error is set aside after a few tries`() = runTest {
        val rig = rig()
        rig.source.add("Steps", record("s", start = NOW - 1000))
        rig.source.failing["HeartRate"] = HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote")
        val run = BackfillRun()
        rig.engine.requestBackfill(rig.session())
        var backoffs = 0
        var last: BackfillStep
        do {
            last = rig.engine.backfillStep(rig.session(), run)
            if (last is BackfillStep.Backoff) backoffs++
        } while (last is BackfillStep.Progress || last is BackfillStep.Backoff)
        assertEquals(BackfillStep.Incomplete("hc_remote"), last)
        assertEquals(SyncEngine.MAX_TRANSIENT_STRIKES - 1, backoffs)
        assertTrue(rig.type("Steps").backfill.complete)
        assertEquals("hc_remote", rig.type("HeartRate").lastError?.errorCode)
    }

    @Test
    fun `each finished month of a cumulative type carries its platform totals`() = runTest {
        val rig = rig()
        val hour = Hours.floor(NOW - 2 * Hours.MS)
        rig.source.add("Steps", record("walk", start = hour + 1))
        rig.source.total(AggMetric.STEPS, hour, 42.0, "com.example.phone")
        assertEquals(BackfillStep.Complete, rig.backfill())

        assertEquals(listOf(Triple(AggMetric.STEPS, thisMonth, Months.next(thisMonth))), rig.source.aggregateRequests)
        val batch = rig.transport.data.single()
        assertEquals(listOf("walk", "agg:Steps:$hour"), batch.upsertIds)
        // A backfill only adds: it sends no delete for the hours that have no total.
        assertTrue(batch.deletes.isEmpty())
        assertEquals(1, rig.type("Steps").uploaded)
    }

    @Test
    fun `progress counts months across types and is unknown until every range is measured`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("old", threeBack + 1))
        rig.source.add("Steps", record("s", start = lastMonth + 1))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()

        var progress = SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = true)
        assertEquals(BackfillPhase.RUNNING, progress.phase)
        assertNull(progress.totalUnits)

        rig.engine.backfillStep(rig.session(), run)
        rig.engine.backfillStep(rig.session(), run)
        progress = SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false)
        assertEquals(BackfillPhase.PAUSED, progress.phase)
        assertEquals(4 + 2, progress.totalUnits)
        assertEquals(0, progress.doneUnits)

        while (rig.engine.backfillStep(rig.session(), run) is BackfillStep.Progress) {
            // Keep stepping.
        }
        progress = SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false)
        assertEquals(BackfillPhase.COMPLETE, progress.phase)
        assertEquals(6, progress.doneUnits)
        assertEquals(threeBack, progress.oldestDoneMs)
        assertEquals(Instant.ofEpochMilli(thisMonth), Instant.ofEpochMilli(rig.type("Steps").backfill.topMonthMs!!))
    }

    @Test
    fun `incremental sync still runs between backfill steps`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("old", lastMonth + 1), hr("now", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        repeat(3) { rig.engine.backfillStep(rig.session(), run) }
        rig.source.changePages["HeartRate#1"] =
            ChangesPage(listOf(HcChange.Upsert(hr("fresh", NOW))), "HeartRate#2", hasMore = false, expired = false)
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        while (rig.engine.backfillStep(rig.session(), run) is BackfillStep.Progress) {
            // Keep stepping.
        }
        assertTrue(rig.type("HeartRate").backfill.complete)
        assertEquals(3, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `history granted after a backfill without it is fetched without anyone asking again`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.access = access("Steps", "HeartRate", history = Grant.DENIED)
        rig.source.add("HeartRate", hr("recent", NOW - 1000))
        assertEquals(BackfillStep.Complete, rig.backfill())
        assertFalse(rig.type("HeartRate").backfill.fullHistory)
        assertTrue(SyncStateReport.backfillComplete(types, rig.access, rig.store.snapshot()))
        assertEquals(BackfillPhase.COMPLETE, SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false).phase)
        assertFalse(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))

        // The owner grants history in Health Connect. Older records are now readable.
        rig.access = access("Steps", "HeartRate")
        rig.source.add("HeartRate", hr("old", threeBack + 1))

        // What the controller acts on: no longer complete, so the button is live again and the
        // periodic worker restarts the service ...
        assertFalse(SyncStateReport.backfillComplete(types, rig.access, rig.store.snapshot()))
        assertEquals(BackfillPhase.PAUSED, SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false).phase)
        assertTrue(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))

        // ... whose loop only ever calls backfillStep. No requestBackfill here, on purpose.
        val run = BackfillRun()
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Complete, step)
        val backfill = rig.type("HeartRate").backfill
        assertTrue(backfill.fullHistory)
        assertEquals(threeBack, backfill.oldestDoneMs)
        assertTrue("old" in rig.transport.data.flatMap { it.upsertIds })
        assertTrue(SyncStateReport.backfillComplete(types, rig.access, rig.store.snapshot()))
        assertFalse(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))
    }

    @Test
    fun `a backfill that is done with full history is not restarted`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        assertEquals(BackfillStep.Complete, rig.backfill())
        val reads = rig.source.calls.size
        assertEquals(BackfillStep.Complete, rig.engine.backfillStep(rig.session(), BackfillRun()))
        assertEquals(reads, rig.source.calls.size)
    }

    @Test
    fun `backfill in the background without the background-read grant reads nothing and moves no cursor`() = runTest {
        val rig = rig()
        rig.source.pageSize = 1
        rig.source.add("HeartRate", hr("a", NOW - 2000), hr("b", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        repeat(3) { rig.engine.backfillStep(rig.session(), run) }
        val before = rig.store.snapshot().types
        val reads = rig.source.calls.size
        val posts = rig.transport.sent.size

        rig.access = access("Steps", "HeartRate", background = Grant.DENIED)
        rig.foreground = false
        assertEquals(BackfillStep.Incomplete("background_read_missing"), rig.engine.backfillStep(rig.session(), run))
        assertEquals(before, rig.store.snapshot().types)
        assertEquals(reads, rig.source.calls.size)
        assertEquals(posts, rig.transport.sent.size)
        assertEquals("background_read_missing", rig.store.snapshot().global.skipReason?.errorCode)
        assertNull(rig.store.snapshot().global.lastError)
        assertFalse(SyncUiStates.shouldResumeBackfill(listOf("Steps", "HeartRate"), rig.session(), rig.store.snapshot()))

        // Back on screen, it carries on from the same page.
        rig.foreground = true
        assertEquals(BackfillStep.Complete, rig.backfill(run))
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `an oversize record in history is stubbed and the backfill finishes`() = runTest {
        val rig = Rig(types = listOf("HeartRate"), limits = BatchLimits(hardGzipBytes = 1_000_000, hardRawBytes = 9_000))
        rig.source.add(
            "HeartRate",
            hr("a", NOW - 3000),
            record("huge", type = "HeartRate", start = NOW - 2000, padding = "x".repeat(12_000)),
        )
        assertEquals(BackfillStep.Complete, rig.backfill())
        val state = rig.type("HeartRate")
        assertTrue(state.backfill.complete)
        assertEquals(1, state.uploaded)
        assertEquals(1, state.stubbed)
        assertEquals("record_oversize_stubbed", state.lastError?.errorCode)
    }

    @Test
    fun `asking for a full backfill again after it completed re-reads and re-uploads everything`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("old", twoBack + 1))
        rig.source.add("Steps", record("s", start = lastMonth + 1))
        assertEquals(BackfillStep.Complete, rig.backfill())
        // Something incremental has happened since, so the token is no longer the first one.
        rig.source.changePages["HeartRate#1"] =
            ChangesPage(listOf(HcChange.Upsert(hr("fresh", NOW))), "HeartRate#2", hasMore = false, expired = false)
        rig.sync()
        assertEquals(BackfillPhase.COMPLETE, SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false).phase)
        val tokens = types.associateWith { rig.type(it).token }
        val uploaded = rig.type("HeartRate").uploaded
        rig.transport.sent.clear()
        rig.source.calls.clear()

        // What the confirmed "Run full backfill again" button does: startBackfill -> requestBackfill.
        rig.engine.requestBackfill(rig.session())
        val reset = rig.store.snapshot()
        assertTrue(reset.global.backfillRequested)
        assertTrue(types.all { !reset.type(it).backfill.started && !reset.type(it).backfill.complete })
        assertEquals(tokens, types.associateWith { reset.type(it).token })
        assertEquals(BackfillPhase.PAUSED, SyncUiStates.progress(types, rig.access, reset, running = false).phase)
        assertTrue(SyncUiStates.shouldResumeBackfill(types, rig.session(), reset))

        val run = BackfillRun()
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Complete, step)
        assertEquals(setOf("now", "old", "s"), rig.transport.data.flatMap { it.upsertIds }.filter { !it.startsWith("agg:") }.toSet())
        // No new changes token was taken, and nothing incremental was re-read.
        assertTrue(rig.source.calls.none { it.startsWith("token:") || it.startsWith("changes:") })
        assertEquals(tokens, types.associateWith { rig.type(it).token })
        // The counts start again with the cursor, so re-uploading does not count records twice.
        assertTrue(uploaded > 2)
        assertEquals(2, rig.type("HeartRate").uploaded)
        assertEquals(twoBack + 1, rig.type("HeartRate").firstMs)
        assertEquals(BackfillPhase.COMPLETE, SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false).phase)
    }

    @Test
    fun `asking again while a backfill is unfinished resumes it instead of starting over`() = runTest {
        val rig = rig()
        rig.source.pageSize = 1
        rig.source.add("HeartRate", hr("a", NOW - 2000), hr("b", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        repeat(3) { rig.engine.backfillStep(rig.session(), run) }
        val cursor = rig.type("HeartRate").backfill
        assertTrue(cursor.started && !cursor.complete)
        rig.engine.requestBackfill(rig.session())
        assertEquals(cursor, rig.type("HeartRate").backfill)
    }

    @Test
    fun `a backfill that is waiting to retry says so, with the real error and the retry time`() = runTest {
        val rig = rig()
        rig.source.pageSize = 1
        rig.source.add("HeartRate", hr("a", NOW - 2000), hr("b", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        rig.transport.rule = FakeTransport.offline
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Backoff("network"), step)

        // What the service loop does before it sleeps.
        rig.engine.noteBackfillWaiting("network", NOW + 40_000)
        val waiting = rig.store.snapshot()
        assertEquals(StoredError("network", NOW), waiting.global.lastError)
        assertEquals(NOW + 40_000, waiting.global.retryAtMs)
        val types = listOf("Steps", "HeartRate")
        val live = SyncUiStates.Live(access = rig.access, backfilling = true)
        val ui = SyncUiStates.build(types, PairingState.Paired(PAIRING.url, DEVICE), false, waiting, live, nowMs = NOW)
        // Once the moment has passed, or nothing is running to make the retry, it is not shown.
        assertNull(SyncUiStates.build(types, PairingState.NotPaired, false, waiting, live, nowMs = NOW + 40_000).lastError?.retryAtMs)
        assertNull(SyncUiStates.build(types, PairingState.NotPaired, false, waiting, live.copy(backfilling = false), nowMs = NOW).lastError?.retryAtMs)
        assertEquals(SyncActivity.BACKFILLING, ui.activity)
        assertEquals("network", ui.lastError?.errorCode)
        assertEquals(NOW + 40_000, ui.lastError?.retryAtMs)
        val report = SyncStateReport.build(types, rig.access, waiting, FACTS, NOW).getValue("lastError").jsonObject
        assertEquals("network", report.getValue("errorCode").jsonPrimitive.content)
        assertEquals(NOW + 40_000, report.getValue("retryAt").jsonPrimitive.long)
        assertNull(WireContract.envelopeProblem(kotlinx.serialization.json.buildJsonObject {
            put("v", kotlinx.serialization.json.JsonPrimitive(1))
            put("deviceId", kotlinx.serialization.json.JsonPrimitive(DEVICE))
            put("appVersion", kotlinx.serialization.json.JsonPrimitive("0.1.0"))
            put("batchId", kotlinx.serialization.json.JsonPrimitive("fixture-0001"))
            put("phoneTime", kotlinx.serialization.json.JsonPrimitive(NOW))
            put("syncState", SyncStateReport.build(types, rig.access, waiting, FACTS, NOW))
        }))

        // The connection is back: the next step that gets through clears it.
        rig.transport.rule = { null }
        assertTrue(rig.engine.backfillStep(rig.session(), run) is BackfillStep.Progress)
        val recovered = rig.store.snapshot().global
        assertNull(recovered.lastError)
        assertNull(recovered.retryAtMs)
        assertEquals(BackfillStep.Complete, rig.backfill(run))
    }

    @OptIn(ExperimentalCoroutinesApi::class) // the test scheduler's virtual clock
    @Test
    fun `the network coming back ends a network backoff at once, and nothing else`() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)

        // No signal: the whole wait.
        var started = testScheduler.currentTime
        assertFalse(awaitRetry(900_000, wake, interruptible = true))
        assertEquals(900_000, testScheduler.currentTime - started)

        // The network returns two seconds in.
        started = testScheduler.currentTime
        launch {
            delay(2_000)
            wake.trySend(Unit)
        }
        assertTrue(awaitRetry(900_000, wake, interruptible = true))
        assertEquals(2_000, testScheduler.currentTime - started)

        // A server that asked for time is given all of it, whatever the network does.
        started = testScheduler.currentTime
        wake.trySend(Unit)
        assertFalse(awaitRetry(30_000, wake, interruptible = false))
        assertEquals(30_000, testScheduler.currentTime - started)
    }

    @Test
    fun `history withdrawn part-way is not mistaken for a finished backfill`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.source.add("HeartRate", hr("now", NOW - 1000), hr("old", threeBack + 1))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        // Setup of both types, then the newest month of HeartRate.
        repeat(3) { rig.engine.backfillStep(rig.session(), run) }
        assertTrue(rig.type("HeartRate").backfill.fullHistory)

        // History is revoked: the platform now hides everything older than a month.
        rig.access = access("Steps", "HeartRate", history = Grant.DENIED)
        val hidden = rig.source.records.getValue("HeartRate").removeAt(1)
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Complete, step)
        val partial = rig.type("HeartRate").backfill
        assertTrue(partial.complete)
        assertFalse(partial.fullHistory)
        assertEquals(1, rig.type("HeartRate").uploaded)

        // Re-granted: the gap is known, so the type starts over and the old record arrives.
        rig.access = access("Steps", "HeartRate")
        rig.source.records.getValue("HeartRate").add(hidden)
        assertFalse(SyncStateReport.backfillComplete(types, rig.access, rig.store.snapshot()))
        val again = BackfillRun()
        do {
            step = rig.engine.backfillStep(rig.session(), again)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Complete, step)
        assertTrue("old" in rig.transport.data.flatMap { it.upsertIds })
        assertTrue(rig.type("HeartRate").backfill.fullHistory)
    }

    @Test
    fun `a type that finished with full history is not redone because history was later withdrawn`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        assertEquals(BackfillStep.Complete, rig.backfill())
        rig.access = access("Steps", "HeartRate", history = Grant.DENIED)
        assertEquals(BackfillStep.Complete, rig.engine.backfillStep(rig.session(), BackfillRun()))
        assertTrue(rig.type("HeartRate").backfill.fullHistory)
        rig.access = access("Steps", "HeartRate")
        val reads = rig.source.calls.size
        assertEquals(BackfillStep.Complete, rig.engine.backfillStep(rig.session(), BackfillRun()))
        assertEquals(reads, rig.source.calls.size)
    }

    @Test
    fun `why a type's backfill stopped outlives its next good incremental sync`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.source.pageSize = 1
        rig.source.add("HeartRate", hr("a", NOW - 2000), hr("b", NOW - 1000))
        rig.source.refusePageTokens.add("HeartRate")
        val run = BackfillRun()
        assertEquals(BackfillStep.Incomplete("page_token_invalid"), rig.backfill(run))
        assertEquals("page_token_invalid", rig.type("HeartRate").backfillError?.errorCode)

        // Incremental sync of the same type is fine, and clears only its own error.
        rig.now += 60_000
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.type("HeartRate").lastError)
        assertEquals("page_token_invalid", rig.type("HeartRate").backfillError?.errorCode)
        val progress = SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false)
        assertEquals(BackfillPhase.PAUSED, progress.phase)
        assertEquals("page_token_invalid", progress.errorCode)
        val reported = SyncStateReport.build(types, rig.access, rig.store.snapshot(), FACTS, rig.now)
            .getValue("types").jsonArray.map { it.jsonObject }.single { it.getValue("type").jsonPrimitive.content == "HeartRate" }
        assertEquals("page_token_invalid", reported.getValue("backfill").jsonObject.getValue("errorCode").jsonPrimitive.content)

        // Only that type's backfill getting somewhere clears it.
        rig.source.refusePageTokens.clear()
        assertEquals(BackfillStep.Complete, rig.backfill(BackfillRun()))
        assertNull(rig.type("HeartRate").backfillError)
        assertNull(SyncUiStates.progress(types, rig.access, rig.store.snapshot(), running = false).errorCode)
    }

    @Test
    fun `a month whose page tokens keep being refused is restarted once, then the type is set aside`() = runTest {
        val rig = rig()
        rig.source.pageSize = 1
        rig.source.add("HeartRate", hr("a", NOW - 2000), hr("b", NOW - 1000))
        rig.source.add("Steps", record("s", start = NOW - 1000))
        rig.source.refusePageTokens.add("HeartRate")
        val run = BackfillRun()
        assertEquals(BackfillStep.Incomplete("page_token_invalid"), rig.backfill(run, maxSteps = 200))
        val month = Months.floor(NOW)
        val monthReads = rig.source.calls.count { it.startsWith("read:HeartRate:$month:") }
        // First page, refused, first page again, refused: then no more.
        assertEquals(4, monthReads)
        assertTrue(rig.type("Steps").backfill.complete)
        assertFalse(rig.type("HeartRate").backfill.complete)
    }

    @Test
    fun `a refused token or a backfill that gave up is not restarted by the periodic worker`() = runTest {
        val rig = rig()
        val types = listOf("Steps", "HeartRate")
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        assertTrue(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))

        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }
        val run = BackfillRun()
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.PairingRejected, step)
        // The latch is set: starting the service again would only be refused again.
        assertFalse(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))
        assertEquals(BackfillStep.PairingRejected, rig.engine.backfillStep(rig.session(), BackfillRun()))

        // Paired again, it may resume.
        rig.pairingGeneration += 1
        rig.transport.rule = { null }
        rig.sync()
        assertTrue(SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot()))
    }
}
