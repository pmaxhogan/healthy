package dev.maxhogan.healthy.companion.tasker

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import dev.maxhogan.healthy.companion.graph
import dev.maxhogan.healthy.companion.sync.EngineSyncController
import kotlinx.coroutines.launch

/**
 * The app as a Tasker (Locale-protocol) plugin with one action, "Trigger refresh".
 *
 * The protocol is two intents and no library. The host opens an activity with
 * [TaskerPlugin.ACTION_EDIT] so the user can configure the action; the activity answers with a
 * bundle the host stores and a one-line description. When the task runs, the host broadcasts
 * [TaskerPlugin.ACTION_FIRE] with that bundle.
 */
object TaskerPlugin {
    const val ACTION_EDIT = "com.twofortyfouram.locale.intent.action.EDIT_SETTING"
    const val ACTION_FIRE = "com.twofortyfouram.locale.intent.action.FIRE_SETTING"
    const val EXTRA_BUNDLE = "com.twofortyfouram.locale.intent.extra.BUNDLE"
    const val EXTRA_BLURB = "com.twofortyfouram.locale.intent.extra.BLURB"

    /** The only key in the stored bundle: which action this is, so more can be added later. */
    const val KEY_ACTION = "dev.maxhogan.healthy.companion.tasker.ACTION"
    const val ACTION_REFRESH = "refresh"
    const val BLURB = "Trigger refresh"

    /** Whether a fired intent is this plugin's refresh action. Anything else is ignored. */
    fun isRefresh(action: String?, storedAction: String?): Boolean =
        action == ACTION_FIRE && storedAction == ACTION_REFRESH
}

/**
 * The "configuration" screen of an action that has nothing to configure: it answers the host at
 * once and never draws anything.
 */
class TaskerEditActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent?.action == TaskerPlugin.ACTION_EDIT) {
            val stored = Bundle().apply { putString(TaskerPlugin.KEY_ACTION, TaskerPlugin.ACTION_REFRESH) }
            setResult(
                RESULT_OK,
                Intent()
                    .putExtra(TaskerPlugin.EXTRA_BUNDLE, stored)
                    .putExtra(TaskerPlugin.EXTRA_BLURB, TaskerPlugin.BLURB),
            )
        } else {
            setResult(RESULT_CANCELED)
        }
        finish()
    }
}

/**
 * Runs the action: the same sync the "Sync now" button asks for. It is queued as expedited
 * work, so the host does not wait on the network; the receiver only stays alive (`goAsync`)
 * for the moment it takes to hand the request to WorkManager.
 *
 * Exported, as the protocol requires, and safe to be: all any caller can do is ask for a sync
 * the app would have run within fifteen minutes anyway. Nothing is read from the intent beyond
 * the marker this plugin stored itself.
 */
class TaskerFireReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val stored = try {
            intent.getBundleExtra(TaskerPlugin.EXTRA_BUNDLE)?.getString(TaskerPlugin.KEY_ACTION)
        } catch (_: RuntimeException) {
            // A bundle from another app that does not unparcel here.
            null
        }
        if (!TaskerPlugin.isRefresh(intent.action, stored)) return
        val graph = context.graph
        // The process may have been started for this broadcast alone and can be reaped the
        // moment onReceive returns. Hold it until the sync request is safely with WorkManager.
        val pending = goAsync()
        graph.scope.launch {
            try {
                when (val controller = graph.syncController) {
                    is EngineSyncController -> controller.requestSync()
                    else -> controller.syncNow()
                }
            } finally {
                pending.finish()
            }
        }
    }
}
