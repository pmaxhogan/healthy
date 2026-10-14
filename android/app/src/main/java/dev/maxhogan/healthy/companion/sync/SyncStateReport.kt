package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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

    /** What the server takes for `runTrigger` and for `previousRun.end`. */
    private val TRIGGER = Regex("^[a-z][a-z0-9_]{0,23}$")
    private val RUN_END = Regex("^[a-z][a-z0-9_]{0,39}$")

    /** Stands for a code the server would not take as it is; none of the app's own is one. */
    private const val UNNAMED = "other"

    /**
     * @param types every record type the app knows, granted or not, in display order
     * @param backfillSinceMs set for a batch the backfill loop uploads: when its session began.
     *   Such a batch belongs to no incremental run, and says so; see [runMembers]
     */
    fun build(
        types: List<String>,
        access: HealthAccess,
        snapshot: SyncSnapshot,
        facts: DeviceFacts,
        nowMs: Long,
        backfillSinceMs: Long? = null,
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
        runMembers(snapshot.global, backfillSinceMs).forEach { (key, value) -> put(key, value) }
    }

    /**
     * Which run the batch is uploaded in, and how the incremental run before that one ended. With
     * these the server can tell a run that was cut off (its batches stop without a closing
     * report, and the next run calls it `interrupted`) from one that had nothing more to send.
     *
     * - `runTrigger` and `runStartedAt` are the same on every batch of a run, its closing report
     *   included. For a batch of the backfill they are `backfill` and the moment its session
     *   began, which every batch of that session shares.
     * - `previousRun` is left out until there has been a run to speak of. For a batch of the
     *   backfill it is the latest incremental run: the backfill and a sync never run at once, so
     *   one that has recorded no end by then did not reach one.
     *
     * Nothing is reported for a state no run has written yet.
     */
    private fun runMembers(global: GlobalState, backfillSinceMs: Long?): Map<String, JsonElement> = buildMap {
        val current = if (backfillSinceMs != null) RunRecord(backfillSinceMs, SyncTrigger.BACKFILL_CODE) else global.run
        if (current == null) return@buildMap
        put("runTrigger", JsonPrimitive(current.trigger.takeIf(TRIGGER::matches) ?: UNNAMED))
        put("runStartedAt", JsonPrimitive(current.startedAtMs.coerceAtLeast(0)))
        val previous = (if (backfillSinceMs != null) global.run else global.previousRun)?.ended() ?: return@buildMap
        put(
            "previousRun",
            buildJsonObject {
                put("startedAt", JsonPrimitive(previous.startedAtMs.coerceAtLeast(0)))
                put("end", JsonPrimitive(previous.end?.takeIf(RUN_END::matches) ?: UNNAMED))
            },
        )
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
