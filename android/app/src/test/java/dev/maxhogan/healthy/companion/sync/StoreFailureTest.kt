package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.ui.launchUnpair
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A disk that will not take a write. The rule (see [SyncStateStore]): a position is written only
 * after the server's 200, a write that fails changes nothing and costs a repeat, and a position
 * is never stored for something the server did not acknowledge. Nothing here may crash.
 */
class StoreFailureTest {
    private val types = listOf("Steps", "HeartRate", "TotalCaloriesBurned")
    private val failed = RunResult.Failed(SyncEngine.ERROR_STATE_STORE)

    private fun hr(id: String, start: Long = NOW) = record(id, type = "HeartRate", start = start)

    private fun page(vararg ids: String, next: String) =
        ChangesPage(ids.map { HcChange.Upsert(hr(it)) }, next, hasMore = false, expired = false)

    // --- the engine -----------------------------------------------------------------------------

    @Test
    fun `a position write that fails after the 200 costs a repeat, never a record`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page("a", "b", next = "HeartRate#2")
        // The server takes the batch; the write that would move the token past it does not land.
        rig.store.writeFault = { what, value -> what == "type:HeartRate" && (value as TypeState).token == "HeartRate#2" }

        assertEquals(failed, rig.sync())
        assertEquals(listOf("a", "b"), rig.transport.data.single().upsertIds)
        val stuck = rig.store.current.type("HeartRate")
        assertEquals("HeartRate#1", stuck.token)
        assertEquals(0, stuck.uploaded)
        // The store cannot say that it failed, so the engine does.
        assertEquals(SyncEngine.ERROR_STATE_STORE, rig.engine.storeFailure.value?.errorCode)

        // The disk recovers. The same position is read and the same records go again, which the
        // server takes as the same records; they are counted once.
        rig.store.writeFault = { _, _ -> false }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("a", "b"), rig.transport.data.last().upsertIds)
        assertEquals(2, rig.transport.data.size)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(2, rig.type("HeartRate").uploaded)
        assertNull(rig.engine.storeFailure.value)
    }

    @Test
    fun `a backfill page whose cursor cannot be written is sent again, not skipped`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.source.pageSize = 2
        rig.source.add("HeartRate", *(0 until 4).map { hr("r$it", NOW - 4000 + it) }.toTypedArray())
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        // Setup, then the write that would move the cursor to the second page fails.
        rig.store.writeFault = { what, value -> what == "type:HeartRate" && (value as TypeState).backfill.pageToken == "2" }
        var step: BackfillStep
        do {
            step = rig.engine.backfillStep(rig.session(), run)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Backoff(SyncEngine.ERROR_STATE_STORE), step)
        assertEquals(listOf(listOf("r0", "r1")), rig.transport.data.map { it.upsertIds })
        assertNull(rig.store.current.type("HeartRate").backfill.pageToken)
        assertEquals(0, rig.store.current.type("HeartRate").uploaded)
        assertNotNull(rig.engine.storeFailure.value)

        rig.store.writeFault = { _, _ -> false }
        assertEquals(BackfillStep.Complete, rig.drive(run).first)
        assertEquals(listOf(listOf("r0", "r1"), listOf("r0", "r1"), listOf("r2", "r3")), rig.transport.data.map { it.upsertIds })
        assertEquals(4, rig.type("HeartRate").uploaded)
        assertNull(rig.engine.storeFailure.value)
    }

    @Test
    fun `a position is never stored for something the server did not acknowledge`() = runTest {
        val rig = Rig(types = listOf("HeartRate"))
        rig.sync()
        rig.source.pageSize = 2
        rig.source.add("HeartRate", *(0 until 4).map { hr("r$it", NOW - 4000 + it) }.toTypedArray())
        rig.source.changePages["HeartRate#1"] = page("a", next = "HeartRate#2")
        // Every position write is checked as it happens against what the server has taken.
        var acknowledged = 0
        rig.transport.rule = { batch ->
            when {
                batch.isStateOnly -> null
                // The first backfill page and nothing else is taken.
                batch.upsertIds == listOf("r0", "r1") -> null.also { acknowledged++ }
                else -> FakeTransport.status(500, "oops")
            }
        }
        rig.store.writeFault = { what, value ->
            if (what == "type:HeartRate") {
                val state = value as TypeState
                if (state.token != "HeartRate#1") fail("the changes token moved without an acknowledgement")
                if (state.backfill.pageToken != null && acknowledged == 0) fail("the page cursor moved without an acknowledgement")
                if (state.backfill.pageToken !in setOf(null, "2")) fail("the page cursor moved past an unacknowledged page")
                if (state.backfill.complete) fail("the backfill finished without its pages being acknowledged")
            }
            false
        }

        assertEquals(RunResult.Failed("http_500"), rig.sync())
        rig.engine.requestBackfill(rig.session())
        val run = BackfillRun()
        repeat(12) { rig.engine.backfillStep(rig.session(), run) }
        assertEquals(RunResult.Failed("http_500"), rig.sync())

        val state = rig.type("HeartRate")
        assertEquals("HeartRate#1", state.token)
        assertEquals("2", state.backfill.pageToken)
        assertFalse(state.backfill.complete)
        assertEquals(2, state.uploaded)
        assertEquals(1, acknowledged)
    }

    @Test
    fun `a disk that takes no write at all sends no data and crashes nothing`() = runTest {
        val rig = Rig()
        rig.source.add("HeartRate", hr("a", NOW - 1000))
        rig.store.writeFault = { _, _ -> true }

        assertEquals(failed, rig.sync())
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Backoff(SyncEngine.ERROR_STATE_STORE), rig.engine.backfillStep(rig.session(), BackfillRun()))
        rig.engine.noteProblem("backfill_not_started")
        rig.engine.noteBackfillWaiting("network", NOW + 1000)
        rig.engine.pairingCleared()
        assertEquals(RunResult.Failed("hc_unavailable"), rig.engine.failRun("hc_unavailable"))

        assertTrue(rig.transport.sent.isEmpty())
        assertEquals(SyncSnapshot(), rig.store.current)
        assertEquals(SyncEngine.ERROR_STATE_STORE, rig.engine.storeFailure.value?.errorCode)
    }

    @Test
    fun `a state that cannot be read stops the run before anything is read or sent`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page("a", next = "HeartRate#2")
        val reads = rig.source.calls.size
        val posts = rig.transport.sent.size
        rig.store.readFault = true
        assertEquals(failed, rig.sync())
        assertEquals(BackfillStep.Backoff(SyncEngine.ERROR_STATE_STORE), rig.engine.backfillStep(rig.session(), BackfillRun()))
        assertEquals(reads, rig.source.calls.size)
        assertEquals(posts, rig.transport.sent.size)

        rig.store.readFault = false
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
    }

    @Test
    fun `a pairing that cannot be read sends nothing on a guess`() = runTest {
        val store = InMemorySyncStateStore()
        val source = FakeHealthSource()
        val transport = FakeTransport()
        var broken = true
        val engine = SyncEngine(store, source, transport, "0.1.0", types, clock = { NOW }) {
            if (broken) throw IOException("disk") else PAIRING
        }
        val session = Session(PAIRING, access(*types.toTypedArray()), FACTS)
        assertEquals(failed, engine.syncOnce(session))
        assertTrue(transport.sent.isEmpty())
        assertTrue(source.calls.isEmpty())
        broken = false
        assertEquals(RunResult.Success, engine.syncOnce(session))
    }

    @Test
    fun `the status screen shows a failing store ahead of whatever the store last said`() {
        val snapshot = SyncSnapshot(GlobalState(lastError = StoredError("network", NOW + 10), consecutiveFailures = 2))
        val live = SyncUiStates.Live(access = access(*types.toTypedArray()), storeError = StoredError(SyncEngine.ERROR_STATE_STORE, NOW))
        val ui = SyncUiStates.build(types, PairingState.Paired(PAIRING.url, DEVICE), false, snapshot, live, nowMs = NOW)
        assertEquals(SyncEngine.ERROR_STATE_STORE, ui.lastError?.errorCode)
        assertEquals(NOW, ui.lastError?.atMs)
        assertNull(ui.lastError?.retryAtMs)
        val recovered = SyncUiStates.build(types, PairingState.NotPaired, false, snapshot, live.copy(storeError = null), nowMs = NOW)
        assertEquals("network", recovered.lastError?.errorCode)
        assertTrue(SyncEngine.ERROR_STATE_STORE in ErrorMessages.known)
    }

    // --- the real store's encoding, on a disk that fails ------------------------------------------

    @Test
    fun `a failed write to the real store throws, changes nothing, and the next one works`() = runTest {
        val disk = FakePreferencesStore()
        val store = DataStoreSyncStateStore(disk)
        store.updateType("HeartRate") { it.copy(token = "t1") }
        store.updateGlobal { it.copy(deviceId = DEVICE) }
        val before = store.snapshot()

        disk.failWrites = true
        for (write in listOf<suspend () -> Unit>(
            { store.updateType("HeartRate") { it.copy(token = "t2") } },
            { store.updateGlobal { it.copy(lastSyncMs = NOW) } },
            { store.reset("other") },
        )) {
            try {
                write()
                fail("a write that did not land must not look like one that did")
            } catch (_: IOException) {
                // What the engine turns into state_store_failed.
            }
        }
        assertEquals(before, store.snapshot())
        // A write that changes nothing has nothing to fail.
        assertEquals("t1", store.updateType("HeartRate") { it }.token)

        disk.failWrites = false
        assertEquals("t2", store.updateType("HeartRate") { it.copy(token = "t2") }.token)
        assertEquals("t2", store.snapshot().type("HeartRate").token)

        disk.failReads = true
        try {
            store.snapshot()
            fail("a state that could not be read must not read as empty")
        } catch (_: IOException) {
            // Reading as empty would start every type over and lose nothing, but it would also
            // report a phone with no history to the server; the engine stops the run instead.
        }
    }

    @Test
    fun `the engine on the real store's encoding keeps its positions through a failing disk`() = runTest {
        val disk = FakePreferencesStore()
        val source = FakeHealthSource()
        val transport = FakeTransport()
        val engine = SyncEngine(DataStoreSyncStateStore(disk), source, transport, "0.1.0", types, clock = { NOW }) { PAIRING }
        val session = Session(PAIRING, access(*types.toTypedArray()), FACTS)
        assertEquals(RunResult.Success, engine.syncOnce(session))
        source.changePages["HeartRate#1"] = page("a", next = "HeartRate#2")

        disk.failWrites = true
        assertEquals(failed, engine.syncOnce(session))
        assertEquals("HeartRate#1", DataStoreSyncStateStore(disk).snapshot().type("HeartRate").token)

        disk.failWrites = false
        assertEquals(RunResult.Success, engine.syncOnce(session))
        assertEquals("HeartRate#2", DataStoreSyncStateStore(disk).snapshot().type("HeartRate").token)
    }

    // --- pairing and unpairing ---------------------------------------------------------------------

    private class PlainCipher : TokenCipher {
        override fun encrypt(plaintext: String): String = "sealed:$plaintext"

        override fun decrypt(sealed: String): String? = sealed.removePrefix("sealed:").takeIf { it != sealed }
    }

    @Test
    fun `a pairing that cannot be written is reported as not saved`() = runTest {
        val disk = FakePreferencesStore()
        val store = PairingStore(disk, PlainCipher())
        disk.failWrites = true
        assertFalse(store.save(PAIRING))
        assertNull(store.pairing.first())
        assertEquals(0L, store.generation())
    }

    @Test
    fun `an unpair that cannot be written is reported, and the phone is still paired`() = runTest {
        val disk = FakePreferencesStore()
        val store = PairingStore(disk, PlainCipher())
        assertTrue(store.save(PAIRING))
        disk.failWrites = true
        assertFalse(store.clear())
        assertEquals(PAIRING, store.pairing.first())
        // Not a new act of pairing either: nothing happened.
        assertEquals(1L, store.generation())

        disk.failWrites = false
        assertTrue(store.clear())
        assertNull(store.pairing.first())
    }

    @OptIn(ExperimentalCoroutinesApi::class) // advanceUntilIdle
    @Test
    fun `the screen that asked to unpair is told whether it happened`() = runTest {
        val disk = FakePreferencesStore()
        val store = PairingStore(disk, PlainCipher())
        store.save(PAIRING)
        val results = ArrayList<Boolean>()

        disk.failWrites = true
        launchUnpair(store) { results.add(it) }
        advanceUntilIdle()
        disk.failWrites = false
        launchUnpair(store) { results.add(it) }
        advanceUntilIdle()
        assertEquals(listOf(false, true), results)
    }
}
