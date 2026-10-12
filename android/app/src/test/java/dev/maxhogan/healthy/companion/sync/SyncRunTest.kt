package dev.maxhogan.healthy.companion.sync

import androidx.datastore.preferences.core.stringPreferencesKey
import dev.maxhogan.healthy.companion.hc.Grant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A run that is cut off sends no closing report, so nothing it uploads may depend on one: every
 * batch says which run it belongs to and how the run before it ended, and the next run starts
 * with the type the cut one had not completed.
 */
class SyncRunTest {
    private val types = listOf("Steps", "HeartRate", "Weight", "Height")

    /** What a process that dies throws at nobody: not an exception the engine may catch. */
    private class Killed : Error("killed")

    private fun rig() = Rig(types = types)

    private fun page(type: String, id: String, next: String) =
        ChangesPage(listOf(HcChange.Upsert(record(id, type = type))), next, hasMore = false, expired = false)

    /** The types the engine asked Health Connect about since the calls were last cleared, in order. */
    private fun visited(rig: Rig): List<String> = visited(rig.source)

    private fun trigger(batch: SentBatch): String = batch.syncState.getValue("runTrigger").jsonPrimitive.content

    private fun startedAt(batch: SentBatch): Long = batch.syncState.getValue("runStartedAt").jsonPrimitive.long

    /** `previousRun` as (startedAt, end), or null when the batch names none. */
    private fun previous(batch: SentBatch): Pair<Long, String>? = batch.syncState["previousRun"]?.jsonObject?.let {
        it.getValue("startedAt").jsonPrimitive.long to it.getValue("end").jsonPrimitive.content
    }

    /** One run in which [type] has a change to upload: its upload is where a test strikes. */
    private suspend fun runWithChange(rig: Rig, type: String, id: String, trigger: SyncTrigger = SyncTrigger.PERIODIC): RunResult {
        val token = rig.type(type).token!!
        rig.source.changePages[token] = page(type, id, "${token.substringBefore('#')}#${token.substringAfter('#').toInt() + 1}")
        rig.source.calls.clear()
        return rig.sync(trigger = trigger)
    }

    /** A run that dies while uploading the change of [type]: the process is gone, nothing is written. */
    private suspend fun killedAt(rig: Rig, type: String, id: String) {
        rig.transport.rule = { if (it.isStateOnly) null else throw Killed() }
        try {
            runWithChange(rig, type, id)
            fail("the run was to die")
        } catch (_: Killed) {
            // As far as the store can tell, the process ended here.
        }
        rig.transport.rule = { null }
        rig.restart()
        rig.now += SyncCadence.PERIOD_MS
        rig.source.calls.clear()
        rig.transport.sent.clear()
    }

    // --- which run a batch belongs to -----------------------------------------------------------

    @Test
    fun `every batch of a run names the same run, and the next run another`() = runTest {
        val rig = rig()
        rig.sync(trigger = SyncTrigger.PERIODIC)
        rig.transport.sent.clear()
        rig.source.changePages["HeartRate#1"] = page("HeartRate", "h1", "HeartRate#2")
        rig.source.changePages["Weight#1"] = page("Weight", "w1", "Weight#2")
        // The clock moves under the run: its start does not.
        rig.transport.rule = {
            rig.now += 1_000
            null
        }
        rig.now += SyncCadence.PERIOD_MS
        val second = rig.now
        assertEquals(RunResult.Success, rig.sync(trigger = SyncTrigger.ALARM))

        val batches = rig.transport.sent.toList()
        assertEquals(3, batches.size)
        assertTrue(batches.last().isStateOnly)
        assertEquals(setOf("alarm"), batches.map(::trigger).toSet())
        assertEquals(setOf(second), batches.map(::startedAt).toSet())
        assertEquals(setOf(NOW to "ok"), batches.map(::previous).toSet())
        assertTrue(batches.map { it.json.getValue("phoneTime").jsonPrimitive.long }.toSet().size > 1)

        rig.transport.sent.clear()
        val third = rig.now + SyncCadence.PERIOD_MS
        rig.now = third
        rig.sync(trigger = SyncTrigger.APP_OPEN)
        val closing = rig.transport.sent.single()
        assertEquals("app_open", trigger(closing))
        assertEquals(third, startedAt(closing))
        assertEquals(second to "ok", previous(closing))
        for (batch in batches + closing) assertNull(WireContract.envelopeProblem(batch.json))
    }

    @Test
    fun `the first run names none before it`() = runTest {
        val rig = rig()
        rig.sync(trigger = SyncTrigger.MANUAL)
        val closing = rig.transport.sent.single()
        assertEquals("manual", trigger(closing))
        assertEquals(NOW, startedAt(closing))
        assertFalse("previousRun" in closing.syncState)
        assertEquals(RunRecord(NOW, "manual", "ok"), rig.store.current.global.run)
        assertNull(rig.store.current.global.previousRun)
    }

    @Test
    fun `a run that reads nothing on purpose reports its run all the same, and ends as what skipped it`() = runTest {
        val rig = rig()
        rig.foreground = false
        rig.access = rig.access.copy(backgroundRead = Grant.DENIED)
        assertEquals(RunResult.Skipped("background_read_missing", notify = true), rig.sync(trigger = SyncTrigger.PERIODIC))
        val report = rig.transport.sent.single()
        assertEquals("periodic", trigger(report))
        assertEquals(NOW, startedAt(report))

        rig.foreground = true
        rig.now += SyncCadence.PERIOD_MS
        rig.sync()
        assertEquals(NOW to "background_read_missing", previous(rig.transport.sent.last()))
    }

    @Test
    fun `a batch of the backfill names its session, and the latest incremental run as the one before`() = runTest {
        val rig = Rig(types = listOf("HeartRate", "Weight"))
        rig.sync(trigger = SyncTrigger.PERIODIC)
        rig.transport.sent.clear()
        rig.source.add("HeartRate", record("h1", type = "HeartRate", start = NOW - 1_000))
        rig.source.add("Weight", record("w1", type = "Weight", start = NOW - 2_000))
        rig.transport.rule = {
            rig.now += 1_000
            null
        }
        rig.now += 60_000
        val session = rig.now
        assertEquals(BackfillStep.Complete, rig.backfill())
        val batches = rig.transport.sent.toList()
        assertTrue(batches.size >= 2)
        assertEquals(setOf("backfill"), batches.map(::trigger).toSet())
        assertEquals(setOf(session), batches.map(::startedAt).toSet())
        assertEquals(setOf(NOW to "ok"), batches.map(::previous).toSet())
        for (batch in batches) assertNull(WireContract.envelopeProblem(batch.json))

        // Another session is another burst. The incremental run it follows did not change.
        rig.transport.sent.clear()
        rig.source.add("Weight", record("w0", type = "Weight", start = NOW - 3_000))
        rig.engine.requestBackfill(rig.session())
        val again = rig.now
        assertEquals(BackfillStep.Complete, rig.drive().first)
        assertTrue(again > session)
        assertEquals(setOf(again), rig.transport.sent.map(::startedAt).toSet())
        assertEquals(setOf(NOW to "ok"), rig.transport.sent.map(::previous).toSet())
        // And the backfill is no run: what the next sync calls the run before it is the sync.
        rig.transport.sent.clear()
        rig.sync()
        assertEquals(NOW to "ok", previous(rig.transport.sent.last()))
    }

    // --- how the run before ended ---------------------------------------------------------------

    @Test
    fun `a run that failed is named by the code it failed with`() = runTest {
        val rig = rig()
        rig.sync()
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(500, "oops") }
        rig.now += SyncCadence.PERIOD_MS
        val failedAt = rig.now
        assertEquals(RunResult.Failed("http_500"), runWithChange(rig, "Weight", "w1"))
        assertEquals(RunRecord(failedAt, "periodic", "http_500"), rig.store.current.global.run)

        rig.transport.rule = { null }
        rig.transport.sent.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(setOf(failedAt to "http_500"), rig.transport.sent.map(::previous).toSet())
    }

    @Test
    fun `a run Health Connect asked to wait is named by that, and its own report already says which run it is`() = runTest {
        val rig = rig()
        rig.sync()
        rig.transport.sent.clear()
        rig.source.changesFailure["Weight"] = HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited")
        rig.now += SyncCadence.PERIOD_MS
        val limitedAt = rig.now
        assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync(trigger = SyncTrigger.PERIODIC))
        assertEquals(limitedAt, startedAt(rig.transport.sent.single()))

        rig.source.changesFailure.clear()
        rig.transport.sent.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(limitedAt to "hc_rate_limited", previous(rig.transport.sent.single()))
    }

    @Test
    fun `a run whose coroutine was cancelled is found without an end and reported as interrupted`() = runTest {
        val rig = rig()
        rig.sync()
        rig.transport.sent.clear()
        // The upload hangs, as it does when the network goes, and the system stops the work.
        val uploading = CompletableDeferred<Unit>()
        rig.transport.hold = {
            if (!it.isStateOnly) {
                uploading.complete(Unit)
                awaitCancellation()
            }
        }
        rig.now += SyncCadence.PERIOD_MS
        val cutAt = rig.now
        val job = launch { runWithChange(rig, "Weight", "w1") }
        uploading.await()
        job.cancelAndJoin()
        assertTrue(job.isCancelled)
        // Nothing was written on the way out: the run simply has no end.
        assertEquals(RunRecord(cutAt, "periodic"), rig.store.current.global.run)
        assertEquals("Weight#1", rig.store.current.type("Weight").token)

        rig.transport.hold = {}
        rig.transport.sent.clear()
        rig.now += SyncCadence.PERIOD_MS
        // The same engine, in a process that lived on: the lock was let go.
        assertEquals(RunResult.Success, rig.sync(trigger = SyncTrigger.ALARM))
        assertEquals(setOf(cutAt to "interrupted"), rig.transport.sent.map(::previous).toSet())
        assertEquals(listOf("w1"), rig.transport.data.single().upsertIds)
        assertEquals(RunRecord(cutAt, "periodic", "interrupted"), rig.store.current.global.previousRun)
    }

    @Test
    fun `a run that simply never finished is reported as interrupted by the process that follows`() = runTest {
        val rig = rig()
        rig.sync()
        rig.now += SyncCadence.PERIOD_MS
        val diedAt = rig.now
        killedAt(rig, "Weight", "w1")
        assertEquals(RunRecord(diedAt, "periodic"), rig.store.current.global.run)

        assertEquals(RunResult.Success, rig.sync(trigger = SyncTrigger.PERIODIC))
        assertEquals(setOf(diedAt to "interrupted"), rig.transport.sent.map(::previous).toSet())
        // A backfill batch in between would have said the same of it; after this run it is history.
        rig.transport.sent.clear()
        rig.now += SyncCadence.PERIOD_MS
        rig.sync()
        assertEquals("ok", previous(rig.transport.sent.single())?.second)
    }

    @Test
    fun `a backfill batch calls a run that left no end interrupted`() = runTest {
        val rig = rig()
        rig.sync()
        rig.now += SyncCadence.PERIOD_MS
        val diedAt = rig.now
        killedAt(rig, "Weight", "w1")
        rig.source.add("HeartRate", record("h1", type = "HeartRate", start = NOW - 1_000))
        assertEquals(BackfillStep.Complete, rig.backfill())
        assertFalse(rig.transport.sent.isEmpty())
        assertEquals(setOf(diedAt to "interrupted"), rig.transport.sent.map(::previous).toSet())
        assertEquals(setOf("backfill"), rig.transport.sent.map(::trigger).toSet())
    }

    @Test
    fun `a run ended by something nobody foresaw says so`() = runTest {
        val rig = rig()
        rig.sync()
        rig.transport.rule = { if (it.isStateOnly) null else throw IllegalStateException("unforeseen") }
        try {
            runWithChange(rig, "Weight", "w1")
            fail("the failure is the controller's to turn into a result")
        } catch (_: IllegalStateException) {
            // The controller records it as internal_error; the run already has.
        }
        assertEquals("internal_error", rig.store.current.global.run?.end)
    }

    @Test
    fun `a run that finds the pairing changed writes no end into a store that is not its own`() = runTest {
        val rig = rig()
        rig.sync()
        rig.now += SyncCadence.PERIOD_MS
        val staleAt = rig.now
        // Unpaired while the upload is on its way.
        rig.transport.rule = {
            rig.storedPairing = null
            FakeTransport.status(503, "down")
        }
        assertEquals(RunResult.Failed("pairing_changed", retryable = false), runWithChange(rig, "Weight", "w1"))
        assertEquals(RunRecord(staleAt, "periodic"), rig.store.current.global.run)
    }

    // --- the order of the types -----------------------------------------------------------------

    @Test
    fun `after a clean run the next starts one type further round, as before`() = runTest {
        val rig = rig()
        val firsts = ArrayList<String>()
        repeat(5) {
            rig.source.calls.clear()
            assertEquals(RunResult.Success, rig.sync())
            assertEquals(types.toSet(), visited(rig).toSet())
            assertEquals(types.size, visited(rig).size)
            firsts.add(visited(rig).first())
            assertNull(rig.store.current.global.resume)
        }
        assertEquals(listOf("HeartRate", "Weight", "Height", "Steps", "HeartRate"), firsts)
        assertEquals(5, rig.store.current.global.rotation)
    }

    @Test
    fun `a run that was cut off is finished first by the next, which still reads every type once`() = runTest {
        val rig = rig()
        rig.sync()
        // The second run goes Weight, Height, Steps, HeartRate, and dies in Steps.
        killedAt(rig, "Steps", "s1")
        assertEquals(RunResume("Steps"), rig.store.current.global.resume)
        assertEquals(2, rig.store.current.global.rotation)

        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("Steps", "HeartRate", "Weight", "Height"), visited(rig))
        assertEquals(listOf("s1"), rig.transport.data.single().upsertIds)
        // The rotation did not move for it, and moves again from where it was.
        assertEquals(2, rig.store.current.global.rotation)
        assertNull(rig.store.current.global.resume)
        rig.source.calls.clear()
        rig.sync()
        assertEquals(listOf("Height", "Steps", "HeartRate", "Weight"), visited(rig))
        assertEquals(3, rig.store.current.global.rotation)
    }

    @Test
    fun `a run cancelled part-way is taken up at the type it was on`() = runTest {
        val rig = rig()
        rig.sync()
        val uploading = CompletableDeferred<Unit>()
        rig.transport.hold = {
            if (!it.isStateOnly) {
                uploading.complete(Unit)
                awaitCancellation()
            }
        }
        val job = launch { runWithChange(rig, "Steps", "s1") }
        uploading.await()
        job.cancelAndJoin()
        assertEquals(listOf("Weight", "Height", "Steps"), visited(rig))

        rig.transport.hold = {}
        rig.source.calls.clear()
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("Steps", "HeartRate", "Weight", "Height"), visited(rig))
    }

    @Test
    fun `a run stopped by a failure that ends the run is taken up at the type it stopped in`() = runTest {
        val rig = rig()
        rig.sync()
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(500, "oops") }
        assertEquals(RunResult.Failed("http_500"), runWithChange(rig, "Steps", "s1"))
        assertEquals(listOf("Weight", "Height", "Steps"), visited(rig))

        rig.transport.rule = { null }
        rig.source.calls.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("Steps", "HeartRate", "Weight", "Height"), visited(rig))
    }

    @Test
    fun `a type that fails on its own does not hold the run, and is not what the next one starts with`() = runTest {
        val rig = rig()
        rig.sync()
        rig.source.changesFailure["Height"] = HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_error")
        rig.source.calls.clear()
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("Weight", "Height", "Steps", "HeartRate"), visited(rig))
        assertNull(rig.store.current.global.resume)
        rig.source.calls.clear()
        rig.sync()
        assertEquals("Height", visited(rig).first())
        assertEquals(3, rig.store.current.global.rotation)
    }

    @Test
    fun `a run that reads no type leaves the cut run for the one that does`() = runTest {
        val rig = rig()
        rig.sync()
        killedAt(rig, "Steps", "s1")
        // In the background without the grant: nothing is read, and nothing is forgotten.
        rig.foreground = false
        rig.access = rig.access.copy(backgroundRead = Grant.DENIED)
        assertEquals(RunResult.Skipped("background_read_missing", notify = true), rig.sync())
        assertTrue(visited(rig).isEmpty())
        assertEquals(RunResume("Steps"), rig.store.current.global.resume)

        rig.foreground = true
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("Steps", "HeartRate", "Weight", "Height"), visited(rig))
    }

    @Test
    fun `a cut run whose type is no longer granted is followed by the rotation`() = runTest {
        val rig = rig()
        rig.sync()
        killedAt(rig, "Steps", "s1")
        rig.access = access("HeartRate", "Weight", "Height")
        assertEquals(RunResult.Success, rig.sync())
        // Three types now, and the third run: the order starts at the first of them.
        assertEquals(listOf("HeartRate", "Weight", "Height"), visited(rig))
        assertEquals(3, rig.store.current.global.rotation)
        assertNull(rig.store.current.global.resume)
    }

    @Test
    fun `a type that cuts off the run that came back for it is not started with a third time`() = runTest {
        val rig = rig()
        rig.sync()
        killedAt(rig, "Steps", "s1")
        // The run that comes back for Steps dies in it as well.
        killedAt(rig, "Steps", "s1")
        assertEquals(RunResume("Steps", again = true), rig.store.current.global.resume)
        assertEquals(2, rig.store.current.global.rotation)

        // So the next one goes by the rotation, and the other types are read before it.
        rig.transport.rule = { if (it.isStateOnly) null else throw Killed() }
        rig.source.calls.clear()
        try {
            rig.sync()
            fail("the run was to die")
        } catch (_: Killed) {
            // Steps again, but this time after everything ahead of it in the order.
        }
        assertEquals(listOf("Height", "Steps"), visited(rig))
        assertEquals(3, rig.store.current.global.rotation)
        assertEquals(RunResume("Steps"), rig.store.current.global.resume)
    }

    @Test
    fun `the type a run is on costs one write of the global state a type, and none more`() = runTest {
        val rig = rig()
        rig.sync()
        rig.store.writes.clear()
        rig.now += SyncCadence.PERIOD_MS
        assertEquals(RunResult.Success, rig.sync())
        // The start, one for each type (the first moves the rotation too), the close before the
        // report (which also forgets the type), and the success with the run's end in it.
        assertEquals(List(1 + types.size + 2) { "global" }, rig.store.writes)
    }

    // --- the report itself ----------------------------------------------------------------------

    @Test
    fun `a state no run has written carries no run members, and a code the server would refuse is not sent`() {
        val bare = SyncStateReport.build(types, access(*types.toTypedArray()), SyncSnapshot(), FACTS, NOW)
        assertTrue(listOf("runTrigger", "runStartedAt", "previousRun").none { it in bare })

        val odd = SyncSnapshot(
            GlobalState(run = RunRecord(NOW, "Not A Code"), previousRun = RunRecord(NOW - 1, "periodic", "x".repeat(41))),
        )
        val report = SyncStateReport.build(types, access(*types.toTypedArray()), odd, FACTS, NOW)
        assertEquals("other", report.getValue("runTrigger").jsonPrimitive.content)
        assertEquals("other", report.getValue("previousRun").jsonObject.getValue("end").jsonPrimitive.content)
        assertNull(WireContract.envelopeProblem(envelope(report)))
        // The mirror of the server's check does refuse what the app never sends.
        val refused = JsonObject(report + ("runTrigger" to JsonPrimitive("Not A Code")))
        assertEquals("runTrigger", WireContract.envelopeProblem(envelope(refused)))
    }

    private fun envelope(syncState: JsonObject): JsonObject = buildJsonObject {
        put("v", JsonPrimitive(1))
        put("deviceId", JsonPrimitive(DEVICE))
        put("appVersion", JsonPrimitive("0.1.0"))
        put("batchId", JsonPrimitive("fixture-0001"))
        put("phoneTime", JsonPrimitive(NOW))
        put("syncState", syncState)
    }

    // --- the stored state -----------------------------------------------------------------------

    @Test
    fun `a state stored by the build before these fields loads, and the first run after it names none before`() = runTest {
        // What v0.1.267 wrote: every field it had, and none of run, previousRun and resume.
        val global = """{"deviceId":"$DEVICE","lastSyncMs":${NOW - 900_000},"lastAttemptMs":${NOW - 900_000},""" +
            """"consecutiveFailures":1,"lastError":{"errorCode":"network","atMs":${NOW - 900_000}},"retryAtMs":null,""" +
            """"backfillRequested":true,"rejectedTokenTag":null,"skipReason":null,"skipNotified":true,"rotation":6,""" +
            """"backfillGaveUp":{"errorCode":"hc_remote","atMs":${NOW - 5_000},"fingerprint":"0123456789abcdef","appVersion":"0.1.267","retryAtMs":null}}"""
        val heartRate = """{"token":"HeartRate#4","tokenCreatedMs":${NOW - 900_000},"uploaded":12,"backlog":0,"recent":{}}"""
        val disk = FakePreferencesStore()
        disk.updateData {
            it.toMutablePreferences().apply {
                this[stringPreferencesKey("global")] = global
                this[stringPreferencesKey("type.HeartRate")] = heartRate
            }
        }

        val loaded = DataStoreSyncStateStore(disk).snapshot()
        assertEquals(DEVICE, loaded.global.deviceId)
        assertEquals(NOW - 900_000, loaded.global.lastAttemptMs)
        assertEquals(StoredError("network", NOW - 900_000), loaded.global.lastError)
        assertEquals(6, loaded.global.rotation)
        assertTrue(loaded.global.backfillRequested)
        assertEquals("hc_remote", loaded.global.backfillGaveUp?.errorCode)
        assertEquals("HeartRate#4", loaded.type("HeartRate").token)
        assertEquals(12, loaded.type("HeartRate").uploaded)
        assertNull(loaded.global.run)
        assertNull(loaded.global.previousRun)
        assertNull(loaded.global.resume)

        // And the engine carries on from it: the rotation moves on, nothing starts over.
        val source = FakeHealthSource()
        val transport = FakeTransport()
        val engine = SyncEngine(DataStoreSyncStateStore(disk), source, transport, "0.1.268", types, clock = { NOW }) { PAIRING }
        val session = Session(PAIRING, access(*types.toTypedArray()), FACTS)
        assertEquals(RunResult.Success, engine.syncOnce(session, SyncTrigger.PERIODIC))
        assertEquals("changes:HeartRate#4", source.calls.first { it.startsWith("changes:HeartRate") })
        // Rotation 7 of four types starts at the fourth.
        assertEquals("Height", visited(source).first())
        val first = transport.sent.single()
        assertEquals("periodic", trigger(first))
        assertFalse("previousRun" in first.syncState)

        // What this build writes is read back by a store opened afresh.
        val reopened = DataStoreSyncStateStore(disk).snapshot().global
        assertEquals(RunRecord(NOW, "periodic", "ok"), reopened.run)
        assertEquals(7, reopened.rotation)
        assertEquals(RunResult.Success, engine.syncOnce(session, SyncTrigger.ALARM))
        assertEquals(NOW to "ok", previous(transport.sent.last()))
        assertEquals(RunRecord(NOW, "periodic", "ok"), DataStoreSyncStateStore(disk).snapshot().global.previousRun)
    }

    private fun visited(source: FakeHealthSource): List<String> =
        source.calls.filter { it.startsWith("changes:") }.map { it.removePrefix("changes:").substringBefore('#') }
}
