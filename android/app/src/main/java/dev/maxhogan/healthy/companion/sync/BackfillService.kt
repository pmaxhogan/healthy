package dev.maxhogan.healthy.companion.sync

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import dev.maxhogan.healthy.companion.graph
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the process alive while the history backfill runs, with a progress notification.
 *
 * The service holds no state of its own: the cursor of every type is in the [SyncStateStore], so
 * being killed and restarted (it is sticky) resumes at the page after the last one acknowledged.
 *
 * Its foreground type is `health`, which the platform allows only while one of a short list of
 * permissions is held: of the ones this app asks for, the Health Connect heart rate, skin
 * temperature and oxygen saturation read permissions. Should none of them be granted, or should
 * the system refuse the start (from the background without the background-read grant), the
 * service does not run and the backfill shows as paused. There is deliberately no `dataSync`
 * fallback: that type is time-limited, which does not suit a backfill.
 */
class BackfillService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val controller = graph.syncController as? EngineSyncController
        if (controller == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = controller.notifications.backfill(controller.state.value.backfill)
        val started = try {
            startForeground(SyncNotifications.ID_BACKFILL, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
            true
        } catch (_: RuntimeException) {
            // Not allowed from here: started from the background, or the prerequisite
            // permission was revoked since the check in start().
            false
        }
        if (!started) {
            controller.noteBackfillNotStarted()
            stopSelf()
            return START_NOT_STICKY
        }
        if (job?.isActive != true) {
            job = scope.launch {
                try {
                    controller.runBackfill()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Nothing the loop throws may take the process down: the service stops, the
                    // backfill shows as paused, and the cursors in the store are where they were.
                } finally {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private val HEALTH_PREREQUISITES = listOf(
            "android.permission.health.READ_HEART_RATE",
            "android.permission.health.READ_SKIN_TEMPERATURE",
            "android.permission.health.READ_OXYGEN_SATURATION",
        )

        /** Whether the platform would let a `health` foreground service start right now. */
        fun prerequisiteHeld(context: Context): Boolean =
            HEALTH_PREREQUISITES.any { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

        /** False when the system refused to start the service (the app is in the background). */
        fun start(context: Context): Boolean = try {
            // Asking for a foreground service and then not becoming one is a crash, so do not
            // ask when the type could not be used.
            prerequisiteHeld(context) &&
                context.startForegroundService(Intent(context, BackfillService::class.java)) != null
        } catch (_: RuntimeException) {
            false
        }
    }
}
