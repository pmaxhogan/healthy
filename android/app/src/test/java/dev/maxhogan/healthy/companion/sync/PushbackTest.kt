package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.ui.Format
import java.time.ZoneOffset
import kotlin.random.Random
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Not now" from Health Connect or from the server is one gate for the whole process: until the
 * moment it names, nobody asks again, nobody counts a failed sync for it, and the backfill's
 * "waiting to retry" stays on screen exactly as the backfill wrote it.
 */
class PushbackTest {
    private val limited = HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited")

    private fun hr(id: String, start: Long = NOW) = record(id, type = "HeartRate", start = start)

    private fun change(id: String, next: String) =
        ChangesPage(listOf(HcChange.Upsert(hr(id))), next, hasMore = false, expired = false)

    // --- Health Connect ---------------------------------------------------------------------------

    @Test
    fun `while Health Connect's limit is waited out no reader spends quota, and no failed sync is counted`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.failNext.add(limited)
        assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync())
        val reads = rig.source.calls.size
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)
        assertEquals("hc_rate_limited", rig.store.snapshot().global.lastError?.errorCode)

        // The periodic worker comes round again, and again: it reads nothing, it still tells the
        // server how the phone is, and the "syncs keep failing" count never moves.
        repeat(SyncNotifications.FAILURE_THRESHOLD + 1) {
            val posts = rig.transport.sent.size
            assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync())
            assertEquals(reads, rig.source.calls.size)
            assertEquals(posts + 1, rig.transport.sent.size)
            assertTrue(rig.transport.sent.last().isStateOnly)
        }
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)

        // The backfill is a reader too, and it is told how long is left.
        rig.engine.requestBackfill(rig.session())
        val step = rig.engine.backfillStep(rig.session(), BackfillRun())
        assertTrue(step is BackfillStep.Backoff)
        assertEquals("hc_rate_limited", (step as BackfillStep.Backoff).errorCode)
        assertTrue(step.retryAfterMs!! in 1..PushbackGate.BASE_MS)
        assertEquals(reads, rig.source.calls.size)

        // The moment comes: everybody reads again.
        rig.now += PushbackGate.BASE_MS
        assertEquals(RunResult.Success, rig.sync())
        assertTrue(rig.source.calls.size > reads)
        assertNull(rig.store.snapshot().global.lastError)
    }

    @Test
    fun `a sync that runs while the backfill waits out the limit leaves the waiting state alone`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        rig.source.failNext.add(limited)
        val step = rig.engine.backfillStep(rig.session(), run) as BackfillStep.Backoff
        assertEquals("hc_rate_limited", step.errorCode)
        // What the service loop does before it waits.
        val retryAt = rig.now + step.retryAfterMs!!
        rig.engine.noteBackfillWaiting(step.errorCode, retryAt)
        val waiting = rig.store.snapshot().global
        val reads = rig.source.calls.size

        rig.now += 1_000
        assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync())
        val after = rig.store.snapshot().global
        assertEquals(waiting.lastError, after.lastError)
        assertEquals(retryAt, after.retryAtMs)
        assertEquals(0, after.consecutiveFailures)
        assertEquals(reads, rig.source.calls.size)
        // And the server is told the same thing the screen says.
        val reported = rig.transport.sent.last().json.getValue("syncState").toString()
        assertTrue(reported.contains("\"retryAt\":$retryAt"))

        // The wait over, the backfill carries on and takes its own state down.
        rig.now = retryAt
        assertEquals(BackfillStep.Complete, rig.drive(run).first)
        assertNull(rig.store.snapshot().global.retryAtMs)
        assertNull(rig.store.snapshot().global.lastError)
    }

    @Test
    fun `no sync, failed or good, takes down a wait the backfill has put up`() = runTest {
        val rig = Rig()
        rig.sync()
        val retryAt = rig.now + 40_000
        rig.engine.noteBackfillWaiting("network", retryAt)
        val waiting = rig.store.snapshot().global

        // A real failure is counted, but the backfill's line stays.
        rig.transport.rule = FakeTransport.offline
        assertEquals(RunResult.Failed("network"), rig.sync())
        var global = rig.store.snapshot().global
        assertEquals(1, global.consecutiveFailures)
        assertEquals(waiting.lastError, global.lastError)
        assertEquals(retryAt, global.retryAtMs)

        // A good sync does not clear it either: the backfill is still waiting.
        rig.transport.rule = { null }
        rig.now += 1_000
        assertEquals(RunResult.Success, rig.sync())
        global = rig.store.snapshot().global
        assertEquals(0, global.consecutiveFailures)
        assertEquals(waiting.lastError, global.lastError)
        assertEquals(retryAt, global.retryAtMs)

        // Once the moment has passed the wait is nobody's (a service that died mid-wait), and
        // the next sync writes what it finds as before.
        rig.now = retryAt
        assertEquals(RunResult.Success, rig.sync())
        global = rig.store.snapshot().global
        assertNull(global.lastError)
        assertNull(global.retryAtMs)
    }

    // --- the server -----------------------------------------------------------------------------------

    @Test
    fun `a 429 closes the gate for everyone until the time the server named, and is not a failed sync`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.add("HeartRate", hr("old", NOW - 1000))
        rig.source.changePages["HeartRate#1"] = change("a", "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(429, "backlogged", retryAfterS = 600) }
        assertEquals(RunResult.Failed("backlogged", 600_000), rig.sync())
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)
        assertEquals("backlogged", rig.store.snapshot().global.lastError?.errorCode)

        // Until then nothing is sent, not even the state report, and nothing is read that could
        // not be delivered. However often the worker runs, it is not "three failures in a row".
        val posts = rig.transport.sent.size
        val reads = rig.source.calls.size
        repeat(SyncNotifications.FAILURE_THRESHOLD + 1) {
            rig.now += 60_000
            val result = rig.sync() as RunResult.Failed
            assertEquals("backlogged", result.errorCode)
            assertTrue(result.retryAfterMs!! in 1..600_000)
        }
        rig.engine.requestBackfill(rig.session())
        val step = rig.engine.backfillStep(rig.session(), BackfillRun()) as BackfillStep.Backoff
        assertEquals("backlogged", step.errorCode)
        assertNotNull(step.retryAfterMs)
        assertEquals(posts, rig.transport.sent.size)
        assertEquals(reads, rig.source.calls.size)
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)

        rig.now = NOW + 600_000
        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
    }

    @Test
    fun `a 503 that names a time is waited out too, but it is a failure`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = change("a", "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(503, "down", retryAfterS = 600) }
        assertEquals(RunResult.Failed("http_503", 600_000), rig.sync())
        assertEquals(1, rig.store.snapshot().global.consecutiveFailures)
        val posts = rig.transport.sent.size
        rig.now += 60_000
        assertEquals("http_503", (rig.sync() as RunResult.Failed).errorCode)
        assertEquals(posts, rig.transport.sent.size)
    }

    @Test
    fun `a backlogged server is asked again when it said, however many times in a row it says it`() {
        val backoff = Backoff(5_000, 15 * 60_000L, random = Random(3))
        // The server's own figure for a deep queue is thirty seconds.
        for (attempt in 0..40) {
            assertTrue(backfillWaitMs(backoff, attempt, retryAfterMs = 30_000) in 30_000..37_500)
        }
        // A failure that names no time still backs off, up to the cap.
        assertTrue(backfillWaitMs(backoff, 0, null) in 3_750..6_250)
        assertTrue(backfillWaitMs(backoff, 20, null) in 675_000..1_125_000)
    }

    // --- the gate itself ---------------------------------------------------------------------------------

    @Test
    fun `the gate waits longer for every refusal in a row, and forgets only after a run of passes`() {
        var now = NOW
        val gate = PushbackGate({ now })
        assertNull(gate.remainingMs())
        assertEquals(5_000, gate.close("hc_rate_limited", null))
        assertEquals(5_000L, gate.remainingMs())
        now += 4_999
        assertEquals(1L, gate.remainingMs())
        now += 1
        assertNull(gate.remainingMs())

        // One request through and refused again: the wait keeps growing.
        gate.passed()
        assertEquals(10_000, gate.close("hc_rate_limited", null))
        assertEquals(20_000, gate.close("hc_rate_limited", null))
        repeat(20) { gate.close("hc_rate_limited", null) }
        assertEquals(PushbackGate.CAP_MS, gate.close("hc_rate_limited", null))

        // A time that was named is taken as it is.
        assertEquals(30_000, gate.close("backlogged", 30_000))
        assertEquals("backlogged", gate.errorCode)

        now += PushbackGate.CAP_MS
        repeat(PushbackGate.PASSES_TO_RESET) { gate.passed() }
        assertEquals(5_000, gate.close("hc_rate_limited", null))
    }

    @Test
    fun `a clock that is set back cannot hold the gate shut`() {
        var now = NOW
        val gate = PushbackGate({ now })
        gate.close("hc_rate_limited", null)
        now -= 24 * Hours.MS
        assertNull(gate.remainingMs())
    }

    // --- waiting, and what is shown while waiting ---------------------------------------------------------

    @OptIn(ExperimentalCoroutinesApi::class) // the test scheduler's virtual clock
    @Test
    fun `a wait ends by the clock, so a phone that slept does not go on waiting past the time shown`() = runTest {
        val wake = Channel<Unit>(Channel.CONFLATED)
        val wait = 900_000L

        // Awake throughout: the clock and the timer agree, and the whole wait is waited.
        var started = testScheduler.currentTime
        assertFalse(awaitDeadline(NOW + wait, wait, wake, interruptible = false, now = { NOW + (testScheduler.currentTime - started) }))
        assertEquals(wait, testScheduler.currentTime - started)

        // The phone slept: the timer has counted fifteen seconds, the clock fifteen minutes.
        started = testScheduler.currentTime
        assertFalse(awaitDeadline(NOW + wait, wait, wake, interruptible = false, now = { NOW + (testScheduler.currentTime - started) * 60 }))
        assertEquals(15_000, testScheduler.currentTime - started)

        // The clock was set back a day: the wait is still only the wait.
        started = testScheduler.currentTime
        assertFalse(awaitDeadline(NOW + wait, wait, wake, interruptible = false, now = { NOW - 24 * Hours.MS }))
        assertEquals(wait, testScheduler.currentTime - started)

        // A lost connection coming back still cuts it short.
        started = testScheduler.currentTime
        launch {
            delay(40_000)
            wake.trySend(Unit)
        }
        assertTrue(awaitDeadline(NOW + wait, wait, wake, interruptible = true, now = { NOW }))
        assertEquals(40_000, testScheduler.currentTime - started)
    }

    @Test
    fun `waiting to retry is never shown with a time in the past`() {
        val zone = ZoneOffset.UTC
        assertNull(Format.retryLine("hc_rate_limited", null, NOW, zone))
        assertNull(Format.retryLine("hc_rate_limited", NOW - 1, NOW, zone))
        assertNull(Format.retryLine("hc_rate_limited", NOW, NOW, zone))
        val quota = Format.retryLine("hc_rate_limited", NOW + 60_000, NOW, zone)!!
        assertTrue(quota.startsWith("Waiting to retry at "))
        // A quota does not refill because the connection came back.
        assertFalse(quota.contains("sooner"))
        assertTrue(Format.retryLine("network", NOW + 60_000, NOW, zone)!!.contains("sooner if the connection comes back"))

        // The state the screen is built from drops the time the moment it comes, too.
        val types = listOf("Steps")
        val waiting = SyncSnapshot(GlobalState(lastError = StoredError("hc_rate_limited", NOW), retryAtMs = NOW + 60_000))
        val live = SyncUiStates.Live(access = access("Steps"), backfilling = true)
        fun retryAt(nowMs: Long) = SyncUiStates.build(types, PairingState.NotPaired, false, waiting, live, nowMs).lastError?.retryAtMs
        assertEquals(NOW + 60_000, retryAt(NOW + 59_999))
        assertNull(retryAt(NOW + 60_000))
    }

    @Test
    fun `the progress notification says what it is waiting for, and is not posted for every step`() {
        val zone = ZoneOffset.UTC
        val progress = BackfillProgress(BackfillPhase.RUNNING, doneUnits = 3, totalUnits = 9)
        assertEquals("3 of 9 type-months", SyncNotifications.backfillText(progress, null, zone))
        val waiting = SyncNotifications.backfillText(progress, BackfillWait("hc_rate_limited", 86_400_000L + 13 * Hours.MS), zone)
        assertTrue(waiting.startsWith("3 of 9 type-months. Waiting until "))
        assertTrue(waiting.endsWith("(hc_rate_limited)"))
        assertEquals(
            "Measuring how far back the history goes",
            SyncNotifications.backfillText(BackfillProgress(BackfillPhase.RUNNING), null, zone),
        )

        // Nothing new to say: nothing posted. Something new: at most about once a second.
        assertFalse(SyncNotifications.shouldPost("a", "a", sinceLastMs = 60_000, force = true))
        assertTrue(SyncNotifications.shouldPost(null, "a", sinceLastMs = 0, force = false))
        assertFalse(SyncNotifications.shouldPost("a", "b", sinceLastMs = 200, force = false))
        assertTrue(SyncNotifications.shouldPost("a", "b", sinceLastMs = 1_000, force = false))
        // The start and the end of a wait are not held back.
        assertTrue(SyncNotifications.shouldPost("a", "b", sinceLastMs = 200, force = true))
    }
}
