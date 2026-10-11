package dev.maxhogan.healthy.companion

import android.app.Application
import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore
import dev.maxhogan.healthy.companion.hc.HealthConnectAccess
import dev.maxhogan.healthy.companion.sync.KeystoreTokenCipher
import dev.maxhogan.healthy.companion.sync.PairingStore
import dev.maxhogan.healthy.companion.sync.SyncController
import dev.maxhogan.healthy.companion.sync.SyncDependencies
import dev.maxhogan.healthy.companion.sync.SyncSettings
import dev.maxhogan.healthy.companion.sync.createSyncController
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

private val Context.appDataStore: DataStore<Preferences> by preferencesDataStore(name = "healthy")

/**
 * The process-wide object graph. Built lazily on first use so a worker or receiver that needs
 * only part of it does not pay for the rest, and so there is exactly one of each store.
 */
class AppGraph(context: Context) {
    private val appContext = context.applicationContext

    /**
     * Lives as long as the process; a failure in one child never cancels the others, and never
     * takes the process down: an exception nobody caught ends that one piece of work. It is
     * deliberately not logged, since a message can carry a URL or a record's content.
     */
    val scope: CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default + CoroutineExceptionHandler { _, _ -> })

    val pairingStore: PairingStore by lazy { PairingStore(appContext.appDataStore, KeystoreTokenCipher()) }
    val settings: SyncSettings by lazy { SyncSettings(appContext.appDataStore) }
    val healthConnect: HealthConnectAccess by lazy { HealthConnectAccess(appContext) }

    val syncController: SyncController by lazy {
        createSyncController(SyncDependencies(appContext, pairingStore, settings, healthConnect, scope))
    }
}

class HealthyApp : Application() {
    val graph: AppGraph by lazy { AppGraph(this) }
}

/** The app's object graph, from any [Context] (an activity, a worker, a receiver). */
val Context.graph: AppGraph get() = (applicationContext as HealthyApp).graph
