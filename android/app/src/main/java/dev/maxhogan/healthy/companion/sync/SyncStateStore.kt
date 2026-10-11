package dev.maxhogan.healthy.companion.sync

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.maxhogan.healthy.companion.hc.Grant
import java.security.MessageDigest
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/** A failure worth remembering. [errorCode] is a stable code, never a message. */
@Serializable
data class StoredError(val errorCode: String, val atMs: Long)

/**
 * A re-read of recent history that replaces an expired changes token.
 *
 * [newToken] was taken before the re-read began and becomes the type's token only when the last
 * page has been acknowledged, so a crash part-way resumes the re-read instead of skipping it.
 */
@Serializable
data class RereadState(
    val newToken: String,
    val newTokenCreatedMs: Long,
    val startMs: Long,
    val endMs: Long,
    val pageToken: String? = null,
)

/**
 * Where one type's history backfill stands. Months are UTC calendar months, identified by the
 * epoch ms of their first instant, and are read from [topMonthMs] down to [floorMonthMs].
 *
 * @property monthMs the month being read now
 * @property pageToken the next page of [monthMs] to read, or null for its first page
 * @property pageSize the page size the pages of [monthMs] are being read with. A month is read
 *   to its end at the size it was started with, so a page token is only ever used with the size
 *   that produced it. Null with a token means the default of the build that wrote it
 * @property oldestDoneMs the oldest month fully acknowledged so far
 * @property fullHistory false when only the platform's recent window was readable
 * @property rerun true when the owner asked for the whole history again after a backfill that
 *   had finished. A re-run also has to take away what is no longer there: the platform totals
 *   of hours that have none any more
 * @property rerunFloorMs the floor of the backfill this one repeats, kept until the new range is
 *   measured, so that months which have since lost all their records are still walked
 * @property rerunTopMs likewise, the top of the backfill this one repeats
 */
@Serializable
data class BackfillState(
    val started: Boolean = false,
    val complete: Boolean = false,
    val topMonthMs: Long? = null,
    val floorMonthMs: Long? = null,
    val monthMs: Long? = null,
    val pageToken: String? = null,
    val pageSize: Int? = null,
    val oldestDoneMs: Long? = null,
    val fullHistory: Boolean = false,
    val rerun: Boolean = false,
    val rerunFloorMs: Long? = null,
    val rerunTopMs: Long? = null,
)

/**
 * A backfill session ended with work it could not do, and starting the service again would only
 * end the same way. Persisted, so that a process restart does not forget it and post the
 * backfill notification once more before stopping again.
 *
 * It holds for as long as nothing the app can observe has changed: the same grants, the same
 * pairing, the same build. See [lifted].
 *
 * @property fingerprint what the phone allowed and who it was paired with when it gave up
 * @property appVersion the build that gave up; a newer one may not have its problem
 * @property retryAtMs for a cause that can pass by itself (Health Connect misbehaving, a request
 *   the server could not read), when one more attempt is allowed. Null when only a change helps
 */
@Serializable
data class BackfillGaveUp(
    val errorCode: String,
    val atMs: Long,
    val fingerprint: String,
    val appVersion: String = "",
    val retryAtMs: Long? = null,
) {
    /**
     * Whether the reason is gone, as far as can be told without trying.
     *
     * @param appVersion null to leave the build out of it
     */
    fun lifted(fingerprint: String, appVersion: String?, nowMs: Long): Boolean {
        if (fingerprint != this.fingerprint) return true
        if (appVersion != null && appVersion != this.appVersion) return true
        val retryAt = retryAtMs ?: return false
        // A retry time further off than the wait itself means the clock was set back: do not
        // wait a day for an hour to pass.
        return nowMs >= retryAt || retryAt - nowMs > RETRY_MS
    }

    companion object {
        /** How long a backfill that gave up on a passing cause waits before it may try again. */
        const val RETRY_MS = 60 * 60_000L

        /**
         * Causes time alone does not lift: the owner has to act, or a new build has to (a record
         * that cannot be made small enough will be exactly as large an hour from now).
         */
        val PERMANENT = setOf(
            "unauthorized",
            "permission_denied",
            "unknown_record_type",
            "backfill_state_invalid",
            "record_too_large",
            "payload_too_large",
        )

        /**
         * A short digest of everything whose change is a reason to try again: which types are
         * granted, the history and background grants, whether a read can be trusted from where
         * the app is, and which act of pairing this is.
         */
        fun fingerprint(types: List<String>, session: Session): String {
            val text = buildString {
                for (type in types) if (session.access.types[type] == Grant.GRANTED) append(type).append(',')
                append('|').append(session.access.historyRead.name)
                append('|').append(session.access.backgroundRead.name)
                append('|').append(session.canRead)
                append('|').append(session.pairing.deviceId)
                append('|').append(SyncEngine.pairingTag(session))
            }
            return MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
                .take(8).joinToString("") { "%02x".format(it) }
        }
    }
}

/** Everything remembered about one record type. */
@Serializable
data class TypeState(
    val token: String? = null,
    /** When [token] was obtained: its age is how long this type has gone without advancing. */
    val tokenCreatedMs: Long? = null,
    val reread: RereadState? = null,
    val backfill: BackfillState = BackfillState(),
    /** Records of this type the server has acknowledged. */
    val uploaded: Long = 0,
    /** Records the server would not take: rejected within a batch, or refused on their own. */
    val rejected: Long = 0,
    /** Records too large to send, uploaded as a stub that carries their envelope and size. */
    val stubbed: Long = 0,
    val firstMs: Long? = null,
    val lastMs: Long? = null,
    /** Changes read from Health Connect and not yet acknowledged. */
    val backlog: Long = 0,
    val lastError: StoredError? = null,
    /**
     * Why this type's backfill stopped. Kept apart from [lastError], which the type's next good
     * incremental sync clears: only a backfill unit of this type that succeeds clears this.
     */
    val backfillError: StoredError? = null,
)

@Serializable
data class GlobalState(
    /** The device this state belongs to. A different pairing resets everything. */
    val deviceId: String? = null,
    val lastSyncMs: Long? = null,
    val consecutiveFailures: Int = 0,
    val lastError: StoredError? = null,
    /**
     * When the work that [lastError] interrupted will be tried again, for a failure that is
     * being waited out (the backfill backing off). Null when nothing is scheduled.
     */
    val retryAtMs: Long? = null,
    /** The owner asked for a full backfill; it runs until every granted type is complete. */
    val backfillRequested: Boolean = false,
    /**
     * A short tag of the pairing the server refused with 401: its token and which act of
     * pairing it came from. While the stored pairing is still that one nothing is uploaded.
     * Pairing again clears the block, even with the very same token: the owner has asked to try.
     */
    val rejectedTokenTag: String? = null,
    /**
     * Why the latest run read nothing on purpose (in the background without the grant). Apart
     * from [lastError] so that a skip, which recurs every run, cannot hide a real error.
     */
    val skipReason: StoredError? = null,
    /** The owner has been told that background runs are skipped; do not tell them again. */
    val skipNotified: Boolean = false,
    /** Bumped every run so no type is always the last to be read under a tight quota. */
    val rotation: Int = 0,
    /**
     * Set when a backfill session ended with types it could not finish, or with its token
     * refused. Until it is lifted the periodic worker does not start the backfill service again.
     * Cleared when the owner presses the backfill button, when the pairing changes, and when a
     * backfill gets somewhere again.
     */
    val backfillGaveUp: BackfillGaveUp? = null,
) {
    /**
     * Whether a backfill is waiting out a failure right now. While it is, `lastError` and
     * `retryAtMs` are the backfill's to write: an incremental sync that runs in the meantime
     * neither replaces nor clears them.
     */
    fun waitPending(nowMs: Long): Boolean = retryAtMs != null && retryAtMs > nowMs
}

data class SyncSnapshot(val global: GlobalState = GlobalState(), val types: Map<String, TypeState> = emptyMap()) {
    fun type(name: String): TypeState = types[name] ?: TypeState()
}

/**
 * The engine's durable memory. Separate from the pairing store: this holds positions and counts,
 * never a credential and never a record.
 *
 * **When a write fails.** Every method may throw (in practice an `IOException` from the disk),
 * and a failed update changes nothing, in memory or on disk. The rule the engine builds on that:
 *
 * - A position is written only after the server acknowledged everything behind it. If that
 *   write fails, the position stays where it was and the unit ends as `state_store_failed`. The
 *   next run reads the same data and sends it again, and the server, which stores by record id,
 *   takes it as the same records. A failed write costs a repeat, never a record.
 * - The opposite, a position stored for something the server has not acknowledged, cannot
 *   happen: the only code that moves a position runs after the 200, and nothing carries on
 *   from a position it failed to store.
 * - The failure cannot be recorded in the store that just failed, so the engine keeps it in
 *   memory ([SyncEngine.storeFailure]) for the status screen and the failure notification.
 */
interface SyncStateStore {
    val snapshots: Flow<SyncSnapshot>

    suspend fun snapshot(): SyncSnapshot

    suspend fun updateType(type: String, transform: (TypeState) -> TypeState): TypeState

    suspend fun updateGlobal(transform: (GlobalState) -> GlobalState): GlobalState

    /** Forget everything and start over for [deviceId]. */
    suspend fun reset(deviceId: String)
}

// A file that cannot be parsed is replaced by an empty one rather than failing every read from
// then on: each type starts over, and the server deduplicates whatever is sent twice.
private val Context.syncStateDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "healthy_sync",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/** [SyncStateStore] on a Preferences DataStore of its own: one JSON value per record type. */
class DataStoreSyncStateStore(private val store: DataStore<Preferences>) : SyncStateStore {
    constructor(context: Context) : this(context.applicationContext.syncStateDataStore)

    override val snapshots: Flow<SyncSnapshot> = store.data.map(::read).distinctUntilChanged()

    override suspend fun snapshot(): SyncSnapshot = read(store.data.first())

    override suspend fun updateType(type: String, transform: (TypeState) -> TypeState): TypeState {
        val key = typeKey(type)
        var result = TypeState()
        store.edit { prefs ->
            val before = decode(prefs[key]) ?: TypeState()
            result = transform(before)
            if (result != before) prefs[key] = JSON.encodeToString(TypeState.serializer(), result)
        }
        return result
    }

    override suspend fun updateGlobal(transform: (GlobalState) -> GlobalState): GlobalState {
        var result = GlobalState()
        store.edit { prefs ->
            val before = decodeGlobal(prefs[GLOBAL])
            result = transform(before)
            if (result != before) prefs[GLOBAL] = JSON.encodeToString(GlobalState.serializer(), result)
        }
        return result
    }

    override suspend fun reset(deviceId: String) {
        store.edit { prefs ->
            prefs.clear()
            prefs[GLOBAL] = JSON.encodeToString(GlobalState.serializer(), GlobalState(deviceId = deviceId))
        }
    }

    private fun read(prefs: Preferences): SyncSnapshot {
        val types = buildMap {
            for ((key, value) in prefs.asMap()) {
                if (!key.name.startsWith(TYPE_PREFIX)) continue
                val state = decode(value as? String) ?: continue
                put(key.name.removePrefix(TYPE_PREFIX), state)
            }
        }
        return SyncSnapshot(decodeGlobal(prefs[GLOBAL]), types)
    }

    private companion object {
        const val TYPE_PREFIX = "type."
        val GLOBAL = stringPreferencesKey("global")
        val JSON = Json { ignoreUnknownKeys = true }

        fun typeKey(type: String) = stringPreferencesKey(TYPE_PREFIX + type)

        // A value this build cannot read is treated as absent: the type starts over, and the
        // server deduplicates whatever is sent twice.
        fun decode(text: String?): TypeState? = text?.let {
            try {
                JSON.decodeFromString(TypeState.serializer(), it)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }

        fun decodeGlobal(text: String?): GlobalState = text?.let {
            try {
                JSON.decodeFromString(GlobalState.serializer(), it)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        } ?: GlobalState()
    }
}
