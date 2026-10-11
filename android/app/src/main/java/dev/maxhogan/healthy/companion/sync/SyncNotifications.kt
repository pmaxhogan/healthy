package dev.maxhogan.healthy.companion.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import dev.maxhogan.healthy.companion.R
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The two notifications the engine posts: backfill progress (required by the foreground service)
 * and a warning when syncs keep failing. Texts carry counts and stable error codes only.
 *
 * Posting needs the `POST_NOTIFICATIONS` runtime permission; without it the system drops these
 * silently, which is the owner's choice to make.
 */
class SyncNotifications(private val context: Context) {
    private val manager: NotificationManager = context.getSystemService(NotificationManager::class.java)
    private var shown: String? = null
    private var shownAtMs = 0L

    /**
     * @param waiting set while the backfill is waiting something out: the code of what, and when
     *   it tries again. The owner looking at the shade then sees why the count is not moving
     */
    fun backfill(progress: BackfillProgress, waiting: BackfillWait? = null): Notification {
        ensureChannels()
        val total = progress.totalUnits
        val builder = Notification.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Uploading health history")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openApp())
        builder.setContentText(backfillText(progress, waiting))
        if (total == null || total <= 0) {
            builder.setProgress(0, 0, true)
        } else {
            builder.setProgress(total, progress.doneUnits.coerceAtMost(total), false)
        }
        return builder.build()
    }

    /**
     * Posts the progress notification when what it says has changed, and at most about once a
     * second. A backfill step can take a few milliseconds (an empty month, a type's setup), and
     * the system sheds notification updates that come faster than a handful a second anyway.
     *
     * @param force for a change the owner must not miss: the start and the end of a wait
     */
    @Synchronized
    fun updateBackfill(progress: BackfillProgress, waiting: BackfillWait? = null, force: Boolean = false) {
        val text = backfillText(progress, waiting)
        val now = System.currentTimeMillis()
        if (!shouldPost(shown, text, now - shownAtMs, force)) return
        shown = text
        shownAtMs = now
        manager.notify(ID_BACKFILL, backfill(progress, waiting))
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

        /** The least time between two progress updates that nothing forces. */
        const val MIN_UPDATE_INTERVAL_MS = 1_000L

        private val TIME = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

        /**
         * The progress line. Units are (record type, month) pairs, as on the status screen.
         * While waiting it also says until when and for what, by code.
         */
        fun backfillText(progress: BackfillProgress, waiting: BackfillWait?, zone: ZoneId = ZoneId.systemDefault()): String {
            val total = progress.totalUnits
            val counts = if (total == null || total <= 0) {
                "Measuring how far back the history goes"
            } else {
                "${progress.doneUnits} of $total type-months"
            }
            if (waiting == null) return counts
            val until = TIME.format(Instant.ofEpochMilli(waiting.untilMs).atZone(zone))
            return "$counts. Waiting until $until (${waiting.errorCode})"
        }

        /** Whether a progress update is worth posting: see [updateBackfill]. */
        fun shouldPost(shown: String?, text: String, sinceLastMs: Long, force: Boolean): Boolean = when {
            text == shown -> false
            force || shown == null -> true
            // A clock that went backwards must not silence the notification.
            else -> sinceLastMs >= MIN_UPDATE_INTERVAL_MS || sinceLastMs < 0
        }
    }
}

/** What a waiting backfill is waiting for, and until when (epoch ms). */
data class BackfillWait(val errorCode: String, val untilMs: Long)
