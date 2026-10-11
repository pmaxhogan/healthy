package dev.maxhogan.healthy.companion.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Operation
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.maxhogan.healthy.companion.graph
import java.util.concurrent.TimeUnit

/**
 * When syncs run: every 15 minutes while there is a network and the battery is not low, and at
 * once when the owner (or Tasker) asks. With Wi-Fi only on, both wait for an unmetered network.
 */
class SyncScheduler(context: Context) {
    private val workManager: WorkManager by lazy { WorkManager.getInstance(context.applicationContext) }

    /** Idempotent: an existing schedule keeps its timing and takes the new constraints. */
    fun schedulePeriodic(wifiOnly: Boolean) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(PERIOD_MINUTES, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(network(wifiOnly))
                    .setRequiresBatteryNotLow(true)
                    .build(),
            )
            .build()
        workManager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    /**
     * A sync as soon as the network allows. A request while one is pending or running is
     * dropped, which is safe because no sync ever waits in WorkManager's backoff: it runs once
     * and ends, and the periodic schedule is what tries again.
     */
    fun syncNow(wifiOnly: Boolean): Operation {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            // Expedited work may only be constrained by network and storage, so "battery not
            // low" does not apply to a sync the owner asked for.
            .setConstraints(Constraints.Builder().setRequiredNetworkType(network(wifiOnly)).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        return workManager.enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, request)
    }

    fun cancelAll() {
        workManager.cancelUniqueWork(PERIODIC)
        workManager.cancelUniqueWork(NOW)
    }

    private fun network(wifiOnly: Boolean) = if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED

    companion object {
        const val PERIODIC = "healthy.sync.periodic"
        const val NOW = "healthy.sync.now"
        const val PERIOD_MINUTES = 15L
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
 * next one sends. A one-off ("Sync now", app open, Tasker) that waited in backoff would, for
 * its part, swallow every request made in the meantime. Retries within a run stay in the engine.
 */
class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val controller = applicationContext.graph.syncController as? EngineSyncController
            ?: return Result.failure()
        val outcome = outcomeFor(controller.runSync())
        controller.resumeBackfillIfWanted()
        return when (outcome) {
            WorkOutcome.SUCCESS -> Result.success()
            WorkOutcome.FAILURE -> Result.failure()
        }
    }

    companion object {
        /** @param result what the run returned; null when the app is not paired */
        fun outcomeFor(result: RunResult?): WorkOutcome = when (result) {
            // A skipped run is the engine declining to read, not a failure.
            null, RunResult.Success, is RunResult.Skipped -> WorkOutcome.SUCCESS
            is RunResult.Failed, is RunResult.PairingRejected -> WorkOutcome.FAILURE
        }
    }
}
