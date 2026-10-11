package dev.maxhogan.healthy.companion.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import dev.maxhogan.healthy.companion.R

/**
 * The two notifications the engine posts: backfill progress (required by the foreground service)
 * and a warning when syncs keep failing. Texts carry counts and stable error codes only.
 *
 * Posting needs the `POST_NOTIFICATIONS` runtime permission; without it the system drops these
 * silently, which is the owner's choice to make.
 */
class SyncNotifications(private val context: Context) {
    private val manager: NotificationManager = context.getSystemService(NotificationManager::class.java)

    fun backfill(progress: BackfillProgress): Notification {
        ensureChannels()
        val total = progress.totalUnits
        val builder = Notification.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Uploading health history")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
        if (total == null || total <= 0) {
            builder.setContentText("Measuring how far back the history goes")
            builder.setProgress(0, 0, true)
        } else {
            builder.setContentText("${progress.doneUnits} of $total months")
            builder.setProgress(total, progress.doneUnits.coerceAtMost(total), false)
        }
        return builder.build()
    }

    fun updateBackfill(progress: BackfillProgress) {
        manager.notify(ID_BACKFILL, backfill(progress))
    }

    fun showFailure(errorCode: String, consecutiveFailures: Int) {
        ensureChannels()
        val text = ErrorMessages.describe(errorCode) +
            if (consecutiveFailures > 1) " ($consecutiveFailures syncs in a row, $errorCode)" else " ($errorCode)"
        val notification = Notification.Builder(context, CHANNEL_PROBLEMS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Health data is not syncing")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(openApp())
            .build()
        manager.notify(ID_FAILURE, notification)
    }

    fun clearFailure() {
        manager.cancel(ID_FAILURE)
    }

    private fun openApp(): PendingIntent? {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE)
    }

    private fun ensureChannels() {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, "History upload", NotificationManager.IMPORTANCE_LOW),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_PROBLEMS, "Sync problems", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    companion object {
        const val CHANNEL_PROGRESS = "sync.progress"
        const val CHANNEL_PROBLEMS = "sync.problems"
        const val ID_BACKFILL = 1001
        const val ID_FAILURE = 1002

        /** Failed syncs in a row before the owner is told. */
        const val FAILURE_THRESHOLD = 3
    }
}
