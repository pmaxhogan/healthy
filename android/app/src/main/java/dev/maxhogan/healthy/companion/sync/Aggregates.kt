package dev.maxhogan.healthy.companion.sync

import java.time.Instant
import java.time.YearMonth
import java.time.ZoneOffset

/** UTC hours, identified by the epoch ms of their first instant. */
object Hours {
    const val MS = 3_600_000L

    /** Most hours asked of Health Connect in one aggregate call: a 31-day month. */
    const val MAX_PER_REQUEST = 31 * 24

    fun floor(ms: Long): Long = Math.floorDiv(ms, MS) * MS

    /**
     * Every hour a record lasting `[startMs, endMs)` overlaps. A record with no duration, or one
     * whose end is not after its start, touches the hour it starts in.
     */
    fun touched(startMs: Long, endMs: Long): Sequence<Long> {
        val first = floor(startMs)
        val last = if (endMs > startMs) floor(endMs - 1) else first
        return generateSequence(first) { hour -> (hour + MS).takeIf { it <= last } }
    }

    /** Every hour in `[startMs, endMs)`, widened outwards to whole hours. */
    fun covering(startMs: Long, endMs: Long): Sequence<Long> = touched(startMs, endMs)

    /**
     * Groups [hours] into runs of consecutive hours, each at most [maxHours] long, as
     * `[start, end)` pairs in ascending order.
     */
    fun ranges(hours: Collection<Long>, maxHours: Int = MAX_PER_REQUEST): List<LongRange> {
        val out = ArrayList<LongRange>()
        var start = 0L
        var count = 0
        for (hour in hours.toSortedSet()) {
            if (count > 0 && (hour != start + count * MS || count == maxHours)) {
                out.add(start until start + count * MS)
                count = 0
            }
            if (count == 0) start = hour
            count++
        }
        if (count > 0) out.add(start until start + count * MS)
        return out
    }
}

/**
 * UTC calendar months, identified by the epoch ms of their first instant. UTC on purpose: the
 * boundaries only partition the history into resumable units, and a device-local calendar would
 * move them whenever the phone travels.
 */
object Months {
    fun floor(ms: Long): Long = start(yearMonth(ms))

    fun next(monthMs: Long): Long = start(yearMonth(monthMs).plusMonths(1))

    fun previous(monthMs: Long): Long = start(yearMonth(monthMs).minusMonths(1))

    /** How many months lie in `[floorMs, topMs]`, both being month starts. Zero when reversed. */
    fun count(floorMs: Long, topMs: Long): Int {
        if (topMs < floorMs) return 0
        val from = yearMonth(floorMs)
        val to = yearMonth(topMs)
        return ((to.year - from.year) * 12 + (to.monthValue - from.monthValue) + 1)
    }

    private fun yearMonth(ms: Long): YearMonth = YearMonth.from(Instant.ofEpochMilli(ms).atOffset(ZoneOffset.UTC))

    private fun start(month: YearMonth): Long = month.atDay(1).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
}
