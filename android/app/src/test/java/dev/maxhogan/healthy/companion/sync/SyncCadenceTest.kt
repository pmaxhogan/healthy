package dev.maxhogan.healthy.companion.sync

import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a scheduled sync is due, and what is asked of WorkManager to keep it coming. */
class SyncCadenceTest {
    private val minute = 60_000L
    private val healthy = SyncCadence.Periodic(
        running = false,
        runAttemptCount = 0,
        network = NetworkType.CONNECTED,
        otherConstraints = false,
        periodMs = SyncCadence.PERIOD_MS,
    )

    @Test
    fun `the watchdog comes a little after the period, and a scheduled sync is not repeated at once`() {
        assertEquals(15 * minute, SyncCadence.PERIOD_MS)
        assertTrue(SyncCadence.WATCHDOG_MS > SyncCadence.PERIOD_MS)
        assertTrue(SyncCadence.WATCHDOG_MS <= SyncCadence.PERIOD_MS + 5 * minute)
        // The periodic work, on time, must not be taken for a repeat of the run before it.
        assertTrue(SyncCadence.MIN_GAP_MS < SyncCadence.PERIOD_MS)
    }

    @Test
    fun `a sync the owner asked for always runs`() {
        assertTrue(SyncCadence.shouldRun(SyncTrigger.MANUAL, NOW - 1, NOW))
        assertTrue(SyncCadence.shouldRun(SyncTrigger.MANUAL, null, NOW))
        // Opening the app is the owner asking too: it has its own name, and is treated the same.
        assertTrue(SyncCadence.shouldRun(SyncTrigger.APP_OPEN, NOW - 1, NOW))
        assertTrue(SyncCadence.shouldRun(SyncTrigger.APP_OPEN, null, NOW))
        assertEquals(listOf(SyncTrigger.MANUAL, SyncTrigger.APP_OPEN), SyncTrigger.entries.filter { it.asked })
    }

    @Test
    fun `every trigger has a code the server takes, and no two share one`() {
        val codes = SyncTrigger.entries.map { it.code } + SyncTrigger.BACKFILL_CODE
        assertEquals(listOf("periodic", "alarm", "manual", "app_open", "backfill"), codes)
        assertTrue(codes.all { Regex("^[a-z][a-z0-9_]{0,23}$").matches(it) })
    }

    @Test
    fun `a scheduled sync runs unless another started moments ago`() {
        for (trigger in listOf(SyncTrigger.PERIODIC, SyncTrigger.ALARM)) {
            assertTrue(SyncCadence.shouldRun(trigger, null, NOW))
            assertFalse(SyncCadence.shouldRun(trigger, NOW - minute, NOW))
            assertFalse(SyncCadence.shouldRun(trigger, NOW, NOW))
            assertTrue(SyncCadence.shouldRun(trigger, NOW - SyncCadence.MIN_GAP_MS, NOW))
            assertTrue(SyncCadence.shouldRun(trigger, NOW - SyncCadence.PERIOD_MS, NOW))
            // The clock was set back: the stamp says nothing, and a sync is never held up by it.
            assertTrue(SyncCadence.shouldRun(trigger, NOW + 60 * minute, NOW))
        }
    }

    @Test
    fun `a trigger this build did not write is run as if the owner had asked`() {
        assertEquals(SyncTrigger.MANUAL, SyncTrigger.from(null))
        assertEquals(SyncTrigger.MANUAL, SyncTrigger.from("something_else"))
        assertEquals(SyncTrigger.PERIODIC, SyncTrigger.from("PERIODIC"))
        assertEquals(SyncTrigger.ALARM, SyncTrigger.from("ALARM"))
        assertEquals(SyncTrigger.APP_OPEN, SyncTrigger.from("APP_OPEN"))
    }

    @Test
    fun `the alarm asks for a sync only when none has started for the watchdog's time`() {
        assertTrue(SyncCadence.overdue(null, NOW))
        assertTrue(SyncCadence.overdue(NOW - SyncCadence.WATCHDOG_MS, NOW))
        assertTrue(SyncCadence.overdue(NOW - 4 * 60 * minute, NOW))
        assertFalse(SyncCadence.overdue(NOW - SyncCadence.PERIOD_MS, NOW))
        assertFalse(SyncCadence.overdue(NOW, NOW))
        // A stamp from the future is no evidence that anything ran.
        assertTrue(SyncCadence.overdue(NOW + minute, NOW))
    }

    @Test
    fun `the alarm is set for the watchdog's time after the last sync started`() {
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(null, NOW))
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(NOW, NOW))
        assertEquals(SyncCadence.WATCHDOG_MS - 5 * minute, SyncCadence.nextAlarmInMs(NOW - 5 * minute, NOW))
        // Never closer than a minute, and a full interval once a sync is overdue (it is asked for
        // there and then, and the alarm is what follows it up).
        assertEquals(SyncCadence.MIN_ALARM_MS, SyncCadence.nextAlarmInMs(NOW - SyncCadence.WATCHDOG_MS + 1, NOW))
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(NOW - 60 * minute, NOW))
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(NOW + 60 * minute, NOW))
    }

    @Test
    fun `a run is stuck once it has gone without an end for longer than a run takes`() {
        assertTrue(SyncCadence.RUN_STALL_MS >= SyncCadence.MIN_ALARM_MS)
        // Well inside the period: the point is to come back for the run before the next one would.
        assertTrue(SyncCadence.RUN_STALL_MS < SyncCadence.MIN_GAP_MS)
        assertNull(SyncCadence.openRunStartedMs(null))
        assertNull(SyncCadence.openRunStartedMs(RunRecord(NOW, "periodic", RunRecord.OK)))
        assertNull(SyncCadence.openRunStartedMs(RunRecord(NOW, "periodic", "network")))
        assertEquals(NOW, SyncCadence.openRunStartedMs(RunRecord(NOW, "periodic")))

        assertFalse(SyncCadence.stalled(null, NOW))
        assertFalse(SyncCadence.stalled(NOW, NOW))
        assertFalse(SyncCadence.stalled(NOW - SyncCadence.RUN_STALL_MS + 1, NOW))
        assertTrue(SyncCadence.stalled(NOW - SyncCadence.RUN_STALL_MS, NOW))
        assertTrue(SyncCadence.stalled(NOW - 19 * minute, NOW))
        // A start in the future is the clock set back, not a run that is stuck.
        assertFalse(SyncCadence.stalled(NOW + minute, NOW))
    }

    @Test
    fun `a scheduled sync that comes for a stuck run is not dropped for coming soon after it`() {
        val started = NOW - SyncCadence.RUN_STALL_MS
        for (trigger in listOf(SyncTrigger.PERIODIC, SyncTrigger.ALARM)) {
            // The run that started moments ago ended, or nothing is known of it: too soon.
            assertFalse(SyncCadence.shouldRun(trigger, started, NOW))
            assertFalse(SyncCadence.shouldRun(trigger, started, NOW, openRunStartedMs = null))
            // It has no end and has had time to reach one: this sync is what finishes it.
            assertTrue(SyncCadence.shouldRun(trigger, started, NOW, openRunStartedMs = started))
            // Under way, and not for long: two syncs a moment apart are still one too many.
            assertFalse(SyncCadence.shouldRun(trigger, NOW - minute, NOW, openRunStartedMs = NOW - minute))
        }
    }

    @Test
    fun `the alarm asks for a sync when the run under way is stuck`() {
        val started = NOW - SyncCadence.RUN_STALL_MS
        assertFalse(SyncCadence.overdue(started, NOW))
        assertTrue(SyncCadence.overdue(started, NOW, openRunStartedMs = started))
        assertFalse(SyncCadence.overdue(NOW - minute, NOW, openRunStartedMs = NOW - minute))
        // A run that ended is not come back for.
        assertFalse(SyncCadence.overdue(started, NOW, openRunStartedMs = null))
    }

    @Test
    fun `while a run is under way the alarm stands close behind it`() {
        assertEquals(SyncCadence.RUN_STALL_MS, SyncCadence.nextAlarmInMs(NOW, NOW, openRunStartedMs = NOW))
        assertEquals(
            SyncCadence.RUN_STALL_MS - 30_000,
            SyncCadence.nextAlarmInMs(NOW - 30_000, NOW, openRunStartedMs = NOW - 30_000),
        )
        // Never closer than a minute.
        val nearlyStuck = NOW - SyncCadence.RUN_STALL_MS + 1
        assertEquals(SyncCadence.MIN_ALARM_MS, SyncCadence.nextAlarmInMs(nearlyStuck, NOW, openRunStartedMs = nearlyStuck))
        // Once the run is stuck a sync is asked for, and the alarm is the watchdog's again.
        val stuck = NOW - 5 * minute
        assertEquals(SyncCadence.WATCHDOG_MS - 5 * minute, SyncCadence.nextAlarmInMs(stuck, NOW, openRunStartedMs = stuck))
        // A run that ended leaves the alarm where it was: the watchdog's time after it started.
        assertEquals(SyncCadence.WATCHDOG_MS - minute, SyncCadence.nextAlarmInMs(NOW - minute, NOW, openRunStartedMs = null))
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(NOW + minute, NOW, openRunStartedMs = NOW + minute))
    }

    @Test
    fun `a run is known to be under way before the store says so, and the alarm is not moved out from behind it`() {
        val inFlight = SyncCadence.InFlight()
        assertNull(inFlight.newestStartedMs())
        // The job's run has begun and set its alarm, but has not yet recorded its start: the
        // store still holds the run before, which ended, and that was long enough ago to be
        // overdue. Set by the store alone the alarm would be moved out to the watchdog's time.
        val last = NOW - 18 * minute
        val run = inFlight.begin(NOW)
        assertEquals(SyncCadence.WATCHDOG_MS, SyncCadence.nextAlarmInMs(last, NOW + 100, openRunStartedMs = null))
        assertEquals(
            SyncCadence.RUN_STALL_MS - 100,
            SyncCadence.nextAlarmInMs(last, NOW + 100, openRunStartedMs = inFlight.newestStartedMs()),
        )
        // The run is stuck, and the one that comes for it is the one the alarm then stands behind.
        val rescue = inFlight.begin(NOW + 3 * minute)
        assertEquals(NOW + 3 * minute, inFlight.newestStartedMs())
        inFlight.end(run)
        assertEquals(NOW + 3 * minute, inFlight.newestStartedMs())
        inFlight.end(rescue)
        assertNull(inFlight.newestStartedMs())
        // Two that began in the same millisecond are still two.
        val first = inFlight.begin(NOW)
        val second = inFlight.begin(NOW)
        inFlight.end(first)
        assertEquals(NOW, inFlight.newestStartedMs())
        inFlight.end(second)
        assertNull(inFlight.newestStartedMs())
    }

    @Test
    fun `periodic work that is as it should be is left alone`() {
        assertNull(SyncCadence.periodicPolicy(healthy, NetworkType.CONNECTED))
        // Running, with the attempt that implies, is not "backed off".
        assertNull(SyncCadence.periodicPolicy(healthy.copy(running = true, runAttemptCount = 1), NetworkType.CONNECTED))
    }

    @Test
    fun `periodic work is enqueued when there is none, and updated when it is not what is wanted`() {
        val update = ExistingPeriodicWorkPolicy.UPDATE
        assertEquals(update, SyncCadence.periodicPolicy(null, NetworkType.CONNECTED))
        // Wi-Fi only was switched on, or off.
        assertEquals(update, SyncCadence.periodicPolicy(healthy, NetworkType.UNMETERED))
        assertEquals(update, SyncCadence.periodicPolicy(healthy.copy(network = NetworkType.UNMETERED), NetworkType.CONNECTED))
        // Work an older build enqueued, which also waited for the battery not to be low: that
        // constraint held every scheduled sync back from 15% until well into the next charge.
        assertEquals(update, SyncCadence.periodicPolicy(healthy.copy(otherConstraints = true), NetworkType.CONNECTED))
        assertEquals(update, SyncCadence.periodicPolicy(healthy.copy(periodMs = 60 * minute), NetworkType.CONNECTED))
    }

    @Test
    fun `periodic work the system cut off is taken out of WorkManager's backoff`() {
        assertEquals(
            ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE,
            SyncCadence.periodicPolicy(healthy.copy(runAttemptCount = 3), NetworkType.CONNECTED),
        )
    }

    @Test
    fun `a one-off request replaces one that is waiting and leaves one that is running`() {
        assertEquals(ExistingWorkPolicy.KEEP, SyncCadence.oneOffPolicy(running = true))
        assertEquals(ExistingWorkPolicy.REPLACE, SyncCadence.oneOffPolicy(running = false))
    }

    @Test
    fun `the manifest puts the schedule back after a restart and an update, through a receiver that is not exported`() {
        // Unit tests run with the module directory as the working directory.
        val manifest = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val android = "android:"
        val receivers = manifest.getElementsByTagName("receiver")
        val wake = (0 until receivers.length).map(receivers::item)
            .single { it.attributes.getNamedItem("${android}name").nodeValue == ".sync.SyncWakeReceiver" }
        assertEquals("false", wake.attributes.getNamedItem("${android}exported").nodeValue)
        val actions = manifest.getElementsByTagName("action")
        val declared = (0 until actions.length).map(actions::item)
            .filter { it.parentNode.parentNode === wake }
            .map { it.attributes.getNamedItem("${android}name").nodeValue }
        assertEquals(
            setOf("android.intent.action.BOOT_COMPLETED", "android.intent.action.MY_PACKAGE_REPLACED"),
            declared.toSet(),
        )
        val permissions = manifest.getElementsByTagName("uses-permission")
        val names = (0 until permissions.length).map { permissions.item(it).attributes.getNamedItem("${android}name").nodeValue }
        assertTrue("android.permission.RECEIVE_BOOT_COMPLETED" in names)
        // The watchdog is an inexact alarm: no exact-alarm access, and no service that never ends.
        assertTrue(names.none { "EXACT_ALARM" in it })
        val services = manifest.getElementsByTagName("service")
        val ours = (0 until services.length).map { services.item(it).attributes.getNamedItem("${android}name").nodeValue }
            .filter { it.startsWith(".") }
        assertEquals(listOf(".sync.BackfillService"), ours)
    }
}
