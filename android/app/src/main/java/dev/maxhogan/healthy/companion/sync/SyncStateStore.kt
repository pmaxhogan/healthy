package dev.maxhogan.healthy.companion.sync

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
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
 * @property oldestDoneMs the oldest month fully acknowledged so far
 * @property fullHistory false when only the platform's recent window was readable
 */
@Serializable
data class BackfillState(
    val started: Boolean = false,
    val complete: Boolean = false,
    val topMonthMs: Long? = null,
    val floorMonthMs: Long? = null,
    val monthMs: Long? = null,
    val pageToken: String? = null,
    val oldestDoneMs: Long? = null,
    val fullHistory: Boolean = false,
)

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
)

data class SyncSnapshot(val global: GlobalState = GlobalState(), val types: Map<String, TypeState> = emptyMap()) {
    fun type(name: String): TypeState = types[name] ?: TypeState()
}

/**
 * The engine's durable memory. Separate from the pairing store: this holds positions and counts,
 * never a credential and never a record.
 */
interface SyncStateStore {
    val snapshots: Flow<SyncSnapshot>

    suspend fun snapshot(): SyncSnapshot

    suspend fun updateType(type: String, transform: (TypeState) -> TypeState): TypeState

    suspend fun updateGlobal(transform: (GlobalState) -> GlobalState): GlobalState

    /** Forget everything and start over for [deviceId]. */
    suspend fun reset(deviceId: String)
}

private val Context.syncStateDataStore: DataStore<Preferences> by preferencesDataStore(name = "healthy_sync")

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
