package dev.maxhogan.healthy.companion.sync

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AggregatesTest {
    private val h = Hours.MS

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun `a record touches every UTC hour it overlaps`() {
        val nine = ms("2026-03-10T09:00:00Z")
        assertEquals(listOf(nine), Hours.touched(nine + 5, nine + 10).toList())
        assertEquals(listOf(nine, nine + h), Hours.touched(nine + h - 1, nine + h + 1).toList())
        assertEquals(listOf(nine, nine + h, nine + 2 * h), Hours.touched(nine, nine + 3 * h).toList())
    }

    @Test
    fun `an end exactly on the hour does not touch the next hour`() {
        val nine = ms("2026-03-10T09:00:00Z")
        assertEquals(listOf(nine), Hours.touched(nine, nine + h).toList())
        assertEquals(listOf(nine - h), Hours.touched(nine - h, nine).toList())
    }

    @Test
    fun `an instant, or a reversed interval, touches the hour it starts in`() {
        val nine = ms("2026-03-10T09:00:00Z")
        assertEquals(listOf(nine), Hours.touched(nine + 7, nine + 7).toList())
        assertEquals(listOf(nine), Hours.touched(nine, nine).toList())
        assertEquals(listOf(nine), Hours.touched(nine + 9, nine - 5 * h).toList())
    }

    @Test
    fun `hours before the epoch floor downwards`() {
        assertEquals(-h, Hours.floor(-1))
        assertEquals(0L, Hours.floor(h - 1))
    }

    @Test
    fun `hours are grouped into runs of consecutive hours`() {
        val hours = listOf(5 * h, 1 * h, 2 * h, 9 * h, 4 * h, 2 * h)
        assertEquals(
            listOf(1 * h until 3 * h, 4 * h until 6 * h, 9 * h until 10 * h),
            Hours.ranges(hours),
        )
        assertEquals(emptyList<LongRange>(), Hours.ranges(emptyList()))
    }

    @Test
    fun `a long run is cut at the request limit`() {
        val hours = (0 until 10).map { it * h }
        assertEquals(
            listOf(0L until 4 * h, 4 * h until 8 * h, 8 * h until 10 * h),
            Hours.ranges(hours, maxHours = 4),
        )
        assertEquals(1, Hours.ranges((0 until Hours.MAX_PER_REQUEST).map { it * h }).size)
    }

    @Test
    fun `months are UTC calendar months`() {
        assertEquals(ms("2026-03-01T00:00:00Z"), Months.floor(ms("2026-03-31T23:59:59.999Z")))
        assertEquals(ms("2026-04-01T00:00:00Z"), Months.floor(ms("2026-04-01T00:00:00Z")))
        assertEquals(ms("2026-04-01T00:00:00Z"), Months.next(ms("2026-03-01T00:00:00Z")))
        assertEquals(ms("2024-03-01T00:00:00Z"), Months.next(ms("2024-02-01T00:00:00Z")))
        assertEquals(ms("2025-12-01T00:00:00Z"), Months.previous(ms("2026-01-01T00:00:00Z")))
        assertEquals(ms("2027-01-01T00:00:00Z"), Months.next(ms("2026-12-01T00:00:00Z")))
    }

    @Test
    fun `months are counted inclusively`() {
        assertEquals(1, Months.count(ms("2026-03-01T00:00:00Z"), ms("2026-03-01T00:00:00Z")))
        assertEquals(14, Months.count(ms("2025-02-01T00:00:00Z"), ms("2026-03-01T00:00:00Z")))
        assertEquals(0, Months.count(ms("2026-04-01T00:00:00Z"), ms("2026-03-01T00:00:00Z")))
    }

    @Test
    fun `a month never has more hours than one aggregate request takes`() {
        val start = ms("2026-01-01T00:00:00Z")
        assertEquals(1, Hours.ranges(Hours.covering(start, Months.next(start)).toList()).size)
    }

    @Test
    fun `only the cumulative metrics have a platform aggregate`() {
        assertEquals(AggMetric.STEPS, AggMetric.forType("Steps"))
        assertEquals(AggMetric.ACTIVE_CALORIES, AggMetric.forType("ActiveCaloriesBurned"))
        assertEquals(AggMetric.SLEEP_DURATION, AggMetric.forType("SleepSession"))
        assertNull(AggMetric.forType("TotalCaloriesBurned"))
        assertNull(AggMetric.forType("BasalMetabolicRate"))
        assertNull(AggMetric.forType("HeartRate"))
        assertEquals(
            setOf(
                "Steps", "Distance", "ActiveCalories", "Floors", "Elevation",
                "WheelchairPushes", "ExerciseDuration", "SleepDuration", "Hydration",
            ),
            AggMetric.entries.map { it.metric }.toSet(),
        )
    }
}
