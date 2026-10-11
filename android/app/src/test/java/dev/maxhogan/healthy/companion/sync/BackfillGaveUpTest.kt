package dev.maxhogan.healthy.companion.sync

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A backfill that gave up is remembered in the store, so the periodic worker does not start the
 * service again (and post its notification again) only for it to stop at the same place: not in
 * the process that gave up, and not in the next one.
 */
class BackfillGaveUpTest {
    private val types = listOf("Steps", "HeartRate", "Weight")
    private val version = "0.1.0"
    private val hour = 60 * 60_000L

    private fun rig() = Rig(types = types).also { it.access = access("Steps", "HeartRate") }

    private fun denied() = HealthSourceException(HealthSourceException.Kind.PERMISSION, "permission_denied")

    private suspend fun resumes(rig: Rig, nowMs: Long = rig.now, appVersion: String? = version): Boolean =
        SyncUiStates.shouldResumeBackfill(types, rig.session(), rig.store.snapshot(), nowMs, appVersion)

    /** A backfill in which Steps cannot be read and everything else finishes. */
    private suspend fun gaveUp(rig: Rig): BackfillGaveUp {
        rig.source.add("HeartRate", record("a", type = "HeartRate", start = NOW - 1000))
        rig.source.failing["Steps"] = denied()
        rig.engine.requestBackfill(rig.session())
        assertTrue(resumes(rig))
        assertEquals(BackfillStep.Incomplete("permission_denied"), rig.drive().first)
        return rig.store.snapshot().global.backfillGaveUp!!
    }

    @Test
    fun `giving up is written to the store, and holds for a process that never saw it happen`() = runTest {
        val rig = rig()
        val record = gaveUp(rig)
        assertEquals("permission_denied", record.errorCode)
        assertEquals(version, record.appVersion)
        // Only the owner can fix a denied permission: no amount of time lifts it.
        assertNull(record.retryAtMs)

        // Everything the worker consults is in the snapshot, so a new process decides the same.
        assertFalse(resumes(rig))
        assertFalse(resumes(rig, nowMs = rig.now + 7 * 24 * hour))
        // And what a restart would have cost: a session that reads, fails and stops again.
        val reads = rig.source.calls.size
        val restarted = SyncEngine(rig.store, rig.source, rig.transport, version, types, clock = { rig.now }, currentPairing = { PAIRING })
        val again = BackfillRun()
        var step: BackfillStep
        do {
            step = restarted.backfillStep(rig.session(), again)
        } while (step is BackfillStep.Progress)
        assertEquals(BackfillStep.Incomplete("permission_denied"), step)
        assertTrue(rig.source.calls.size > reads)
    }

    @Test
    fun `it survives the trip through the real store's encoding`() = runTest {
        val disk = FakePreferencesStore()
        val record = BackfillGaveUp("hc_remote", NOW, "0123456789abcdef", version, NOW + hour)
        DataStoreSyncStateStore(disk).updateGlobal { it.copy(backfillRequested = true, backfillGaveUp = record) }
        // A second store on the same file: what a new process reads.
        val reopened = DataStoreSyncStateStore(disk).snapshot().global
        assertEquals(record, reopened.backfillGaveUp)
        assertTrue(reopened.backfillRequested)
        // A state written by a build that did not have the field reads as "has not given up".
        assertNull(GlobalState().backfillGaveUp)
    }

    @Test
    fun `the owner pressing the backfill button lifts it`() = runTest {
        val rig = rig()
        gaveUp(rig)
        rig.engine.requestBackfill(rig.session())
        assertNull(rig.store.snapshot().global.backfillGaveUp)
        assertTrue(resumes(rig))
    }

    @Test
    fun `pairing again lifts it, and so does unpairing`() = runTest {
        val rig = rig()
        gaveUp(rig)
        // The same payload scanned again is a new act of pairing.
        rig.pairingGeneration += 1
        assertTrue(resumes(rig))
        rig.pairingGeneration -= 1
        assertFalse(resumes(rig))

        rig.engine.pairingCleared()
        assertNull(rig.store.snapshot().global.backfillGaveUp)
    }

    @Test
    fun `a change in what the phone allows lifts it, and so does a new build`() = runTest {
        val rig = rig()
        gaveUp(rig)
        assertFalse(resumes(rig))

        // Another type is granted: there is work the old reason says nothing about.
        rig.access = access("Steps", "HeartRate", "Weight")
        assertTrue(resumes(rig))
        rig.access = access("Steps", "HeartRate")
        assertFalse(resumes(rig))

        // An update may be the fix.
        assertTrue(resumes(rig, appVersion = "0.1.1"))
        // Without a version to compare, the build is left out of it.
        assertFalse(resumes(rig, appVersion = null))
    }

    @Test
    fun `a cause that can pass by itself is tried again after an hour, and not before`() = runTest {
        val rig = rig()
        rig.source.add("Steps", record("s", start = NOW - 1000))
        rig.source.failing["HeartRate"] = HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote")
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Incomplete("hc_remote"), rig.drive().first)

        val record = rig.store.snapshot().global.backfillGaveUp!!
        assertEquals(rig.now + BackfillGaveUp.RETRY_MS, record.retryAtMs)
        assertFalse(resumes(rig))
        assertFalse(resumes(rig, nowMs = rig.now + hour - 1))
        assertTrue(resumes(rig, nowMs = rig.now + hour))
        // A clock that was set back a day must not turn the hour into a day.
        assertTrue(resumes(rig, nowMs = rig.now - 24 * hour))
    }

    @Test
    fun `a backfill that gets somewhere again clears it`() = runTest {
        val rig = rig()
        gaveUp(rig)
        rig.source.failing.clear()
        assertTrue(rig.engine.backfillStep(rig.session(), BackfillRun()) is BackfillStep.Progress)
        assertNull(rig.store.snapshot().global.backfillGaveUp)
        assertEquals(BackfillStep.Complete, rig.drive().first)
        assertNull(rig.store.snapshot().global.backfillGaveUp)
    }

    @Test
    fun `a refused token is announced by the session that was refused, not by one that finds it so`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", record("a", type = "HeartRate", start = NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }

        val first = BackfillRun()
        assertEquals(BackfillStep.PairingRejected, rig.drive(first).first)
        assertTrue(first.rejectedNow)
        val record = rig.store.snapshot().global.backfillGaveUp
        assertNotNull(record)
        assertEquals("unauthorized", record!!.errorCode)
        assertFalse(resumes(rig))

        // The process is killed and the service comes back: the refusal is already known, so
        // nothing is sent and the owner is not told a second time.
        val posts = rig.transport.sent.size
        val second = BackfillRun()
        assertEquals(BackfillStep.PairingRejected, rig.engine.backfillStep(rig.session(), second))
        assertFalse(second.rejectedNow)
        assertEquals(posts, rig.transport.sent.size)

        // Paired again: the refusal and the giving up both go.
        rig.pairingGeneration += 1
        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.store.snapshot().global.backfillGaveUp)
        assertTrue(resumes(rig))
    }

    @Test
    fun `a backfill that finishes has not given up`() = runTest {
        val rig = rig()
        rig.source.add("HeartRate", record("a", type = "HeartRate", start = NOW - 1000))
        rig.engine.requestBackfill(rig.session())
        assertEquals(BackfillStep.Complete, rig.drive().first)
        assertNull(rig.store.snapshot().global.backfillGaveUp)
        // Complete, so there is nothing to resume either.
        assertFalse(resumes(rig))
    }
}
