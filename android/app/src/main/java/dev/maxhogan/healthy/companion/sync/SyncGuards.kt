package dev.maxhogan.healthy.companion.sync

import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.Flow

/**
 * "Not before T", shared by everything in the process that would make the same kind of request.
 *
 * There is one for Health Connect and one for the server, both owned by the single [SyncEngine].
 * When either says "slow down", the gate closes until a moment T, and until then nobody asks
 * again: not the backfill that was told, and not the periodic sync that happens to run in the
 * meantime. A caller that finds the gate closed has not failed, it has been asked to wait, so it
 * spends no quota, counts no failure and leaves the waiting state on screen alone.
 *
 * T is a wall-clock time, because the phone may sleep through most of the wait and a monotonic
 * clock does not count sleep. A clock that is set back cannot hold the gate shut: a remaining
 * wait longer than the wait that was asked for is treated as over.
 */
internal class PushbackGate(
    private val clock: () -> Long,
    private val baseMs: Long = BASE_MS,
    private val capMs: Long = CAP_MS,
) {
    private var untilMs = 0L
    private var waitMs = 0L
    private var strikes = 0
    private var passes = 0

    /** The code of the refusal that last closed the gate. */
    var errorCode: String = ""
        private set

    /** True when that refusal is pushback (a rate limit), false when it is a failure with a date. */
    var uncounted: Boolean = false
        private set

    /** Milliseconds until the gate opens, or null when it is open. */
    @Synchronized
    fun remainingMs(): Long? {
        val left = untilMs - clock()
        return left.takeIf { it in 1..waitMs }
    }

    /**
     * Closes the gate.
     *
     * @param retryAfterMs how long the other side asked for. Without one the wait doubles with
     *   every refusal in a row, from [baseMs] up to [capMs]
     * @return the wait
     */
    @Synchronized
    fun close(errorCode: String, retryAfterMs: Long?, uncounted: Boolean = true): Long {
        val exponential = if (strikes >= 30) capMs else minOf(capMs, baseMs shl strikes)
        val wait = (retryAfterMs ?: exponential).coerceAtLeast(1)
        strikes++
        passes = 0
        waitMs = wait
        untilMs = clock() + wait
        this.errorCode = errorCode
        this.uncounted = uncounted
        return wait
    }

    /**
     * A request got through. The run of refusals is only forgotten after several in a row: a
     * quota that refills slowly lets one request through and refuses the next, and the wait
     * should keep growing through that instead of starting from the base each time.
     */
    @Synchronized
    fun passed() {
        if (strikes > 0 && ++passes >= PASSES_TO_RESET) strikes = 0
    }

    companion object {
        const val BASE_MS = 5_000L
        const val CAP_MS = 15 * 60_000L
        const val PASSES_TO_RESET = 50
    }
}

/**
 * [HealthSource] behind the process-wide Health Connect gate: while the gate is closed no call
 * reaches the platform, and a call the platform refuses for its rate limit closes it.
 */
internal class GatedHealthSource(private val inner: HealthSource, private val gate: PushbackGate) : HealthSource {
    private suspend fun <T> gated(block: suspend () -> T): T {
        if (gate.remainingMs() != null) {
            throw HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, ERROR_RATE_LIMITED)
        }
        val result = try {
            block()
        } catch (e: HealthSourceException) {
            if (e.kind == HealthSourceException.Kind.RATE_LIMITED) gate.close(e.errorCode, retryAfterMs = null)
            throw e
        }
        gate.passed()
        return result
    }

    override suspend fun changesToken(type: String): String = gated { inner.changesToken(type) }

    override suspend fun changes(token: String): ChangesPage = gated { inner.changes(token) }

    override suspend fun readRecords(
        type: String,
        startMs: Long,
        endMs: Long,
        pageToken: String?,
        ascending: Boolean,
        pageSize: Int,
    ): RecordsPage = gated { inner.readRecords(type, startMs, endMs, pageToken, ascending, pageSize) }

    override suspend fun aggregateHourly(metric: AggMetric, startMs: Long, endMs: Long): List<HourAggregate> =
        gated { inner.aggregateHourly(metric, startMs, endMs) }

    companion object {
        const val ERROR_RATE_LIMITED = "hc_rate_limited"
    }
}

/** The state store could not be read or written. The engine's one signal for "stop this unit". */
internal class StateStoreException(cause: Throwable) : Exception("state_store_failed", cause)

/**
 * [SyncStateStore] with every failure reduced to [StateStoreException], so the engine can tell a
 * disk that will not take a write from everything else that can go wrong in a run. See the rule
 * on [SyncStateStore].
 */
internal class GuardedStateStore(private val inner: SyncStateStore) : SyncStateStore {
    override val snapshots: Flow<SyncSnapshot> get() = inner.snapshots

    private inline fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        throw StateStoreException(e)
    }

    override suspend fun snapshot(): SyncSnapshot = guarded { inner.snapshot() }

    override suspend fun updateType(type: String, transform: (TypeState) -> TypeState): TypeState =
        guarded { inner.updateType(type, transform) }

    override suspend fun updateGlobal(transform: (GlobalState) -> GlobalState): GlobalState =
        guarded { inner.updateGlobal(transform) }

    override suspend fun reset(deviceId: String) = guarded { inner.reset(deviceId) }
}

/**
 * How many records the backfill asks Health Connect for at a time, per record type.
 *
 * A page is held in memory whole, as JSON, before it is uploaded, and records differ in size by
 * orders of magnitude: a step count is a few hundred bytes, an exercise session with its route
 * can be most of a megabyte. So the size is steered towards [TARGET_BYTES] a page: first by the
 * weight of the one record the range probe reads anyway, then by what each page weighed, and a
 * read that did not fit is tried again smaller. Nothing is skipped or cut: a smaller page only
 * means more requests.
 *
 * The size this gives is for the next month to be started. A month already under way keeps the
 * size it began with ([BackfillState.pageSize]), so a page token is never used with another.
 */
internal class PageSizer {
    private val sizes = HashMap<String, Int>()

    fun size(type: String): Int = sizes[type] ?: INITIAL

    /**
     * A first guess from one record of the type, taken before any page is read. One record says
     * little about the rest, so it is given a quarter of the budget.
     */
    fun seed(type: String, recordBytes: Long) {
        if (type !in sizes) sizes[type] = fit(recordBytes, TARGET_BYTES / SEED_CAUTION)
    }

    /** After a page of [count] records weighing [bytes]: the size for the type's next month. */
    fun measured(type: String, count: Int, bytes: Long) {
        if (count <= 0) return
        // Grow in steps: one page of small records does not prove the next one is.
        val step = (size(type).toLong() * GROWTH).coerceAtMost(MAX.toLong()).toInt()
        sizes[type] = fit(bytes / count, TARGET_BYTES).coerceAtMost(step)
    }

    /**
     * A read of [from] records did not fit. False when the page cannot get smaller, so the
     * failure is not its size.
     */
    fun shrink(type: String, from: Int): Boolean {
        if (from <= 1) return false
        sizes[type] = (from / SHRINK).coerceAtLeast(1)
        return true
    }

    private fun fit(recordBytes: Long, budget: Long): Int =
        (budget / recordBytes.coerceAtLeast(1)).coerceIn(1, MAX.toLong()).toInt()

    companion object {
        /** For a type nothing is known about yet (a session resumed part-way). */
        const val INITIAL = 200
        const val MAX = 1000
        const val TARGET_BYTES = 4L shl 20
        const val SEED_CAUTION = 4
        const val GROWTH = 4
        const val SHRINK = 8
    }
}
