package dev.maxhogan.healthy.companion.sync

import android.health.connect.HealthConnectException
import android.os.RemoteException
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregationResult
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WheelchairPushesRecord
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import dev.maxhogan.healthy.companion.hc.HealthConnectAccess
import dev.maxhogan.healthy.companion.hc.RecordTypes
import dev.maxhogan.healthy.companion.hc.mapper.RecordSerializer
import java.io.IOException
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.reflect.KClass

/**
 * [HealthSource] on the real Health Connect client.
 *
 * Records leave here already serialised, so nothing above this class holds a library type. Every
 * failure is reduced to a [HealthSourceException] with a fixed code: the platform's messages can
 * name apps and are never passed on.
 */
class HealthConnectSource(
    private val access: HealthConnectAccess,
    private val serializer: RecordSerializer,
) : HealthSource {
    private val classes: Map<String, KClass<out Record>> = RecordTypes.ALL.associateBy(RecordTypes::typeName)

    override suspend fun changesToken(type: String): String = call { client ->
        client.getChangesToken(ChangesTokenRequest(setOf(classOf(type))))
    }

    override suspend fun changes(token: String): ChangesPage = call { client ->
        val response = client.getChanges(token)
        if (response.changesTokenExpired) {
            return@call ChangesPage(emptyList(), token, hasMore = false, expired = true)
        }
        val changes = response.changes.mapNotNull { change ->
            when (change) {
                is UpsertionChange -> HcChange.Upsert(serializer.serialize(change.record))
                is DeletionChange -> HcChange.Delete(change.recordId)
                // The library has no third kind; one it adds later carries nothing this version
                // could send.
                else -> null
            }
        }
        ChangesPage(changes, response.nextChangesToken, response.hasMore, expired = false)
    }

    override suspend fun readRecords(
        type: String,
        startMs: Long,
        endMs: Long,
        pageToken: String?,
        ascending: Boolean,
        pageSize: Int,
    ): RecordsPage = call { client ->
        val response = client.readRecords(
            ReadRecordsRequest(
                recordType = classOf(type),
                timeRangeFilter = TimeRangeFilter.between(Instant.ofEpochMilli(startMs), Instant.ofEpochMilli(endMs)),
                ascendingOrder = ascending,
                pageSize = pageSize,
                pageToken = pageToken,
            ),
        )
        RecordsPage(response.records.map(serializer::serialize), response.pageToken?.takeIf { it.isNotEmpty() })
    }

    override suspend fun aggregateHourly(metric: AggMetric, startMs: Long, endMs: Long): List<HourAggregate> =
        call { client ->
            val buckets = client.aggregateGroupByDuration(
                AggregateGroupByDurationRequest(
                    metrics = setOf(metricOf(metric)),
                    // Instants, not local times, on hour-aligned bounds: the slices are UTC hours
                    // whatever zone the phone is in.
                    timeRangeFilter = TimeRangeFilter.between(Instant.ofEpochMilli(startMs), Instant.ofEpochMilli(endMs)),
                    timeRangeSlicer = Duration.ofHours(1),
                ),
            )
            buckets.mapNotNull { bucket ->
                val value = valueOf(metric, bucket.result) ?: return@mapNotNull null
                HourAggregate(
                    hourStartMs = bucket.startTime.toEpochMilli(),
                    value = value,
                    origins = bucket.result.dataOrigins.map { it.packageName },
                )
            }
        }

    private fun classOf(type: String): KClass<out Record> =
        classes[type] ?: throw HealthSourceException(HealthSourceException.Kind.INVALID, "unknown_record_type")

    private fun metricOf(metric: AggMetric) = when (metric) {
        AggMetric.STEPS -> StepsRecord.COUNT_TOTAL
        AggMetric.DISTANCE -> DistanceRecord.DISTANCE_TOTAL
        AggMetric.ACTIVE_CALORIES -> ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
        AggMetric.FLOORS -> FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL
        AggMetric.ELEVATION -> ElevationGainedRecord.ELEVATION_GAINED_TOTAL
        AggMetric.WHEELCHAIR_PUSHES -> WheelchairPushesRecord.COUNT_TOTAL
        AggMetric.EXERCISE_DURATION -> ExerciseSessionRecord.EXERCISE_DURATION_TOTAL
        AggMetric.SLEEP_DURATION -> SleepSessionRecord.SLEEP_DURATION_TOTAL
        AggMetric.HYDRATION -> HydrationRecord.VOLUME_TOTAL
    }

    /** The total in the unit [AggMetric.unit] names, or null when the hour has no data. */
    private fun valueOf(metric: AggMetric, result: AggregationResult): Double? = when (metric) {
        AggMetric.STEPS -> result[StepsRecord.COUNT_TOTAL]?.toDouble()
        AggMetric.DISTANCE -> result[DistanceRecord.DISTANCE_TOTAL]?.inMeters
        AggMetric.ACTIVE_CALORIES -> result[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
        AggMetric.FLOORS -> result[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL]
        AggMetric.ELEVATION -> result[ElevationGainedRecord.ELEVATION_GAINED_TOTAL]?.inMeters
        AggMetric.WHEELCHAIR_PUSHES -> result[WheelchairPushesRecord.COUNT_TOTAL]?.toDouble()
        AggMetric.EXERCISE_DURATION -> result[ExerciseSessionRecord.EXERCISE_DURATION_TOTAL]?.toMillis()?.toDouble()
        AggMetric.SLEEP_DURATION -> result[SleepSessionRecord.SLEEP_DURATION_TOTAL]?.toMillis()?.toDouble()
        AggMetric.HYDRATION -> result[HydrationRecord.VOLUME_TOTAL]?.inLiters
    }?.takeIf { it.isFinite() }

    private suspend fun <T> call(block: suspend (HealthConnectClient) -> T): T {
        val client = try {
            access.clientOrNull()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        } ?: throw HealthSourceException(HealthSourceException.Kind.UNAVAILABLE, "hc_unavailable")
        return try {
            block(client)
        } catch (e: CancellationException) {
            throw e
        } catch (e: HealthSourceException) {
            throw e
        } catch (e: Exception) {
            throw classify(e)
        } catch (e: OutOfMemoryError) {
            // A page of very large records (an exercise route, a long series) did not fit in
            // memory as JSON. By the time this is caught the half-built page is garbage, so it is
            // safe to carry on: reported as a read that failed, which the backfill answers by
            // asking for fewer records at a time. Left uncaught it would kill the process, the
            // service would restart at the same page, and the backfill would never get past it.
            throw HealthSourceException(HealthSourceException.Kind.TRANSIENT, ERROR_PAGE_TOO_LARGE)
        }
    }

    companion object {
        /** A page of records was too large to hold in memory at once. */
        const val ERROR_PAGE_TOO_LARGE = "hc_page_too_large"

        /**
         * The client library turns the platform's error codes into plain exceptions
         * (`ExceptionConverter`): security, invalid argument, I/O and remote keep a type of
         * their own, and everything else, the rate limit included, becomes an
         * `IllegalStateException` wrapping the platform exception.
         */
        fun classify(e: Exception): HealthSourceException = when (e) {
            is SecurityException -> HealthSourceException(HealthSourceException.Kind.PERMISSION, "permission_denied")
            is IllegalArgumentException -> HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
            is RemoteException -> HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote")
            is IOException -> HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_io")
            is IllegalStateException ->
                if (isRateLimit(e)) {
                    HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited")
                } else {
                    HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_error")
                }
            else -> HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_error")
        }

        private fun isRateLimit(e: IllegalStateException): Boolean {
            val platform = e.cause as? HealthConnectException
            if (platform != null) return platform.errorCode == HealthConnectException.ERROR_RATE_LIMIT_EXCEEDED
            val message = e.message?.lowercase() ?: return false
            return "rate limit" in message || "quota" in message
        }
    }
}
