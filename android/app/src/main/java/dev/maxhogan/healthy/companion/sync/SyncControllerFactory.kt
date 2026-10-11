package dev.maxhogan.healthy.companion.sync

import android.content.Context
import dev.maxhogan.healthy.companion.hc.HealthConnectAccess
import kotlinx.coroutines.CoroutineScope

/**
 * What the app hands a [SyncController]: the application context, the stores it must observe,
 * the shared Health Connect doorway, and a scope that lives as long as the process.
 */
class SyncDependencies(
    val context: Context,
    val pairingStore: PairingStore,
    val settings: SyncSettings,
    val healthConnect: HealthConnectAccess,
    val scope: CoroutineScope,
)

/**
 * Seam: the single place a [SyncController] is constructed. The worker, the backfill service
 * and the Tasker receiver reach the engine through the instance this returns.
 */
fun createSyncController(dependencies: SyncDependencies): SyncController =
    EngineSyncController(dependencies)
