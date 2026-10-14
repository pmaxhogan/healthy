package dev.maxhogan.healthy.companion.sync

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.await
import androidx.work.workDataOf
import dev.maxhogan.healthy.companion.graph
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * What asked for a sync.
 *
 * @property code what the server is told started the run (`runTrigger` in the state report)
 * @property asked true when the owner asked, which is never skipped for coming too soon
 */
enum class SyncTrigger(val code: String, val asked: Boolean = false) {
    /** WorkManager's periodic work. */
    PERIODIC("periodic"),

    /** The watchdog alarm, because nothing had run for too long. */
    ALARM("alarm"),

    /** The owner: "Sync now", pulling the screen down, the Tasker action. Never skipped. */
    MANUAL("manual", asked = true),

    /** The owner opened the app, which is a request for fresh data. Never skipped either. */
    APP_OPEN("app_open", asked = true),
    ;

    companion object {
        /**
         * What a batch says started it when no sync did: the backfill loop uploaded it. Not a
         * trigger, since nothing asks for a sync with it.
         */
        const val BACKFILL_CODE = "backfill"

        /** A request this build did not write (an older build's work) is run, not second-guessed. */
        fun from(name: String?): SyncTrigger = entries.firstOrNull { it.name == name } ?: MANUAL
    }
}

/**
 * When a sync is due, as plain arithmetic the tests can hold to.
 *
 * Two things ask for the scheduled sync. WorkManager's periodic work is the ordinary one. It
 * runs as a job, and the system holds jobs back for reasons that have nothing to do with this
 * app and are recorded nowhere: every app's ordinary jobs stop while the phone is hot, and they
 * are deferred while it dozes. So an
 * alarm stands behind it as a watchdog: set for [WATCHDOG_MS] after every sync that starts, it
 * only ever goes off when the periodic work has not run in time, and then asks for the sync
 * itself, as expedited work, which the system is far more willing to run then (though a phone
 * that is hot enough holds even that back).
 *
 * The alarm also stands behind a run that has started. A run is only safe from the system while
 * the job that started it lasts, and that job can end under it: when the job is what started the
 * process, WorkManager, coming up, puts its schedule back, which replaces the very job that is
 * running, and then runs the work itself, in the process, whether or not the system has started
 * the replacement. A run left like that goes on for a few seconds and is then frozen with the
 * rest of a process nothing is running in, half-way through its types, until something wakes the
 * process: measured on a phone, that was this alarm, seventeen minutes on, and the types the run
 * had not reached arrived that late. So while a run is under way the alarm is set for
 * [RUN_STALL_MS] after its start instead. One that goes off finds the run still without an end
 * and asks for a sync as expedited work: its job is what thaws the process and holds it while
 * the frozen run finishes (the new sync waits for the engine's lock meanwhile), and it then
 * reads whatever came in since.
 */
object SyncCadence {
    const val PERIOD_MS = 15 * 60_000L

    /** A little past the period, so that the periodic work, when it is on time, is first. */
    const val WATCHDOG_MS = 17 * 60_000L

    /** A scheduled sync this soon after another would read everything again for nothing. */
    const val MIN_GAP_MS = 10 * 60_000L

    /** The alarm is never set closer than this: an inexact alarm is not that precise anyway. */
    const val MIN_ALARM_MS = 60_000L

    /**
     * How long a run may go without an end before it is taken to be stuck. A run takes seconds,
     * a minute when a month of hourly totals is recomputed for several types; one that is still
     * going after this either lost its job and was frozen, or died with its process.
     */
    const val RUN_STALL_MS = 2 * 60_000L

    /** When the run that has no end yet started, or null when the latest run ended (or none ran). */
    fun openRunStartedMs(run: RunRecord?): Long? = run?.takeIf { it.end == null }?.startedAtMs

    /**
     * Whether a run that started at [openRunStartedMs] and has recorded no end is stuck. A start
     * in the future means the clock was set back, and says nothing.
     */
    fun stalled(openRunStartedMs: Long?, nowMs: Long): Boolean =
        openRunStartedMs != null && nowMs - openRunStartedMs >= RUN_STALL_MS

    /**
     * Whether a sync asked for by [trigger] should run. One the owner asked for always does. A
     * scheduled one is dropped when another sync started less than [MIN_GAP_MS] ago, which is
     * what happens when the alarm and the periodic work fire a moment apart; unless that sync is
     * stuck ([stalled]), when this one is what gets it finished.
     *
     * @param openRunStartedMs see [openRunStartedMs]
     */
    fun shouldRun(trigger: SyncTrigger, lastAttemptMs: Long?, nowMs: Long, openRunStartedMs: Long? = null): Boolean {
        if (trigger.asked || lastAttemptMs == null) return true
        if (stalled(openRunStartedMs, nowMs)) return true
        // A last attempt in the future means the clock was set back: nothing can be told from it.
        return nowMs - lastAttemptMs !in 0 until MIN_GAP_MS
    }

    /**
     * Whether, when the alarm goes off, a sync has to be asked for: none has started for the
     * watchdog's time, or the one that did is stuck.
     */
    fun overdue(lastAttemptMs: Long?, nowMs: Long, openRunStartedMs: Long? = null): Boolean =
        lastAttemptMs == null || nowMs - lastAttemptMs !in 0 until WATCHDOG_MS || stalled(openRunStartedMs, nowMs)

    /**
     * How long from now the alarm should next go off: [WATCHDOG_MS] after the last attempt, or,
     * while a run is under way, [RUN_STALL_MS] after it started.
     */
    fun nextAlarmInMs(lastAttemptMs: Long?, nowMs: Long, openRunStartedMs: Long? = null): Long {
        if (openRunStartedMs != null && nowMs >= openRunStartedMs && !stalled(openRunStartedMs, nowMs)) {
            return (RUN_STALL_MS - (nowMs - openRunStartedMs)).coerceIn(MIN_ALARM_MS, RUN_STALL_MS)
        }
        if (lastAttemptMs == null || overdue(lastAttemptMs, nowMs)) return WATCHDOG_MS
        return (WATCHDOG_MS - (nowMs - lastAttemptMs)).coerceIn(MIN_ALARM_MS, WATCHDOG_MS)
    }

    /**
     * The runs this process has under way, by when each was begun.
     *
     * The store only says a run is under way once the engine has recorded its start, which comes
     * after the phone's grants have been read. Whoever sets the alarm in between (the schedule is
     * put back as the process starts, at the same moment as the job's run begins) would set it by
     * the run before, and move the alarm that stands behind this one out to the watchdog's time.
     * So a run is known here from before its alarm is set until it has returned.
     *
     * There can be two: a run that is stuck, and the one that came for it and waits for the lock.
     */
    class InFlight {
        private val started = ArrayList<Long>()

        /** A run begins at [nowMs]. Returns what to hand to [end]. */
        @Synchronized
        fun begin(nowMs: Long): Long {
            started.add(nowMs)
            return nowMs
        }

        /** The run [begin] returned [startedMs] for is over, however it ended. */
        @Synchronized
        fun end(startedMs: Long) {
            started.remove(startedMs)
        }

        /** When the newest run still under way began: the one the alarm stands behind. */
        @Synchronized
        fun newestStartedMs(): Long? = started.maxOrNull()
    }

    /**
     * The periodic work as WorkManager holds it now.
     *
     * @property running false while it waits for its next run
     * @property runAttemptCount above zero while waiting means the last run was cut off by the
     *   system and the work is in WorkManager's backoff, which doubles up to five hours
     * @property otherConstraints true when it waits for anything but a network (an older build
     *   also asked for the battery not to be low)
     */
    data class Periodic(
        val running: Boolean,
        val runAttemptCount: Int,
        val network: NetworkType,
        val otherConstraints: Boolean,
        val periodMs: Long,
    )

    /**
     * What to do about the periodic work, given what is [existing]; null leaves it alone.
     *
     * Work that is as it should be is not touched, so that starting the process (which happens
     * for every run) does not re-plan the job each time. Work in backoff is replaced: its
     * backoff is WorkManager's, not this app's, and can reach hours. Anything else that differs
     * is updated in place, which keeps its timing.
     */
    fun periodicPolicy(existing: Periodic?, network: NetworkType): ExistingPeriodicWorkPolicy? = when {
        existing == null -> ExistingPeriodicWorkPolicy.UPDATE
        !existing.running && existing.runAttemptCount > 0 -> ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE
        existing.network != network || existing.otherConstraints || existing.periodMs != PERIOD_MS ->
            ExistingPeriodicWorkPolicy.UPDATE
        else -> null
    }

    /**
     * What to do with a one-off sync request when one may already exist. A sync that is running
     * is left to finish, and the new request dropped: the running one is doing the same work.
     * One that is only waiting is replaced, so that a request cannot sit behind a retry
     * WorkManager has backed off, and so that the newest trigger is the one that counts.
     */
    fun oneOffPolicy(running: Boolean): ExistingWorkPolicy =
        if (running) ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE
}

/**
 * When syncs run: every 15 minutes while there is a network, and at once when the owner (or
 * Tasker) asks. With Wi-Fi only on, both wait for an unmetered network. Nothing else is asked
 * of the system: in particular not a battery that is not low. That constraint stopped every
 * scheduled sync from the moment the phone fell to 15% until it had been charged well past it,
 * with no error to show for it, since a sync that is never started records nothing.
 */
class SyncScheduler(context: Context) {
    private val workManager: WorkManager by lazy { WorkManager.getInstance(context.applicationContext) }

    /** Idempotent: a schedule that is already right is left alone, and keeps its timing. */
    suspend fun schedulePeriodic(wifiOnly: Boolean) {
        val network = network(wifiOnly)
        val existing = existing(PERIODIC)?.let { info ->
            val constraints = info.constraints
            SyncCadence.Periodic(
                running = info.state == WorkInfo.State.RUNNING,
                runAttemptCount = info.runAttemptCount,
                network = constraints.requiredNetworkType,
                otherConstraints = constraints.requiresBatteryNotLow() || constraints.requiresCharging() ||
                    constraints.requiresDeviceIdle() || constraints.requiresStorageNotLow(),
                periodMs = info.periodicityInfo?.repeatIntervalMillis ?: 0,
            )
        }
        val policy = SyncCadence.periodicPolicy(existing, network) ?: return
        val request = PeriodicWorkRequestBuilder<SyncWorker>(SyncCadence.PERIOD_MS, TimeUnit.MILLISECONDS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network).build())
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to SyncTrigger.PERIODIC.name))
            .build()
        workManager.enqueueUniquePeriodicWork(PERIODIC, policy, request).await()
    }

    /**
     * A sync as soon as the network allows, as expedited work: the system runs that while the
     * phone dozes and while it holds ordinary jobs back. Returns once WorkManager has it on disk.
     */
    suspend fun syncNow(wifiOnly: Boolean, trigger: SyncTrigger) {
        val running = existing(NOW)?.state == WorkInfo.State.RUNNING
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            // Expedited work may only be constrained by network and storage.
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network(wifiOnly)).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setInputData(workDataOf(SyncWorker.KEY_TRIGGER to trigger.name))
            .build()
        workManager.enqueueUniqueWork(NOW, SyncCadence.oneOffPolicy(running), request).await()
    }

    fun cancelAll() {
        workManager.cancelUniqueWork(PERIODIC)
        workManager.cancelUniqueWork(NOW)
    }

    /** The unfinished work under [name], or null when there is none (or it cannot be asked). */
    private suspend fun existing(name: String): WorkInfo? = try {
        workManager.getWorkInfosForUniqueWorkFlow(name).first().firstOrNull { !it.state.isFinished }
    } catch (_: RuntimeException) {
        null
    }

    private fun network(wifiOnly: Boolean) = if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED

    companion object {
        const val PERIODIC = "healthy.sync.periodic"
        const val NOW = "healthy.sync.now"
    }
}

/**
 * The watchdog behind the periodic work: one inexact alarm, set again by every sync that starts
 * and by itself. See [SyncCadence].
 *
 * It is `setAndAllowWhileIdle`, which needs no permission and no exact-alarm access. For an app
 * the owner has exempted from battery optimisation the system delivers it on time even while the
 * phone dozes; for any other app it may come up to several minutes late there, which is still far
 * better than a job that waits for the phone to be picked up.
 */
class SyncAlarm(context: Context) {
    private val context = context.applicationContext

    fun arm(delayMs: Long) {
        try {
            context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + delayMs,
                intent(),
            )
        } catch (_: RuntimeException) {
            // Without it the periodic work is what there is, as before.
        }
    }

    fun cancel() {
        try {
            context.getSystemService(AlarmManager::class.java).cancel(intent())
        } catch (_: RuntimeException) {
            // Nothing was set.
        }
    }

    private fun intent(): PendingIntent = PendingIntent.getBroadcast(
        context,
        0,
        Intent(context, SyncWakeReceiver::class.java).setAction(SyncWakeReceiver.ACTION_TICK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/**
 * Puts the schedule back and asks for a sync that is overdue: when the watchdog alarm goes off,
 * after the phone has started, and after the app was updated. The last two matter because an
 * alarm does not survive a restart, and because the app is updated often and nothing else runs
 * its code afterwards until the owner opens it.
 *
 * Not exported: the alarm is this app's own pending intent, and the other two come from the
 * system. It reads nothing from the intent but its action.
 */
class SyncWakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in ACTIONS) return
        val graph = context.graph
        // Held until the request is with WorkManager; the sync itself runs as its work.
        val pending = goAsync()
        graph.scope.launch {
            try {
                (graph.syncController as? EngineSyncController)?.onWake()
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_TICK = "dev.maxhogan.healthy.companion.sync.TICK"
        private val ACTIONS = setOf(ACTION_TICK, Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)
    }
}

/** What a finished sync means to WorkManager. */
enum class WorkOutcome { SUCCESS, FAILURE }

/**
 * One incremental sync.
 *
 * It never asks WorkManager to retry, for the periodic work as much as for a one-off. A periodic
 * work that returns "retry" is not run again at its period: WorkManager runs it after its
 * backoff instead, which doubles from 30 seconds to a cap of five hours, so a phone that had
 * been failing for a while would sync every few hours rather than every fifteen minutes, and
 * the server would call it stale. Here the fifteen-minute period IS the retry: every run starts
 * from the last acknowledged position, so whatever a failed run could not deliver is what the
 * next one sends. Retries within a run stay in the engine. (A run the system itself cuts off
 * does land in that backoff; [SyncCadence.periodicPolicy] and [SyncCadence.oneOffPolicy] are
 * what get it out again.)
 */
class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val controller = applicationContext.graph.syncController as? EngineSyncController
            ?: return Result.failure()
        val outcome = outcomeFor(controller.runSync(SyncTrigger.from(inputData.getString(KEY_TRIGGER))))
        controller.resumeBackfillIfWanted()
        return when (outcome) {
            WorkOutcome.SUCCESS -> Result.success()
            WorkOutcome.FAILURE -> Result.failure()
        }
    }

    companion object {
        const val KEY_TRIGGER = "trigger"

        /** @param result what the run returned; null when the app is not paired or the run was not due */
        fun outcomeFor(result: RunResult?): WorkOutcome = when (result) {
            // A skipped run is the engine declining to read, not a failure.
            null, RunResult.Success, is RunResult.Skipped -> WorkOutcome.SUCCESS
            is RunResult.Failed, is RunResult.PairingRejected -> WorkOutcome.FAILURE
        }
    }
}
