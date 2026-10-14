package dev.maxhogan.healthy.companion.sync

import kotlinx.serialization.json.JsonObject

/**
 * Everything the sync engine asks of Health Connect, in the engine's own plain types.
 *
 * The engine never sees the client library: record types are wire names (`HeartRate`), records
 * arrive already serialised to the wire `Record` object, and times are epoch milliseconds. That
 * keeps the engine a pure state machine that runs on the JVM against a fake, and it keeps the
 * library's restricted constructors (`ChangesResponse`, `AggregationResult`) out of the tests.
 *
 * Every method throws [HealthSourceException] and nothing else (cancellation aside).
 */
interface HealthSource {
    /** A fresh changes token for one record type. Changes made from now on are behind it. */
    suspend fun changesToken(type: String): String

    /** One page of changes behind [token]. */
    suspend fun changes(token: String): ChangesPage

    /**
     * One page of records of [type] whose time lies in `[startMs, endMs)`.
     *
     * @param pageToken null for the first page, else [RecordsPage.pageToken] of the page before
     */
    suspend fun readRecords(
        type: String,
        startMs: Long,
        endMs: Long,
        pageToken: String?,
        ascending: Boolean = true,
        pageSize: Int = DEFAULT_PAGE_SIZE,
    ): RecordsPage

    /**
     * Health Connect's own priority-merged total of [metric] for each whole UTC hour in
     * `[startMs, endMs)`. Both bounds are hour-aligned. Hours with no data are left out.
     */
    suspend fun aggregateHourly(metric: AggMetric, startMs: Long, endMs: Long): List<HourAggregate>

    companion object {
        const val DEFAULT_PAGE_SIZE = 1000
    }
}

sealed interface HcChange {
    /** A record that was inserted or updated, as its wire object. */
    data class Upsert(val record: JsonObject) : HcChange

    data class Delete(val id: String) : HcChange
}

data class ChangesPage(
    val changes: List<HcChange>,
    val nextToken: String,
    val hasMore: Boolean,
    /** The token is too old to be read; [changes] is empty and [nextToken] is meaningless. */
    val expired: Boolean,
)

data class RecordsPage(val records: List<JsonObject>, val pageToken: String?)

/** One UTC hour of a platform aggregate. [origins] are the contributing apps' package names. */
data class HourAggregate(val hourStartMs: Long, val value: Double, val origins: List<String>)

/**
 * The cumulative metrics uploaded as synthetic `Agg.<Metric>` records, and the record type whose
 * changes make each one stale. Total calories and basal metabolic rate are deliberately absent:
 * the platform fills gaps in those with estimates, so its number is not a merge of real records.
 */
enum class AggMetric(val metric: String, val sourceType: String, val unit: String) {
    STEPS("Steps", "Steps", "count"),
    DISTANCE("Distance", "Distance", "m"),
    ACTIVE_CALORIES("ActiveCalories", "ActiveCaloriesBurned", "kcal"),
    FLOORS("Floors", "FloorsClimbed", "floors"),
    ELEVATION("Elevation", "ElevationGained", "m"),
    WHEELCHAIR_PUSHES("WheelchairPushes", "WheelchairPushes", "count"),
    EXERCISE_DURATION("ExerciseDuration", "ExerciseSession", "ms"),
    SLEEP_DURATION("SleepDuration", "SleepSession", "ms"),
    HYDRATION("Hydration", "Hydration", "L"),
    ;

    val wireType: String get() = "Agg.$metric"

    fun recordId(hourStartMs: Long): String = "agg:$metric:$hourStartMs"

    companion object {
        fun forType(type: String): AggMetric? = entries.firstOrNull { it.sourceType == type }

        /** The metric and hour a [recordId] names, or null for any other id. */
        fun hourOf(recordId: String): Pair<AggMetric, Long>? {
            val parts = recordId.split(':')
            if (parts.size != 3 || parts[0] != "agg") return null
            val metric = entries.firstOrNull { it.metric == parts[1] } ?: return null
            val hour = parts[2].toLongOrNull() ?: return null
            return metric to hour
        }
    }
}

/**
 * Why a Health Connect call failed, reduced to what the engine does about it.
 *
 * @property errorCode a stable code for `lastError`; never the platform's message
 */
class HealthSourceException(val kind: Kind, val errorCode: String) : Exception(errorCode) {
    enum class Kind {
        /** The API quota is spent. Back off and resume; every type shares the quota. */
        RATE_LIMITED,

        /** The service died, timed out or failed to read. Back off and resume. */
        TRANSIENT,

        /** This type may not be read (revoked, or a background read without the grant). */
        PERMISSION,

        /** The platform refused the request itself, for example a page token it no longer knows. */
        INVALID,

        /** Health Connect is not usable on this phone right now. */
        UNAVAILABLE,
    }
}
