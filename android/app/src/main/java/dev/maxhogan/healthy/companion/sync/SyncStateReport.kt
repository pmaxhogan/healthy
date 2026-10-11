package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * Facts about the phone that are not sync state.
 *
 * @property hcProviderVersion Health Connect's version name, or null when it cannot be read
 */
data class DeviceFacts(
    val batteryExempt: Boolean,
    val hcProviderVersion: String?,
    val androidSdk: Int,
    /** Exempt from "remove permissions if app is unused", which would silently stop syncing. */
    val hibernationExempt: Boolean = false,
)

/**
 * The `syncState` object: the phone's own account of its sync health, sent with every batch so
 * the server can say why data is missing (a denied permission, a stalled type) rather than only
 * that it is.
 */
object SyncStateReport {
    private const val MAX_VERSION_LENGTH = 64

    /**
     * @param types every record type the app knows, granted or not, in display order
     */
    fun build(
        types: List<String>,
        access: HealthAccess,
        snapshot: SyncSnapshot,
        facts: DeviceFacts,
        nowMs: Long,
    ): JsonObject = buildJsonObject {
        put(
            "types",
            JsonArray(
                types.map { type ->
                    val state = snapshot.type(type)
                    buildJsonObject {
                        put("type", JsonPrimitive(type))
                        put("permission", JsonPrimitive(permission(access.types[type])))
                        put(
                            "tokenAgeS",
                            state.tokenCreatedMs?.takeIf { state.token != null }
                                ?.let { JsonPrimitive(((nowMs - it) / 1000).coerceAtLeast(0)) }
                                ?: JsonNull,
                        )
                        put("backlog", JsonPrimitive(state.backlog.coerceAtLeast(0)))
                        // Records that did not arrive as themselves: refused by the server one
                        // by one, or too large and replaced by a stub.
                        put("rejected", JsonPrimitive(state.rejected.coerceAtLeast(0)))
                        put("stubbed", JsonPrimitive(state.stubbed.coerceAtLeast(0)))
                        put(
                            "backfill",
                            buildJsonObject {
                                put("complete", JsonPrimitive(state.backfill.complete))
                                put(
                                    "oldestDoneMs",
                                    state.backfill.oldestDoneMs?.takeIf { it >= 0 }?.let(::JsonPrimitive) ?: JsonNull,
                                )
                                state.backfillError?.let { put("errorCode", JsonPrimitive(it.errorCode.take(MAX_VERSION_LENGTH))) }
                            },
                        )
                    }
                },
            ),
        )
        // Not a record type, so not a row above: a permission of its own, which the system's
        // "Allow all" does not always include. Without it a session still goes up, with
        // `routeState` in place of its route.
        put("exerciseRoutes", JsonPrimitive(permission(access.exerciseRoutes)))
        put("backgroundRead", JsonPrimitive(access.backgroundRead == Grant.GRANTED))
        put("historyRead", JsonPrimitive(access.historyRead == Grant.GRANTED))
        put("batteryExempt", JsonPrimitive(facts.batteryExempt))
        put("hibernationExempt", JsonPrimitive(facts.hibernationExempt))
        facts.hcProviderVersion?.takeIf { it.isNotEmpty() }?.let {
            put("hcProviderVersion", JsonPrimitive(it.take(MAX_VERSION_LENGTH)))
        }
        put("androidSdk", JsonPrimitive(facts.androidSdk))
        put("backfillComplete", JsonPrimitive(backfillComplete(types, access, snapshot)))
        lastError(types, access, snapshot)?.let { error ->
            put(
                "lastError",
                buildJsonObject {
                    put("errorCode", JsonPrimitive(error.errorCode.take(MAX_VERSION_LENGTH)))
                    put("at", JsonPrimitive(error.atMs.coerceAtLeast(0)))
                    // Present while the phone is waiting the error out: when it tries again.
                    retryAt(snapshot, error, nowMs)?.let { put("retryAt", JsonPrimitive(it)) }
                },
            )
        }
        // Why the latest run read nothing on purpose. Separate from lastError: it recurs every
        // run and would otherwise always be the newest.
        snapshot.global.skipReason?.let { skip ->
            put(
                "skipReason",
                buildJsonObject {
                    put("errorCode", JsonPrimitive(skip.errorCode.take(MAX_VERSION_LENGTH)))
                    put("at", JsonPrimitive(skip.atMs.coerceAtLeast(0)))
                },
            )
        }
    }

    /**
     * True once a backfill was asked for and every granted type has been read to its floor.
     *
     * A type that was read without the history permission only reached the recent window the
     * platform allowed. That counts as complete for as long as the permission is missing, and
     * stops counting the moment it is granted: there is history left to fetch.
     */
    fun backfillComplete(types: List<String>, access: HealthAccess, snapshot: SyncSnapshot): Boolean {
        val granted = types.filter { access.types[it] == Grant.GRANTED }
        val historyGranted = access.historyRead == Grant.GRANTED
        return snapshot.global.backfillRequested &&
            granted.isNotEmpty() &&
            granted.all {
                val backfill = snapshot.type(it).backfill
                backfill.complete && (backfill.fullHistory || !historyGranted)
            }
    }

    /**
     * The newest failure still standing, whether it stopped a whole run or one type. Only
     * granted types count: an error from before a permission was withdrawn describes nothing
     * that is still being attempted.
     */
    fun lastError(types: List<String>, access: HealthAccess, snapshot: SyncSnapshot): StoredError? {
        val ofTypes = types.filter { access.types[it] == Grant.GRANTED }.mapNotNull { snapshot.type(it).lastError }
        return (ofTypes + listOfNotNull(snapshot.global.lastError)).maxByOrNull { it.atMs }
    }

    /**
     * When the work behind [error] is tried again, if [error] is the one being waited out and
     * that moment is still ahead of [nowMs]. A retry time that has passed is not a plan any
     * more, so it is never shown or reported.
     */
    fun retryAt(snapshot: SyncSnapshot, error: StoredError, nowMs: Long): Long? =
        snapshot.global.retryAtMs?.takeIf { error == snapshot.global.lastError && it > nowMs }

    /** Why a granted, unfinished type's backfill last stopped: the newest such reason. */
    fun backfillError(types: List<String>, access: HealthAccess, snapshot: SyncSnapshot): StoredError? =
        types.filter { access.types[it] == Grant.GRANTED }
            .map { snapshot.type(it) }
            .filter { !it.backfill.complete }
            .mapNotNull { it.backfillError }
            .maxByOrNull { it.atMs }

    private fun permission(grant: Grant?): String = when (grant) {
        Grant.GRANTED -> "granted"
        Grant.DENIED -> "denied"
        Grant.UNAVAILABLE, null -> "unavailable"
    }
}
