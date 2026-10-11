package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import kotlinx.coroutines.flow.StateFlow

/**
 * Seam between the UI and the sync engine. The UI calls nothing else in `.sync` except
 * [PairingStore] (to save or clear a pairing).
 *
 * The app holds exactly one instance for the life of the process, built by
 * [createSyncController]; replacing the engine means changing that one function.
 *
 * Contract for implementations:
 * - every method returns immediately and is safe to call from the main thread; the work runs
 *   on the implementation's own scope and its progress shows up in [state];
 * - no method throws. A failure becomes [SyncUiState.lastError];
 * - calls made while unpaired, or while the same work is already running, are no-ops;
 * - [state] is always complete: [SyncUiState.types] holds a row for every type in
 *   `RecordTypes.ALL`, whether or not it is granted or has ever had data.
 */
interface SyncController {
    /** Everything the status screen shows. Starts as [SyncUiState] defaults until first loaded. */
    val state: StateFlow<SyncUiState>

    /** Run one incremental sync now (the "Sync now" button, pull-to-refresh, app open). */
    fun syncNow()

    /**
     * Start, or resume, the full-history backfill (newest month first, foreground service).
     * Called when the backfill is already complete, it runs the whole backfill again from the
     * newest month: everything is re-read and re-uploaded, which the server absorbs by record
     * id. The UI asks the owner to confirm before calling it in that state.
     */
    fun startBackfill()

    /**
     * Re-read what can change behind the app's back: Health Connect grants and the battery
     * optimisation exemption. The UI calls it on resume and after a permission dialog closes.
     */
    fun refresh()

    /** Persist the Wi-Fi-only preference and re-plan scheduled work to match. */
    fun setWifiOnly(enabled: Boolean)
}

/** One immutable snapshot of what the status screen renders. */
data class SyncUiState(
    val pairing: PairingState = PairingState.Loading,
    /** Health Connect availability and grants, including background and history read. */
    val access: HealthAccess = HealthAccess.none(HealthConnectStatus.UNAVAILABLE),
    val activity: SyncActivity = SyncActivity.IDLE,
    /** Epoch ms of the last sync the server acknowledged, or null when there has been none. */
    val lastSyncMs: Long? = null,
    /** Records and deletions read from Health Connect but not yet acknowledged by the server. */
    val backlog: Long = 0,
    /** The most recent failure, cleared by the next successful sync. */
    val lastError: SyncError? = null,
    /**
     * Why the latest run read nothing on purpose (in the background without the background-read
     * grant), or null. Shown as well as [lastError], never instead of it.
     */
    val skipReason: SyncError? = null,
    val backfill: BackfillProgress = BackfillProgress(),
    val wifiOnly: Boolean = false,
    /** Whether the app is exempt from battery optimisation (background syncs are reliable). */
    val batteryExempt: Boolean = false,
    /**
     * Whether the app is exempt from "remove permissions if app is unused". Without it the
     * system withdraws the Health Connect grants of an app nobody opens, and syncing stops.
     */
    val hibernationExempt: Boolean = false,
    /** One row per record type, in `RecordTypes.ALL` order. */
    val types: List<TypeRow> = emptyList(),
)

sealed interface PairingState {
    /** The stored pairing has not been read yet; show neither "paired" nor "not paired". */
    data object Loading : PairingState

    data object NotPaired : PairingState

    /** Paired. The token is deliberately not part of UI state. */
    data class Paired(val url: String, val deviceId: String) : PairingState
}

enum class SyncActivity { IDLE, SYNCING, BACKFILLING }

/**
 * @property errorCode a stable machine code (`unauthorized`, `network`, `rate_limited`, …),
 *   never a message that could carry record content
 * @property atMs epoch ms of the failure
 * @property consecutiveFailures how many syncs in a row have failed, this one included
 * @property retryAtMs epoch ms of the next attempt while the failure is being waited out (the
 *   backfill backing off), else null
 */
data class SyncError(
    val errorCode: String,
    val atMs: Long,
    val consecutiveFailures: Int = 1,
    val retryAtMs: Long? = null,
)

/**
 * Backfill progress in units of (record type, month).
 *
 * @property totalUnits null until the engine knows how far back the history goes
 * @property oldestDoneMs epoch ms of the start of the oldest month fully uploaded so far
 * @property errorCode why an unfinished type's backfill last stopped, or null; the reason to
 *   show beside "Paused"
 */
data class BackfillProgress(
    val phase: BackfillPhase = BackfillPhase.NOT_STARTED,
    val doneUnits: Int = 0,
    val totalUnits: Int? = null,
    val oldestDoneMs: Long? = null,
    val errorCode: String? = null,
)

enum class BackfillPhase { NOT_STARTED, RUNNING, PAUSED, COMPLETE }

/**
 * One line of the coverage table.
 *
 * @property type wire type name (`HeartRate`, `SleepSession`, …)
 * @property firstMs epoch ms of the earliest record uploaded for this type, or null for none
 * @property lastMs epoch ms of the latest record uploaded for this type, or null for none
 * @property uploaded records of this type the server has accepted
 * @property rejected records of this type the server refused one by one; they are not stored
 * @property stubbed records too large to upload, sent as a placeholder with their times and size
 */
data class TypeRow(
    val type: String,
    val permission: Grant,
    val firstMs: Long? = null,
    val lastMs: Long? = null,
    val uploaded: Long = 0,
    val rejected: Long = 0,
    val stubbed: Long = 0,
)
