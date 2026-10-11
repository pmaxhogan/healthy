package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import java.io.IOException
import java.security.MessageDigest
import kotlin.random.Random
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * What one run works with: where to upload, and what the phone currently allows.
 *
 * @property foreground whether the app is on screen or running its foreground service. Health
 *   Connect only lets an app in the background read when it holds the background-read grant.
 *   Confirmed on a device: the platform counts the app's `health` foreground service as
 *   foreground, and refuses a background read without the grant with a `SecurityException`.
 */
class Session(
    val pairing: Pairing,
    val access: HealthAccess,
    val facts: DeviceFacts,
    val foreground: Boolean = true,
    /** [PairingStore.generation] when the session was built: which act of pairing this is. */
    val pairingGeneration: Long = 0,
) {
    /**
     * Whether a read can be trusted right now. A background read without the grant is not
     * attempted at all: should the platform answer it with nothing instead of an error, an empty
     * page would be taken for "no data" and a cursor would move past records never seen.
     */
    val canRead: Boolean get() = foreground || access.backgroundRead == Grant.GRANTED
}

/** How one incremental sync ended. */
sealed interface RunResult {
    data object Success : RunResult

    /**
     * Nothing was lost; the same work is tried again on the next run.
     *
     * @property retryable false when trying again sooner cannot help (the owner has to act)
     */
    data class Failed(
        val errorCode: String,
        val retryAfterMs: Long? = null,
        val retryable: Boolean = true,
    ) : RunResult

    /**
     * The run read nothing on purpose and nothing moved. Not a failure: it does not count
     * towards the failure notification.
     *
     * @property notify true the first time, so the owner is told once and not every run
     */
    data class Skipped(val errorCode: String, val notify: Boolean) : RunResult

    /**
     * The server refused the token. Nothing is sent until the owner pairs again.
     *
     * @property notify true for the run in which the server said so, false for every later
     *   run that sent nothing because of it: the owner is told once
     */
    data class PairingRejected(val notify: Boolean) : RunResult
}

/** How one step of the backfill ended. The caller loops while it is [Progress]. */
sealed interface BackfillStep {
    /** @property uploaded whether the step sent anything, so the caller can pace its requests */
    data class Progress(val uploaded: Boolean) : BackfillStep

    /** Every granted type has been read back to its oldest record. */
    data object Complete : BackfillStep

    /** Wait, then call again: the same unit is retried. */
    data class Backoff(val errorCode: String, val retryAfterMs: Long? = null) : BackfillStep

    /** Nothing more can be done until the owner acts; what failed keeps its own error. */
    data class Incomplete(val errorCode: String) : BackfillStep

    data object PairingRejected : BackfillStep
}

/** What one backfill session remembers between steps and forgets when it ends. */
class BackfillRun {
    /** Types set aside for this session, with the error that set each aside. */
    val skipped: MutableMap<String, String> = LinkedHashMap()
    internal val strikes: MutableMap<String, Int> = HashMap()

    /** Months already restarted once because their page token was refused. */
    internal val pageRestarts: MutableSet<String> = HashSet()
}

/**
 * The sync state machine: changes tokens, the history backfill, platform aggregates, and the
 * rule that ties them together.
 *
 * **Ack, then commit.** A position (a changes token, a page token, a month) is written to the
 * [SyncStateStore] only after the server has answered 200 for every batch that carried what lies
 * behind it. A crash, a refusal or a lost connection in between leaves the old position, and the
 * next run reads the same data again and sends it again; the server stores by record id, so a
 * record that arrives twice is stored once. There is exactly one way a record is not delivered
 * as itself and its position still moves: it is larger than the server's limits even alone, and
 * goes up as a stub that says so.
 *
 * **Per type.** Each record type has its own token, its own backfill cursor and its own
 * errors. A type that is denied, or that the platform or the server refuses, is set aside and
 * the others carry on.
 *
 * **A 400 never moves anything.** The server answers 400 for a request it cannot read at all,
 * never for one record (a bad record is rejected inside a 200). So a 400 says nothing about
 * which record to blame, and the position stays where it is until a later run gets a 200.
 *
 * Known gaps, by design of the platform rather than oversight:
 * - a record deleted in Health Connect while the type's changes token was expired stays on the
 *   server: the re-read that follows an expiry sees what exists, not what went;
 * - that re-read covers the last 30 days by record time, so a record dated further back but
 *   written during the gap is missed until a full backfill reads its month again;
 * - a batch the server keeps answering 5xx for stalls its type (and the backfill of that type)
 *   until the server recovers: it is retried for as long as that takes, never skipped.
 *
 * Nothing here logs, and no error code is ever built from a message.
 *
 * @param currentPairing the pairing as it is stored right now. It is read inside the engine's
 *   lock and again before every request, so a run that was handed an older pairing cannot touch
 *   (or wipe) the state of a newer one, nor keep uploading after the owner unpaired
 */
class SyncEngine(
    private val store: SyncStateStore,
    private val source: HealthSource,
    private val transport: HttpTransport,
    private val appVersion: String,
    private val types: List<String>,
    private val clock: () -> Long = System::currentTimeMillis,
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    random: Random = Random.Default,
    private val limits: BatchLimits = BatchLimits(),
    private val currentPairing: (suspend () -> Pairing?)? = null,
) {
    private val mutex = Mutex()
    private var uploads = 0L
    private val uploadBackoff = Backoff(UPLOAD_BACKOFF_BASE_MS, UPLOAD_BACKOFF_CAP_MS, random = random)

    private sealed interface Outcome {
        data object Ok : Outcome

        data class TypeFailed(val errorCode: String) : Outcome

        /**
         * @property upload the server could not be reached, so there is no point sending more
         * @property transientHc a Health Connect hiccup that may be specific to one type
         */
        data class RunFailed(
            val errorCode: String,
            val retryAfterMs: Long? = null,
            val upload: Boolean = false,
            val transientHc: Boolean = false,
            val retryable: Boolean = true,
        ) : Outcome

        /** @property fresh the server refused the token just now, in this run */
        data class Rejected(val fresh: Boolean = true) : Outcome
    }

    private enum class Ready { OK, REJECTED, STALE }

    /** The pairing changed under a run: stop, and leave the store to whoever owns it now. */
    private val stale = Outcome.RunFailed(ERROR_PAIRING_CHANGED, upload = true, retryable = false)

    // ---------------------------------------------------------------------------------------
    // Incremental sync
    // ---------------------------------------------------------------------------------------

    /**
     * One incremental sync of every granted type, then a `syncState`-only batch so the server
     * learns the phone's permissions and errors even when there was no data to send.
     *
     * A run that could read nothing is not a success: with no type granted it fails as
     * `no_permissions`, and in the background without the background-read grant it is skipped
     * as `background_read_missing`. Both still report the phone's state to the server.
     */
    suspend fun syncOnce(session: Session): RunResult = mutex.withLock {
        when (prepare(session)) {
            Ready.REJECTED -> return@withLock RunResult.PairingRejected(notify = false)
            Ready.STALE -> return@withLock RunResult.Failed(ERROR_PAIRING_CHANGED, retryable = false)
            Ready.OK -> Unit
        }
        val runStart = clock()
        // An error from when a type was still granted says nothing about it now.
        for (type in types) {
            if (session.access.types[type] == Grant.GRANTED) continue
            store.updateType(type) {
                if (it.lastError == null && it.backlog == 0L) it else it.copy(lastError = null, backlog = 0)
            }
        }

        val granted = types.filter { session.access.types[it] == Grant.GRANTED }
        var failure: Outcome.RunFailed? = null
        if (granted.isEmpty()) {
            // Paired, and nothing it may read: the owner has to grant something. This comes
            // before the background check, which would otherwise hide it behind a lesser reason.
            val available = session.access.status == HealthConnectStatus.AVAILABLE
            failure = Outcome.RunFailed(if (available) ERROR_NO_PERMISSIONS else ERROR_HC_UNAVAILABLE, retryable = false)
        } else {
            if (!session.canRead) return@withLock skipRun(session)
            val rotation = store.updateGlobal {
                it.copy(rotation = (it.rotation + 1) % ROTATION_MODULUS, skipReason = null)
            }.rotation
            val order = granted.indices.map { granted[(it + rotation) % granted.size] }
            var failedTypes = 0
            var lastTypeError: String? = null
            for (type in order) {
                when (val outcome = guarded(type, backfill = false, runStart) { syncType(session, type) }) {
                    Outcome.Ok -> Unit
                    is Outcome.TypeFailed -> {
                        failedTypes++
                        lastTypeError = outcome.errorCode
                    }
                    is Outcome.RunFailed -> failure = outcome
                    is Outcome.Rejected -> return@withLock RunResult.PairingRejected(notify = outcome.fresh)
                }
                if (failure != null) break
            }
            if (failure == null && failedTypes == order.size) {
                // Every type failed on its own: that is not a sync, whatever the server says next.
                failure = Outcome.RunFailed(lastTypeError ?: "sync_failed")
            }
        }
        if (failure?.upload != true) {
            // The closing report must describe this run, not the one before it: set (or clear)
            // the error first, so the server never sees an error one sync late.
            val now = clock()
            val standing = failure?.let { StoredError(it.errorCode, now) }
            store.updateGlobal { it.copy(lastError = standing, retryAtMs = null) }
            when (val outcome = sendState(session)) {
                is Outcome.Rejected -> return@withLock RunResult.PairingRejected(notify = outcome.fresh)
                is Outcome.RunFailed -> failure = if (outcome === stale) outcome else failure ?: outcome
                is Outcome.TypeFailed -> failure = failure ?: Outcome.RunFailed(outcome.errorCode)
                Outcome.Ok -> Unit
            }
        }

        val failed = failure
        when {
            failed == null -> {
                val now = clock()
                store.updateGlobal {
                    it.copy(
                        lastSyncMs = now,
                        consecutiveFailures = 0,
                        lastError = null,
                        retryAtMs = null,
                        skipNotified = false,
                        skipReason = null,
                    )
                }
                RunResult.Success
            }
            // Not this pairing's failure to record: the store belongs to the new one.
            failed.errorCode == ERROR_PAIRING_CHANGED -> RunResult.Failed(ERROR_PAIRING_CHANGED, retryable = false)
            else -> {
                noteFailure(failed.errorCode)
                RunResult.Failed(failed.errorCode, failed.retryAfterMs, failed.retryable)
            }
        }
    }

    /**
     * Records a run that could not even start, for example because the phone's grants could not
     * be read. Nothing is sent: a state report built from an unknown state would overwrite a
     * true one on the server.
     */
    suspend fun failRun(errorCode: String): RunResult.Failed = mutex.withLock {
        noteFailure(errorCode)
        RunResult.Failed(errorCode)
    }

    /** Something the owner asked for could not be done; say why, without counting a failed sync. */
    suspend fun noteProblem(errorCode: String) = mutex.withLock {
        val now = clock()
        store.updateGlobal { it.copy(lastError = StoredError(errorCode, now), retryAtMs = null) }
    }

    private suspend fun noteFailure(errorCode: String) {
        val now = clock()
        store.updateGlobal {
            it.copy(
                consecutiveFailures = it.consecutiveFailures + 1,
                lastError = StoredError(errorCode, now),
                retryAtMs = null,
            )
        }
    }

    /**
     * The backfill is about to wait before trying the same unit again. Recorded before the
     * wait, so that for its whole length the status screen and the server show why nothing is
     * moving and when it will be tried again, instead of a backfill that merely looks busy.
     * Cleared by the next step that makes progress.
     */
    suspend fun noteBackfillWaiting(errorCode: String, retryAtMs: Long) = mutex.withLock {
        val now = clock()
        store.updateGlobal { it.copy(lastError = StoredError(errorCode, now), retryAtMs = retryAtMs) }
    }

    /**
     * The owner unpaired. A refusal the server gave the old pairing says nothing about the
     * next one, so the block and its error are dropped; positions and counts are kept, in case
     * the same device is paired again.
     */
    suspend fun pairingCleared() = mutex.withLock {
        store.updateGlobal {
            it.copy(rejectedTokenTag = null, lastError = it.lastError.unlessUnauthorized(), retryAtMs = null)
        }
    }

    private fun StoredError?.unlessUnauthorized(): StoredError? = this?.takeIf { it.errorCode != ERROR_UNAUTHORIZED }

    /**
     * A background run without the background-read grant: report the state, read nothing.
     *
     * The reason is kept apart from `lastError`. It is stamped afresh on every run, so as the
     * "last error" it would always be the newest and would hide whatever is actually wrong.
     */
    private suspend fun skipRun(session: Session): RunResult {
        // Before the report goes out, so the server learns of the skip from this run's report
        // and not from the next one.
        val startedAt = clock()
        store.updateGlobal { it.copy(skipReason = StoredError(ERROR_BACKGROUND_READ, startedAt)) }
        when (val outcome = sendState(session)) {
            is Outcome.Rejected -> return RunResult.PairingRejected(notify = outcome.fresh)
            is Outcome.RunFailed -> {
                if (outcome === stale) return RunResult.Failed(ERROR_PAIRING_CHANGED, retryable = false)
                noteFailure(outcome.errorCode)
                return RunResult.Failed(outcome.errorCode, outcome.retryAfterMs)
            }
            is Outcome.TypeFailed -> {
                noteFailure(outcome.errorCode)
                return RunResult.Failed(outcome.errorCode)
            }
            Outcome.Ok -> Unit
        }
        val first = !store.snapshot().global.skipNotified
        store.updateGlobal { it.copy(skipNotified = true) }
        return RunResult.Skipped(ERROR_BACKGROUND_READ, notify = first)
    }

    private suspend fun sendState(session: Session): Outcome =
        when (val delivery = deliver(session, "state", emptyList(), IN_RUN_ATTEMPTS)) {
            is Delivery.Done -> Outcome.Ok
            is Delivery.Stopped -> delivery.outcome
        }

    private suspend fun syncType(session: Session, type: String): Outcome {
        if (store.snapshot().type(type).reread != null) {
            val resumed = reread(session, type)
            if (resumed != Outcome.Ok) return resumed
        }
        var token = store.snapshot().type(type).token ?: takeToken(type)
        var recovered = false
        while (true) {
            val page = source.changes(token)
            if (page.expired) {
                // Once per run. A token that is reported expired the moment it was issued
                // would otherwise have this loop re-read and re-upload thirty days for ever.
                if (recovered) return Outcome.TypeFailed(ERROR_TOKEN_UNSTABLE)
                recovered = true
                // The fresh token is taken first, so nothing written during the re-read is
                // missed; it only becomes the type's token once the re-read is acknowledged.
                val fresh = source.changesToken(type)
                val now = clock()
                store.updateType(type) {
                    it.copy(reread = RereadState(fresh, now, now - REREAD_WINDOW_MS, FAR_FUTURE_MS))
                }
                val reread = reread(session, type)
                if (reread != Outcome.Ok) return reread
                token = fresh
                continue
            }
            val items = changeItems(page.changes)
            val next = page.nextToken
            if (items.isEmpty()) {
                if (next != token) store.updateType(type) { it.copy(token = next, tokenCreatedMs = clock()) }
            } else {
                val now = clock()
                val hours = touchedHours(items)
                if (items.any { it is BatchItem.Delete }) {
                    // A deletion says which record went, not when it was. Recompute every hour
                    // the changes token could have been covering.
                    hours.addAll(Hours.covering(now - REREAD_WINDOW_MS, now + Hours.MS))
                }
                val all = items + aggregateItems(type, hours, includeDeletes = true, now)
                val position = position("changes", type, token)
                val outcome = deliverAndCommit(session, type, position, all, IN_RUN_ATTEMPTS) {
                    it.copy(token = next, tokenCreatedMs = now)
                }
                if (outcome != Outcome.Ok) return outcome
            }
            if (!page.hasMore || next == token) return Outcome.Ok
            token = next
        }
    }

    private suspend fun takeToken(type: String): String {
        val fresh = source.changesToken(type)
        store.updateType(type) { it.copy(token = fresh, tokenCreatedMs = clock()) }
        return fresh
    }

    /**
     * Reads the window of a pending [RereadState] page by page, then swaps the new token in.
     *
     * What this cannot recover (see the class documentation): records deleted while the old
     * token was expired, and records dated before the window that were written during the gap.
     * The platform aggregates for the whole window are recomputed, so the totals at least are
     * right.
     */
    private suspend fun reread(session: Session, type: String): Outcome {
        var restarted = false
        while (true) {
            val pending = store.snapshot().type(type).reread ?: return Outcome.Ok
            val page = try {
                source.readRecords(type, pending.startMs, pending.endMs, pending.pageToken)
            } catch (e: HealthSourceException) {
                if (e.kind != HealthSourceException.Kind.INVALID || pending.pageToken == null) throw e
                // The page token did not survive; start the window again, once. The server
                // dedupes. A second refusal in the same run is not going to be cured by a third.
                if (restarted) return Outcome.TypeFailed(ERROR_PAGE_TOKEN)
                restarted = true
                store.updateType(type) { it.copy(reread = pending.copy(pageToken = null)) }
                continue
            }
            val now = clock()
            val items = page.records.map(BatchItem::record)
            val last = page.pageToken == null
            val hours = touchedHours(items)
            if (last) hours.addAll(Hours.covering(pending.startMs, now + Hours.MS))
            val all = items + aggregateItems(type, hours, includeDeletes = true, now)
            val position = position("reread", type, pending.startMs, pending.endMs, pending.pageToken.orEmpty())
            val outcome = deliverAndCommit(session, type, position, all, IN_RUN_ATTEMPTS) {
                if (last) {
                    it.copy(token = pending.newToken, tokenCreatedMs = pending.newTokenCreatedMs, reread = null)
                } else {
                    it.copy(reread = pending.copy(pageToken = page.pageToken))
                }
            }
            if (outcome != Outcome.Ok) return outcome
            if (last) return Outcome.Ok
        }
    }

    // ---------------------------------------------------------------------------------------
    // Backfill
    // ---------------------------------------------------------------------------------------

    /**
     * The owner asked for a full backfill.
     *
     * The first time, and while one is unfinished, this marks it as wanted and the loop carries
     * on from wherever each type stands. Asked again once the backfill is complete, it starts
     * the whole history over: every granted type's backfill cursor is reset, together with the
     * counts and first/last times that the re-upload will rebuild (left alone, they would count
     * every record twice). That is the owner's recovery path when the server lost or could not
     * apply something it had acknowledged, and it is safe to repeat, since the server stores by
     * record id. The changes tokens are left alone: incremental sync is not disturbed.
     */
    suspend fun requestBackfill(session: Session) = mutex.withLock {
        // First, so that state left by another device is gone before the request is recorded.
        if (prepare(session) == Ready.STALE) return@withLock
        val again = SyncStateReport.backfillComplete(types, session.access, store.snapshot())
        store.updateGlobal { it.copy(backfillRequested = true) }
        if (again) {
            for (type in types) {
                if (session.access.types[type] != Grant.GRANTED) continue
                store.updateType(type) {
                    it.copy(
                        backfill = BackfillState(),
                        backfillError = null,
                        uploaded = 0,
                        rejected = 0,
                        stubbed = 0,
                        firstMs = null,
                        lastMs = null,
                    )
                }
            }
        } else {
            reconcileHistory(session)
        }
    }

    /**
     * Keeps each type's "read with full history" claim true.
     *
     * A type whose backfill ran without the history permission read only the recent window the
     * platform allowed. Once the permission is granted that backfill is no longer complete: it
     * starts over, this time to the type's real first record.
     *
     * The other direction matters as much. If the permission is withdrawn while a type is
     * part-way through, the months it reads from then on come back empty and are committed as
     * done. So an unfinished type stops claiming full history the moment the permission is
     * gone, which is what makes it start over when the permission returns. A type that had
     * already finished with full history has no gap and is left alone.
     */
    private suspend fun reconcileHistory(session: Session) {
        val historyGranted = session.access.historyRead == Grant.GRANTED
        for (type in types) {
            if (session.access.types[type] != Grant.GRANTED) continue
            store.updateType(type) {
                val backfill = it.backfill
                when {
                    !backfill.started -> it
                    historyGranted && !backfill.fullHistory -> it.copy(backfill = BackfillState())
                    !historyGranted && backfill.fullHistory && !backfill.complete ->
                        it.copy(backfill = backfill.copy(fullHistory = false))
                    else -> it
                }
            }
        }
    }

    /**
     * One unit of backfill: a type's setup (its changes token, then how far its history
     * reaches), or one page of one month. The type furthest from done, by newest month, goes
     * first, so recent history arrives for every type before old history for any.
     *
     * A batch the server keeps failing with 5xx is reported as [BackfillStep.Backoff] every
     * time: the type waits for the server, it is not skipped.
     */
    suspend fun backfillStep(session: Session, run: BackfillRun): BackfillStep = mutex.withLock {
        when (prepare(session)) {
            Ready.REJECTED -> return@withLock BackfillStep.PairingRejected
            Ready.STALE -> return@withLock BackfillStep.Backoff(ERROR_PAIRING_CHANGED)
            Ready.OK -> Unit
        }
        if (!session.canRead) {
            // Nothing is read and no cursor moves; the owner has to grant background reading
            // or bring the app to the front.
            val now = clock()
            store.updateGlobal { it.copy(skipReason = StoredError(ERROR_BACKGROUND_READ, now)) }
            return@withLock BackfillStep.Incomplete(ERROR_BACKGROUND_READ)
        }
        reconcileHistory(session)
        val snapshot = store.snapshot()
        val candidates = types.filter {
            session.access.types[it] == Grant.GRANTED && !snapshot.type(it).backfill.complete && it !in run.skipped
        }
        if (candidates.isEmpty()) {
            val error = run.skipped.values.lastOrNull()
            return@withLock if (error == null) BackfillStep.Complete else BackfillStep.Incomplete(error)
        }
        val type = candidates.firstOrNull { !snapshot.type(it).backfill.started }
            ?: candidates.maxBy { snapshot.type(it).backfill.monthMs ?: Long.MIN_VALUE }

        val uploadsBefore = uploads
        when (val outcome = guarded(type, backfill = true, clock()) { backfillUnit(session, type, run) }) {
            Outcome.Ok -> {
                run.strikes.remove(type)
                // Whatever the backfill was waiting out is over.
                if (store.snapshot().global.retryAtMs != null) {
                    store.updateGlobal { it.copy(lastError = null, retryAtMs = null) }
                }
                BackfillStep.Progress(uploaded = uploads != uploadsBefore)
            }
            is Outcome.TypeFailed -> {
                run.skipped[type] = outcome.errorCode
                BackfillStep.Progress(uploaded = uploads != uploadsBefore)
            }
            is Outcome.RunFailed -> {
                if (outcome.transientHc) {
                    val strikes = (run.strikes[type] ?: 0) + 1
                    run.strikes[type] = strikes
                    if (strikes >= MAX_TRANSIENT_STRIKES) {
                        // One type that keeps failing must not hold up every other type.
                        run.skipped[type] = outcome.errorCode
                        val error = StoredError(outcome.errorCode, clock())
                        store.updateType(type) { it.copy(lastError = error, backfillError = error) }
                        return@withLock BackfillStep.Progress(uploaded = uploads != uploadsBefore)
                    }
                }
                BackfillStep.Backoff(outcome.errorCode, outcome.retryAfterMs)
            }
            is Outcome.Rejected -> BackfillStep.PairingRejected
        }
    }

    private suspend fun backfillUnit(session: Session, type: String, run: BackfillRun): Outcome {
        val state = store.snapshot().type(type)
        // The changes token comes first: anything written while the history is being read is
        // then behind the token, and the next incremental sync picks it up.
        if (state.token == null && state.reread == null) takeToken(type)

        val backfill = state.backfill
        if (!backfill.started) {
            val fullHistory = session.access.historyRead == Grant.GRANTED
            val earliest = probe(type, ascending = true)
            if (earliest == null) {
                store.updateType(type) {
                    it.copy(backfill = BackfillState(started = true, complete = true, fullHistory = fullHistory))
                }
                return Outcome.Ok
            }
            val latest = probe(type, ascending = false) ?: earliest
            val top = maxOf(Months.floor(clock()), Months.floor(latest))
            val floor = minOf(Months.floor(earliest), top)
            store.updateType(type) {
                it.copy(
                    backfill = BackfillState(
                        started = true,
                        topMonthMs = top,
                        floorMonthMs = floor,
                        monthMs = top,
                        fullHistory = fullHistory,
                    ),
                )
            }
            return Outcome.Ok
        }

        val month = backfill.monthMs ?: return Outcome.TypeFailed("backfill_state_invalid")
        val floor = backfill.floorMonthMs ?: return Outcome.TypeFailed("backfill_state_invalid")
        val monthEnd = Months.next(month)
        val page = try {
            source.readRecords(type, month, monthEnd, backfill.pageToken)
        } catch (e: HealthSourceException) {
            if (e.kind != HealthSourceException.Kind.INVALID || backfill.pageToken == null) throw e
            // Start the month again, once per session. If its page tokens keep being refused
            // the type is set aside rather than read from page one for ever.
            if (!run.pageRestarts.add("$type\u001f$month")) return Outcome.TypeFailed(ERROR_PAGE_TOKEN)
            store.updateType(type) { it.copy(backfill = it.backfill.copy(pageToken = null)) }
            return Outcome.Ok
        }
        val now = clock()
        val items = page.records.map(BatchItem::record)
        val last = page.pageToken == null
        val aggregates = if (last) {
            // Only hours that have a total. An empty hour needs no delete here: a first backfill
            // has nothing to remove, and incremental sync deletes the hours it empties.
            aggregateItems(type, Hours.covering(month, monthEnd).toHashSet(), includeDeletes = false, now)
        } else {
            emptyList()
        }
        val position = position("backfill", type, month, backfill.pageToken.orEmpty())
        return deliverAndCommit(session, type, position, items + aggregates, BACKFILL_ATTEMPTS) {
            val current = it.backfill
            if (!last) {
                it.copy(backfill = current.copy(pageToken = page.pageToken))
            } else {
                val previous = Months.previous(month)
                val done = previous < floor
                it.copy(
                    backfill = current.copy(
                        monthMs = if (done) month else previous,
                        pageToken = null,
                        oldestDoneMs = month,
                        complete = done,
                    ),
                )
            }
        }
    }

    /** The time of the type's earliest or latest readable record, or null when it has none. */
    private suspend fun probe(type: String, ascending: Boolean): Long? =
        source.readRecords(type, 0, FAR_FUTURE_MS, null, ascending = ascending, pageSize = 1)
            .records.firstOrNull()?.let(BatchItem::record)?.startMs

    // ---------------------------------------------------------------------------------------
    // Shared machinery
    // ---------------------------------------------------------------------------------------

    /** Whether [pairing] is still the one that is stored. True when nobody can be asked. */
    private suspend fun isCurrent(pairing: Pairing): Boolean {
        val provider = currentPairing ?: return true
        return provider() == pairing
    }

    /** Whether this session may touch the stored state and the server at all. */
    private suspend fun prepare(session: Session): Ready {
        // The session was built before the lock was taken. If the owner has paired again or
        // unpaired since, its pairing is history: acting on it could wipe the new device's
        // state or upload under a token that was just replaced.
        if (!isCurrent(session.pairing)) return Ready.STALE

        val global = store.snapshot().global
        if (global.deviceId == null) {
            // First use: adopt the device, keeping what was set before any run (a backfill
            // asked for straight after pairing).
            store.updateGlobal { it.copy(deviceId = session.pairing.deviceId) }
        } else if (global.deviceId != session.pairing.deviceId) {
            // State from another device row means nothing to this one.
            store.reset(session.pairing.deviceId)
            return Ready.OK
        }
        val rejected = global.rejectedTokenTag ?: return Ready.OK
        if (rejected == pairingTag(session)) return Ready.REJECTED
        // A different token, or the same one paired afresh: the owner has asked to try again,
        // and one request is all it costs to find out. The old refusal is no longer the news.
        store.updateGlobal { it.copy(rejectedTokenTag = null, lastError = it.lastError.unlessUnauthorized()) }
        return Ready.OK
    }

    /** Runs one type's work, turning what Health Connect throws into an [Outcome]. */
    private suspend fun guarded(
        type: String,
        backfill: Boolean,
        startedMs: Long,
        block: suspend () -> Outcome,
    ): Outcome {
        val outcome = try {
            block()
        } catch (e: HealthSourceException) {
            when (e.kind) {
                HealthSourceException.Kind.PERMISSION, HealthSourceException.Kind.INVALID ->
                    Outcome.TypeFailed(e.errorCode)
                HealthSourceException.Kind.TRANSIENT ->
                    if (backfill) Outcome.RunFailed(e.errorCode, transientHc = true) else Outcome.TypeFailed(e.errorCode)
                HealthSourceException.Kind.RATE_LIMITED, HealthSourceException.Kind.UNAVAILABLE ->
                    Outcome.RunFailed(e.errorCode)
            }
        }
        when (outcome) {
            is Outcome.TypeFailed -> {
                val error = StoredError(outcome.errorCode, clock())
                store.updateType(type) {
                    // What stops a type's backfill is remembered apart from `lastError`, which
                    // the type's next good incremental sync would wipe a moment later.
                    it.copy(lastError = error, backfillError = if (backfill) error else it.backfillError)
                }
            }
            Outcome.Ok -> store.updateType(type) {
                // An error noted during this very unit (a stubbed record) stays visible.
                val error = it.lastError
                val cleared = if (error != null && error.atMs < startedMs) it.copy(lastError = null) else it
                // Only the backfill of this type getting somewhere clears its backfill error.
                if (backfill && cleared.backfillError != null) cleared.copy(backfillError = null) else cleared
            }
            else -> Unit
        }
        return outcome
    }

    private suspend fun deliverAndCommit(
        session: Session,
        type: String,
        position: String,
        items: List<BatchItem>,
        attempts: Int,
        advance: (TypeState) -> TypeState,
    ): Outcome {
        if (items.isEmpty()) {
            store.updateType(type) { advance(it).copy(backlog = 0) }
            return Outcome.Ok
        }
        val real = items.count { !it.synthetic }.toLong()
        return when (val delivery = deliver(session, position, items, attempts)) {
            is Delivery.Done -> {
                val now = clock()
                store.updateType(type) { advance(counted(it, delivery.tally, now)).copy(backlog = 0) }
                Outcome.Ok
            }
            is Delivery.Stopped -> {
                // Nothing is committed: the same position is read and sent again next time.
                if (delivery.outcome !== stale) store.updateType(type) { it.copy(backlog = real) }
                delivery.outcome
            }
        }
    }

    /** What the server did with one position's records, summed over its batches. */
    private class Tally {
        var uploaded = 0L
        var rejected = 0L
        var stubbed = 0L
        var firstMs: Long? = null
        var lastMs: Long? = null

        /** Only records the server accepted count as uploaded and move the first/last times. */
        fun absorb(batch: EncodedBatch, ok: UploadResult.Ok) {
            val real = batch.items.filterIsInstance<BatchItem.Upsert>().filter { !it.synthetic }
            val records = real.filter { !it.stub }
            stubbed += real.size - records.size
            rejected += ok.rejected
            val accepted = when {
                ok.rejected == 0 -> records
                // The server lists the first hundred rejections; with the whole list, the
                // accepted records are known exactly.
                ok.rejectedIds.size == ok.rejected -> records.filter { it.id !in ok.rejectedIds }
                else -> null
            }
            uploaded += accepted?.size?.toLong() ?: (records.size - ok.rejected).coerceAtLeast(0).toLong()
            for (record in accepted.orEmpty()) {
                record.startMs?.let { firstMs = minOf(firstMs ?: it, it) }
                record.endMs?.let { lastMs = maxOf(lastMs ?: it, it) }
            }
        }
    }

    /**
     * The `rejected` and `stubbed` counts are the lasting trace of records that did not arrive
     * as themselves: they are persisted, shown per type and reported to the server. The error
     * code set here is only the prompt to look, and goes with the type's next clean unit.
     */
    private fun counted(state: TypeState, tally: Tally, now: Long): TypeState = state.copy(
        uploaded = state.uploaded + tally.uploaded,
        rejected = state.rejected + tally.rejected,
        stubbed = state.stubbed + tally.stubbed,
        firstMs = listOfNotNull(state.firstMs, tally.firstMs).minOrNull(),
        lastMs = listOfNotNull(state.lastMs, tally.lastMs).maxOrNull(),
        lastError = when {
            tally.stubbed > 0 -> StoredError(ERROR_STUBBED, now)
            tally.rejected > 0 -> StoredError(ERROR_REJECTED, now)
            else -> state.lastError
        },
    )

    private sealed interface Delivery {
        /** Every batch was acknowledged with a 200. */
        class Done(val tally: Tally) : Delivery

        data class Stopped(val outcome: Outcome) : Delivery
    }

    /** Uploads [items] as one or more batches. [Delivery.Done] only when all were acknowledged. */
    private suspend fun deliver(session: Session, position: String, items: List<BatchItem>, attempts: Int): Delivery {
        val encoder = BatchEncoder(session.pairing.deviceId, appVersion, limits)
        val report = SyncStateReport.build(types, session.access, store.snapshot(), session.facts, clock()).toString()
        val phoneTime = clock()
        val queue = ArrayDeque(encoder.plan(position, items, report, phoneTime))
        val tally = Tally()

        fun replaceHead(with: List<EncodedBatch>) {
            queue.removeFirst()
            queue.addAll(0, with)
        }

        /** Splits the head, or swaps its one oversize record for a stub. False: neither works. */
        fun shrinkHead(batch: EncodedBatch): Boolean {
            val halves = encoder.halve(position, batch, report, phoneTime)
            if (halves != null) {
                replaceHead(halves)
                return true
            }
            val stub = (batch.items.singleOrNull() as? BatchItem.Upsert)?.let(BatchItem::oversizeStub) ?: return false
            replaceHead(listOf(encoder.encode(position, listOf(stub), report, phoneTime)))
            return true
        }

        while (queue.isNotEmpty()) {
            val batch = queue.first()
            if (batch.exceeds(limits)) {
                // Over the server's own caps: sending it would only be refused.
                if (!shrinkHead(batch)) return Delivery.Stopped(Outcome.TypeFailed("record_too_large"))
                continue
            }
            when (val result = send(session, batch, attempts)) {
                is UploadResult.Ok -> {
                    tally.absorb(batch, result)
                    queue.removeFirst()
                }
                UploadResult.TooLarge ->
                    if (!shrinkHead(batch)) return Delivery.Stopped(Outcome.TypeFailed("payload_too_large"))
                UploadResult.Conflict -> {
                    // The id is derived from the bytes, so this should not happen; if it does,
                    // nothing was applied and the batch goes again under a random id.
                    if (batch.freshId) {
                        return Delivery.Stopped(Outcome.RunFailed(ERROR_CONFLICT, upload = true))
                    }
                    replaceHead(listOf(encoder.remint(position, batch, report, phoneTime)))
                }
                is UploadResult.Bug -> {
                    val probe = if (batch.items.isEmpty()) null else encoder.encode("probe", emptyList(), report, phoneTime)
                    return Delivery.Stopped(afterBug(session, result, probe, attempts))
                }
                UploadResult.Unauthorized -> return Delivery.Stopped(refused(session))
                UploadResult.Stale -> return Delivery.Stopped(stale)
                is UploadResult.Retry ->
                    return Delivery.Stopped(Outcome.RunFailed(result.errorCode, result.retryAfterMs, upload = true))
            }
        }
        return Delivery.Done(tally)
    }

    /**
     * What a 400 (or 415) means for the run. Nothing is skipped and nothing is split: the server
     * only ever answers these for a request as a whole, so no record can be singled out, and
     * the position stays where it is whatever this returns.
     *
     * One empty batch with the same envelope tells the two cases apart. If the server takes
     * it, the refusal was about that one body (or was not the server's at all: an intermediary,
     * a body damaged on the way) and only this type waits for the next run. If it is refused as
     * well, every batch would be, and the run stops. What happens to the probe itself is
     * treated as it would be for any request: a lost connection or a busy server is retried
     * later, and a refused token is a refused token.
     *
     * @param probe null when the refused batch was itself the empty one
     */
    private suspend fun afterBug(session: Session, bug: UploadResult.Bug, probe: EncodedBatch?, attempts: Int): Outcome {
        if (probe == null) return Outcome.RunFailed(bug.errorCode, upload = true)
        return when (val result = send(session, probe, attempts)) {
            is UploadResult.Bug -> Outcome.RunFailed(result.errorCode, upload = true)
            is UploadResult.Retry -> Outcome.RunFailed(result.errorCode, result.retryAfterMs, upload = true)
            UploadResult.Unauthorized -> refused(session)
            UploadResult.Stale -> stale
            is UploadResult.Ok, UploadResult.TooLarge, UploadResult.Conflict -> Outcome.TypeFailed(bug.errorCode)
        }
    }

    /** The server answered 401. Latches the refusal, unless the pairing is no longer ours. */
    private suspend fun refused(session: Session): Outcome {
        // A token the owner has just replaced or removed being refused is not news about the
        // pairing that is stored now, and must not block it.
        if (!isCurrent(session.pairing)) return stale
        val now = clock()
        store.updateGlobal {
            it.copy(rejectedTokenTag = pairingTag(session), lastError = StoredError(ERROR_UNAUTHORIZED, now))
        }
        return Outcome.Rejected(fresh = true)
    }

    /** One batch, retried in place a few times when the failure is the kind that passes. */
    private suspend fun send(session: Session, batch: EncodedBatch, attempts: Int): UploadResult {
        val pairing = session.pairing
        var attempt = 0
        while (true) {
            // Asked before every request: once the owner has unpaired or paired again, not one
            // more byte goes out under the old pairing.
            if (!isCurrent(pairing)) return UploadResult.Stale
            uploads++
            val result = try {
                UploadClassifier.classify(transport.post(pairing.ingestUrl, pairing.token, batch.gzip))
            } catch (_: IOException) {
                UploadClassifier.network()
            }
            if (result !is UploadResult.Retry) return result
            attempt++
            if (attempt >= attempts) return result
            val wait = uploadBackoff.delayMs(attempt - 1, result.retryAfterMs)
            if (wait > MAX_IN_RUN_WAIT_MS) return result
            sleeper(wait)
        }
    }

    /** One item per record id, the last change to it winning, in the order they last changed. */
    private fun changeItems(changes: List<HcChange>): List<BatchItem> {
        val byId = LinkedHashMap<String, BatchItem>()
        for (change in changes) {
            val item = when (change) {
                is HcChange.Upsert -> BatchItem.record(change.record)
                is HcChange.Delete -> BatchItem.Delete(change.id)
            }
            val id = if (item is BatchItem.Upsert) item.id else (item as BatchItem.Delete).id
            byId.remove(id)
            byId[id] = item
        }
        return byId.values.toList()
    }

    private fun touchedHours(items: List<BatchItem>): MutableSet<Long> {
        val hours = HashSet<Long>()
        for (item in items) {
            if (item !is BatchItem.Upsert) continue
            val start = item.startMs ?: continue
            hours.addAll(Hours.touched(start, item.endMs ?: start))
        }
        return hours
    }

    /**
     * Health Connect's own totals for [hours] of [type]'s metric, as synthetic records. With
     * [includeDeletes], an hour that no longer has a total becomes a delete of its record.
     */
    private suspend fun aggregateItems(
        type: String,
        hours: Set<Long>,
        includeDeletes: Boolean,
        now: Long,
    ): List<BatchItem> {
        val metric = AggMetric.forType(type) ?: return emptyList()
        val out = ArrayList<BatchItem>()
        for (range in Hours.ranges(hours)) {
            val found = try {
                source.aggregateHourly(metric, range.first, range.last + 1)
            } catch (e: HealthSourceException) {
                if (e.kind != HealthSourceException.Kind.INVALID) throw e
                // The records themselves must not wait on a total the platform will not compute.
                store.updateType(type) { it.copy(lastError = StoredError(ERROR_AGGREGATE, clock())) }
                continue
            }.associateBy { it.hourStartMs }
            var hour = range.first
            while (hour <= range.last) {
                val total = found[hour]
                if (total != null) {
                    out.add(BatchItem.aggregate(metric, total, now))
                } else if (includeDeletes) {
                    out.add(BatchItem.Delete(metric.recordId(hour), synthetic = true))
                }
                hour += Hours.MS
            }
        }
        return out
    }

    private fun position(vararg parts: Any): String = parts.joinToString("\u001f")

    companion object {
        /** How far back a type is re-read when its changes token has expired. */
        const val REREAD_WINDOW_MS = 30L * 24 * Hours.MS

        /**
         * An upper bound for "every record, including ones dated in the future" (year 2200). It
         * is also the latest instant the server accepts in any field.
         */
        const val FAR_FUTURE_MS = 7_258_118_400_000L

        const val ERROR_UNAUTHORIZED = "unauthorized"

        /** No reply from the server at all. The one failure that ends when connectivity returns. */
        const val ERROR_NETWORK = "network"
        const val ERROR_AGGREGATE = "aggregate_failed"
        const val ERROR_REJECTED = "records_rejected"
        const val ERROR_CONFLICT = "batch_id_conflict"

        /** A record too large to send even alone went up as a stub that says so. */
        const val ERROR_STUBBED = "record_oversize_stubbed"

        /** Paired, Health Connect available, and not one record type granted. */
        const val ERROR_NO_PERMISSIONS = "no_permissions"
        const val ERROR_HC_UNAVAILABLE = "hc_unavailable"

        /** In the background without the background-read grant: nothing was read. */
        const val ERROR_BACKGROUND_READ = "background_read_missing"

        /** The pairing changed between the start of a run and one of its requests. */
        const val ERROR_PAIRING_CHANGED = "pairing_changed"

        /** A changes token was reported expired straight after it was issued. */
        const val ERROR_TOKEN_UNSTABLE = "changes_token_unstable"

        /** Health Connect refused a page token again after the read was started over. */
        const val ERROR_PAGE_TOKEN = "page_token_invalid"

        /** Tries per batch within one scheduled run before the run gives up until next time. */
        const val IN_RUN_ATTEMPTS = 3

        /** The backfill loop does its own, longer backoff between steps. */
        const val BACKFILL_ATTEMPTS = 1
        const val UPLOAD_BACKOFF_BASE_MS = 2_000L
        const val UPLOAD_BACKOFF_CAP_MS = 30_000L

        /** A scheduled run never sleeps longer than this in one go; it ends and is rescheduled. */
        const val MAX_IN_RUN_WAIT_MS = 90_000L
        const val MAX_TRANSIENT_STRIKES = 5
        private const val ROTATION_MODULUS = 1_000_000

        /** The refused pairing: its token's tag and the act of pairing it came from. */
        fun pairingTag(session: Session): String = "${tokenTag(session.pairing.token)}:${session.pairingGeneration}"

        /** Enough of a digest to tell one token from another, far too little to recover one. */
        fun tokenTag(token: String): String =
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
                .take(4).joinToString("") { "%02x".format(it) }
    }
}
