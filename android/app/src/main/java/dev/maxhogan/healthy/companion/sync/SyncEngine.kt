package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.cancellation.CancellationException
import kotlin.random.Random
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
    /**
     * @property uploaded whether the step sent anything
     * @property requests how many requests it made of the server, so the caller can pace them:
     *   one page of large records goes up as several batches, and each counts against the
     *   server's per-device rate
     */
    data class Progress(val uploaded: Boolean, val requests: Int = if (uploaded) 1 else 0) : BackfillStep

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

    /** How many records to ask for at a time, per type, steered by what the pages weigh. */
    internal val pages = PageSizer()

    /**
     * True when the server refused the token during this session, as opposed to the session
     * finding a refusal that was already known. The owner is told of a refusal once.
     */
    var rejectedNow: Boolean = false
        internal set
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
 * **Pushback is not failure.** Health Connect's rate limit and the server's 429 both mean "not
 * now". Each closes a gate ([PushbackGate]) that every caller in the process shares: until it
 * opens, neither the backfill nor an incremental sync makes that kind of request, a run that
 * finds it closed counts no failed sync, and a wait the backfill has put on screen is left
 * there. See [syncOnce] and [backfillStep].
 *
 * **The store may fail too.** See [SyncStateStore] for the rule; [storeFailure] is where a
 * failed write shows.
 *
 * Nothing here logs, and no error code is ever built from a message.
 *
 * @param currentPairing the pairing as it is stored right now. It is read inside the engine's
 *   lock and again before every request, so a run that was handed an older pairing cannot touch
 *   (or wipe) the state of a newer one, nor keep uploading after the owner unpaired
 */
class SyncEngine(
    store: SyncStateStore,
    source: HealthSource,
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
    private val store: SyncStateStore = GuardedStateStore(store)

    /** Closed while Health Connect's rate limit is being waited out. One per process. */
    private val hcGate = PushbackGate(clock)

    /** Closed while the server has asked for time (a 429, or any refusal with `retry-after`). */
    private val serverGate = PushbackGate(clock)
    private val source: HealthSource = GatedHealthSource(source, hcGate)
    private val storeFailed = MutableStateFlow<StoredError?>(null)

    /**
     * Set while the state store is failing, and cleared by the next unit that gets through it.
     * Kept in memory because the store that failed cannot be asked to remember that it did.
     */
    val storeFailure: StateFlow<StoredError?> get() = storeFailed

    /** Runs one entry point, turning a store that will not read or write into [onFailure]. */
    private suspend fun <T> storing(onFailure: () -> T, block: suspend () -> T): T = try {
        val result = block()
        if (storeFailed.value != null) storeFailed.value = null
        result
    } catch (e: StateStoreException) {
        storeFailed.value = StoredError(ERROR_STATE_STORE, clock())
        onFailure()
    }

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
            /** Asked to wait (a rate limit), not failed: no failed sync is counted for it. */
            val pushback: Boolean = false,
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
     *
     * While the server's gate is closed the run does nothing at all, and while Health Connect's
     * is closed it reads nothing and only reports its state. Either way it returns the refusal
     * that closed the gate as a [RunResult.Failed], but no failed sync is counted (so the
     * three-failures notification is not raised by a wait), and if the backfill is showing
     * "waiting to retry" that is left exactly as it is.
     */
    suspend fun syncOnce(session: Session): RunResult = storing({ RunResult.Failed(ERROR_STATE_STORE) }) {
        mutex.withLock { syncLocked(session) }
    }

    private suspend fun syncLocked(session: Session): RunResult {
        when (prepare(session)) {
            Ready.REJECTED -> return RunResult.PairingRejected(notify = false)
            Ready.STALE -> return RunResult.Failed(ERROR_PAIRING_CHANGED, retryable = false)
            Ready.OK -> Unit
        }
        // The server asked for time. Nothing it has not asked for is sent, and nothing is read
        // that could not be delivered anyway.
        serverGate.remainingMs()?.let { return RunResult.Failed(serverGate.errorCode, it) }
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
        } else if (!session.canRead) {
            return skipRun(session)
        } else if (hcGate.remainingMs() != null) {
            // Health Connect said "not now" to someone in this process, and that goes for every
            // reader until the moment it gave. No quota is spent finding out again.
            failure = Outcome.RunFailed(hcGate.errorCode, pushback = true)
        } else {
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
                    is Outcome.Rejected -> return RunResult.PairingRejected(notify = outcome.fresh)
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
            store.updateGlobal { it.withRunError(standing, now) }
            when (val outcome = sendState(session)) {
                is Outcome.Rejected -> return RunResult.PairingRejected(notify = outcome.fresh)
                is Outcome.RunFailed -> failure = if (outcome === stale) outcome else failure ?: outcome
                is Outcome.TypeFailed -> failure = failure ?: Outcome.RunFailed(outcome.errorCode)
                Outcome.Ok -> Unit
            }
        }

        val failed = failure ?: run {
            val now = clock()
            store.updateGlobal {
                it.copy(lastSyncMs = now, consecutiveFailures = 0, skipNotified = false, skipReason = null)
                    .withRunError(null, now)
            }
            return RunResult.Success
        }
        return runFailed(failed)
    }

    /**
     * Sets the error a run ends with (or clears it), unless a backfill is waiting something out:
     * then `lastError` and `retryAtMs` say why nothing is moving and when it is tried again, and
     * a sync that happens to run in the meantime must not take that off the screen.
     */
    private fun GlobalState.withRunError(error: StoredError?, nowMs: Long): GlobalState =
        if (waitPending(nowMs)) this else copy(lastError = error, retryAtMs = null)

    /** Records how a run failed and builds its result. */
    private suspend fun runFailed(failed: Outcome.RunFailed): RunResult.Failed {
        when {
            // Not this pairing's failure to record: the store belongs to the new one.
            failed.errorCode == ERROR_PAIRING_CHANGED -> return RunResult.Failed(ERROR_PAIRING_CHANGED, retryable = false)
            // Asked to wait. Shown, but not a failed sync: the count behind the "syncs keep
            // failing" notification does not move.
            failed.pushback -> {
                val now = clock()
                store.updateGlobal { it.withRunError(StoredError(failed.errorCode, now), now) }
            }
            else -> noteFailure(failed.errorCode)
        }
        return RunResult.Failed(failed.errorCode, failed.retryAfterMs, failed.retryable)
    }

    /**
     * Records a run that could not even start, for example because the phone's grants could not
     * be read. Nothing is sent: a state report built from an unknown state would overwrite a
     * true one on the server.
     */
    suspend fun failRun(errorCode: String): RunResult.Failed = storing({ RunResult.Failed(errorCode) }) {
        mutex.withLock {
            noteFailure(errorCode)
            RunResult.Failed(errorCode)
        }
    }

    /** Something the owner asked for could not be done; say why, without counting a failed sync. */
    suspend fun noteProblem(errorCode: String) = storing<Unit>({}) {
        mutex.withLock {
            val now = clock()
            store.updateGlobal { it.copy(lastError = StoredError(errorCode, now), retryAtMs = null) }
        }
    }

    private suspend fun noteFailure(errorCode: String) {
        val now = clock()
        store.updateGlobal {
            it.copy(consecutiveFailures = it.consecutiveFailures + 1).withRunError(StoredError(errorCode, now), now)
        }
    }

    /**
     * The backfill is about to wait before trying the same unit again. Recorded before the
     * wait, so that for its whole length the status screen and the server show why nothing is
     * moving and when it will be tried again, instead of a backfill that merely looks busy.
     * Cleared by the next step that makes progress.
     */
    suspend fun noteBackfillWaiting(errorCode: String, retryAtMs: Long) = storing<Unit>({}) {
        mutex.withLock {
            val now = clock()
            store.updateGlobal { it.copy(lastError = StoredError(errorCode, now), retryAtMs = retryAtMs) }
        }
    }

    /**
     * The owner unpaired. A refusal the server gave the old pairing says nothing about the
     * next one, so the block and its error are dropped; positions and counts are kept, in case
     * the same device is paired again.
     */
    suspend fun pairingCleared() = storing<Unit>({}) {
        mutex.withLock {
            store.updateGlobal {
                it.copy(
                    rejectedTokenTag = null,
                    lastError = it.lastError.unlessUnauthorized(),
                    retryAtMs = null,
                    // Whatever stopped the backfill under the old pairing says nothing about
                    // the next one.
                    backfillGaveUp = null,
                )
            }
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
                return runFailed(outcome)
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
     *
     * A re-run differs from a first backfill in one thing: it also removes. The first time there
     * is nothing on the server to take away, so a month only uploads the hourly platform totals
     * it has. The second time the server may hold a total for an hour that has none any more
     * (its records were deleted while a changes token was expired, say), so each month of a
     * re-run also sends a delete for every hour without a total, and it walks every month of the
     * range the earlier backfill covered, including months that have lost all their records.
     *
     * Asking is also what lifts a backfill that had given up: the owner wants it tried.
     */
    suspend fun requestBackfill(session: Session) = storing<Unit>({}) {
        mutex.withLock { requestBackfillLocked(session) }
    }

    private suspend fun requestBackfillLocked(session: Session) {
        // First, so that state left by another device is gone before the request is recorded.
        if (prepare(session) == Ready.STALE) return
        val again = SyncStateReport.backfillComplete(types, session.access, store.snapshot())
        store.updateGlobal { it.copy(backfillRequested = true, backfillGaveUp = null) }
        if (again) {
            for (type in types) {
                if (session.access.types[type] != Grant.GRANTED) continue
                store.updateType(type) {
                    it.copy(
                        backfill = BackfillState(
                            rerun = true,
                            rerunFloorMs = it.backfill.floorMonthMs,
                            rerunTopMs = it.backfill.topMonthMs,
                        ),
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
        // Called before every backfill step, and almost never has anything to do: look first,
        // and write only for a type that needs it.
        val snapshot = store.snapshot()
        for (type in types) {
            if (session.access.types[type] != Grant.GRANTED) continue
            val seen = snapshot.type(type).backfill
            if (!seen.started || seen.fullHistory == historyGranted) continue
            if (!historyGranted && seen.complete) continue
            store.updateType(type) {
                val backfill = it.backfill
                when {
                    !backfill.started -> it
                    historyGranted && !backfill.fullHistory -> it.copy(
                        backfill = BackfillState(
                            rerun = backfill.rerun,
                            rerunFloorMs = backfill.rerunFloorMs ?: backfill.floorMonthMs.takeIf { backfill.rerun },
                            rerunTopMs = backfill.rerunTopMs ?: backfill.topMonthMs.takeIf { backfill.rerun },
                        ),
                    )
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
     *
     * A step that finds a gate closed (Health Connect's rate limit, or the server having asked
     * for time, whoever in the process was told) is a [BackfillStep.Backoff] carrying the time
     * left, and makes no request.
     *
     * When the session can do no more, that is persisted ([GlobalState.backfillGaveUp]) before
     * the step returns, so the periodic worker does not start the service again for nothing,
     * in this process or the next.
     */
    suspend fun backfillStep(session: Session, run: BackfillRun): BackfillStep =
        storing({ BackfillStep.Backoff(ERROR_STATE_STORE) }) {
            mutex.withLock { backfillLocked(session, run) }
        }

    private suspend fun backfillLocked(session: Session, run: BackfillRun): BackfillStep {
        when (prepare(session)) {
            Ready.REJECTED -> return BackfillStep.PairingRejected
            Ready.STALE -> return BackfillStep.Backoff(ERROR_PAIRING_CHANGED)
            Ready.OK -> Unit
        }
        if (!session.canRead) {
            // Nothing is read and no cursor moves; the owner has to grant background reading
            // or bring the app to the front.
            val now = clock()
            store.updateGlobal { it.copy(skipReason = StoredError(ERROR_BACKGROUND_READ, now)) }
            return BackfillStep.Incomplete(ERROR_BACKGROUND_READ)
        }
        serverGate.remainingMs()?.let { return BackfillStep.Backoff(serverGate.errorCode, it) }
        hcGate.remainingMs()?.let { return BackfillStep.Backoff(hcGate.errorCode, it) }
        reconcileHistory(session)
        val snapshot = store.snapshot()
        val candidates = types.filter {
            session.access.types[it] == Grant.GRANTED && !snapshot.type(it).backfill.complete && it !in run.skipped
        }
        if (candidates.isEmpty()) {
            val error = run.skipped.values.lastOrNull()
            if (error == null) {
                backfillMoving()
                return BackfillStep.Complete
            }
            val passing = run.skipped.values.any { it !in BackfillGaveUp.PERMANENT }
            gaveUp(session, error, retry = passing)
            return BackfillStep.Incomplete(error)
        }
        val type = candidates.firstOrNull { !snapshot.type(it).backfill.started }
            ?: candidates.maxBy { snapshot.type(it).backfill.monthMs ?: Long.MIN_VALUE }

        val uploadsBefore = uploads

        fun progress() = (uploads - uploadsBefore).toInt().let { BackfillStep.Progress(uploaded = it > 0, requests = it) }
        return when (val outcome = guarded(type, backfill = true, clock()) { backfillUnit(session, type, run) }) {
            Outcome.Ok -> {
                run.strikes.remove(type)
                backfillMoving()
                progress()
            }
            is Outcome.TypeFailed -> {
                run.skipped[type] = outcome.errorCode
                progress()
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
                        return progress()
                    }
                }
                // Health Connect gives no time of its own; the gate that just closed has one.
                val wait = outcome.retryAfterMs ?: hcGate.remainingMs().takeIf { outcome.pushback && !outcome.upload }
                BackfillStep.Backoff(outcome.errorCode, wait)
            }
            is Outcome.Rejected -> {
                run.rejectedNow = outcome.fresh
                gaveUp(session, ERROR_UNAUTHORIZED, retry = false)
                BackfillStep.PairingRejected
            }
        }
    }

    /** The backfill got somewhere: whatever it was waiting out, or had given up over, is over. */
    private suspend fun backfillMoving() {
        val global = store.snapshot().global
        if (global.retryAtMs == null && global.backfillGaveUp == null) return
        store.updateGlobal {
            val cleared = if (it.retryAtMs != null) it.copy(lastError = null, retryAtMs = null) else it
            cleared.copy(backfillGaveUp = null)
        }
    }

    /**
     * This session can do no more. Remembered across process death, with what the phone allowed
     * at the time, so that a change in that (a grant, a new pairing, a new build) is the cue to
     * try again and nothing else is.
     *
     * @param retry true when the cause may pass by itself, so one more try is allowed later
     */
    private suspend fun gaveUp(session: Session, errorCode: String, retry: Boolean) {
        val now = clock()
        val record = BackfillGaveUp(
            errorCode = errorCode,
            atMs = now,
            fingerprint = BackfillGaveUp.fingerprint(types, session),
            appVersion = appVersion,
            retryAtMs = if (retry) now + BackfillGaveUp.RETRY_MS else null,
        )
        store.updateGlobal { it.copy(backfillGaveUp = record) }
    }

    private suspend fun backfillUnit(session: Session, type: String, run: BackfillRun): Outcome {
        val state = store.snapshot().type(type)
        // The changes token comes first: anything written while the history is being read is
        // then behind the token, and the next incremental sync picks it up.
        if (state.token == null && state.reread == null) takeToken(type)

        val backfill = state.backfill
        // A re-run of a type with platform totals walks every month, so that it can take away
        // the totals of months that have lost their records. Everything else skips empty months.
        val everyMonth = backfill.rerun && AggMetric.forType(type) != null
        if (!backfill.started) {
            val fullHistory = session.access.historyRead == Grant.GRANTED
            val first = probe(type, ascending = true)
            val earliest = first?.startMs
            val before = backfill.takeIf { everyMonth && it.rerunFloorMs != null }
            if (earliest == null && before == null) {
                store.updateType(type) {
                    it.copy(
                        backfill = BackfillState(started = true, complete = true, fullHistory = fullHistory, rerun = backfill.rerun),
                    )
                }
                return Outcome.Ok
            }
            val newest = if (earliest == null) null else probe(type, ascending = false)
            val latest = earliest?.let { newest?.startMs ?: it }
            // The two records just read are the first word on how heavy this type's records are.
            listOfNotNull(first, newest).maxOfOrNull { it.rawBytes }?.let { run.pages.seed(type, it.toLong()) }
            val top = listOfNotNull(Months.floor(clock()), latest?.let(Months::floor), before?.rerunTopMs).max()
            val floor = minOf(listOfNotNull(earliest?.let(Months::floor), before?.rerunFloorMs).min(), top)
            store.updateType(type) {
                it.copy(
                    backfill = BackfillState(
                        started = true,
                        topMonthMs = top,
                        floorMonthMs = floor,
                        monthMs = top,
                        fullHistory = fullHistory,
                        rerun = backfill.rerun,
                    ),
                )
            }
            return Outcome.Ok
        }

        val month = backfill.monthMs ?: return Outcome.TypeFailed("backfill_state_invalid")
        val floor = backfill.floorMonthMs ?: return Outcome.TypeFailed("backfill_state_invalid")
        val monthEnd = Months.next(month)
        // A month is read to its end at the size it was started with: a page token is only ever
        // handed back with the page size that produced it.
        val pageSize = if (backfill.pageToken == null) {
            run.pages.size(type)
        } else {
            backfill.pageSize ?: HealthSource.DEFAULT_PAGE_SIZE
        }
        val page = try {
            source.readRecords(type, month, monthEnd, backfill.pageToken, pageSize = pageSize)
        } catch (e: HealthSourceException) {
            val transient = e.kind == HealthSourceException.Kind.TRANSIENT
            if (transient && tooMuchAtOnce(e, type, run) && run.pages.shrink(type, pageSize)) {
                // The page may simply have been too much at once. The month is started again at
                // a smaller size, straight away and without counting against the type; what was
                // already uploaded of it goes again, which the server takes as the same records.
                store.updateType(type) { it.copy(backfill = it.backfill.copy(pageToken = null, pageSize = null)) }
                return Outcome.Ok
            }
            if (e.kind != HealthSourceException.Kind.INVALID || backfill.pageToken == null) throw e
            // Start the month again, once per session. If its page tokens keep being refused
            // the type is set aside rather than read from page one for ever.
            if (!run.pageRestarts.add("$type\u001f$month")) return Outcome.TypeFailed(ERROR_PAGE_TOKEN)
            store.updateType(type) { it.copy(backfill = it.backfill.copy(pageToken = null, pageSize = null)) }
            return Outcome.Ok
        }
        val now = clock()
        val items = page.records.map(BatchItem::record)
        run.pages.measured(type, items.size, items.sumOf { it.rawBytes.toLong() })
        val last = page.pageToken == null
        if (last && items.isEmpty() && backfill.pageToken == null && !everyMonth) {
            return skipEmptyMonths(type, month, floor)
        }
        val aggregates = if (last) {
            // The month's own hours, and any later hour one of its records runs into: the month
            // above may be empty and skipped, and that hour would then never get its total.
            val hours = Hours.covering(month, monthEnd).toHashSet()
            hours.addAll(touchedHours(items))
            // A first backfill sends only the hours that have a total: there is nothing on the
            // server to remove, and incremental sync deletes the hours it empties. A re-run
            // also deletes the hours that have none, so the server's totals converge.
            aggregateItems(type, hours, includeDeletes = backfill.rerun, now)
        } else {
            emptyList()
        }
        val position = position("backfill", type, month, backfill.pageToken.orEmpty())
        return deliverAndCommit(session, type, position, items + aggregates, BACKFILL_ATTEMPTS) {
            val current = it.backfill
            if (!last) {
                it.copy(backfill = current.copy(pageToken = page.pageToken, pageSize = pageSize))
            } else {
                val previous = Months.previous(month)
                val done = previous < floor
                it.copy(
                    backfill = current.copy(
                        monthMs = if (done) month else previous,
                        pageToken = null,
                        pageSize = null,
                        oldestDoneMs = month,
                        complete = done,
                    ),
                )
            }
        }
    }

    /**
     * Whether a failed read is worth repeating smaller. A page that did not fit in memory is, at
     * once. Any other failure is first tried again as it was (Health Connect does stumble), and
     * only when it has failed [SHRINK_AFTER_STRIKES] times running is its size suspected.
     */
    private fun tooMuchAtOnce(e: HealthSourceException, type: String, run: BackfillRun): Boolean =
        e.errorCode == HealthConnectSource.ERROR_PAGE_TOO_LARGE || (run.strikes[type] ?: 0) >= SHRINK_AFTER_STRIKES

    /**
     * [month] has no record at all. Rather than ask for every month below it in turn, ask once
     * for the newest record older than it and go straight to that record's month; when there is
     * none the type is done. A type with a reading every few years then costs a few requests,
     * not one per month of its range, and nothing in between needs an upload.
     */
    private suspend fun skipEmptyMonths(type: String, month: Long, floor: Long): Outcome {
        val older = if (month > floor) probe(type, ascending = false, endMs = month)?.startMs else null
        store.updateType(type) {
            val current = it.backfill
            if (older == null) {
                it.copy(
                    backfill = current.copy(pageToken = null, oldestDoneMs = minOf(floor, month), complete = true),
                    backlog = 0,
                )
            } else {
                val target = Months.floor(older)
                it.copy(
                    backfill = current.copy(
                        monthMs = target,
                        // A record older than the range that was measured has appeared since.
                        floorMonthMs = minOf(floor, target),
                        pageToken = null,
                        oldestDoneMs = Months.next(target),
                    ),
                    backlog = 0,
                )
            }
        }
        return Outcome.Ok
    }

    /** The type's earliest or latest readable record before [endMs], or null when it has none. */
    private suspend fun probe(type: String, ascending: Boolean, endMs: Long = FAR_FUTURE_MS): BatchItem.Upsert? =
        source.readRecords(type, 0, endMs, null, ascending = ascending, pageSize = 1)
            .records.firstOrNull()?.let(BatchItem::record)

    // ---------------------------------------------------------------------------------------
    // Shared machinery
    // ---------------------------------------------------------------------------------------

    /** Whether [pairing] is still the one that is stored. True when nobody can be asked. */
    private suspend fun isCurrent(pairing: Pairing): Boolean {
        val provider = currentPairing ?: return true
        val current = try {
            provider()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The pairing store could not be read. Not knowing who the phone is paired with is
            // a reason to send nothing, so it ends the unit like any other failed store.
            throw StateStoreException(e)
        }
        return current == pairing
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
        store.updateGlobal {
            it.copy(rejectedTokenTag = null, lastError = it.lastError.unlessUnauthorized(), backfillGaveUp = null)
        }
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
                HealthSourceException.Kind.RATE_LIMITED -> Outcome.RunFailed(e.errorCode, pushback = true)
                HealthSourceException.Kind.UNAVAILABLE -> Outcome.RunFailed(e.errorCode)
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
                is UploadResult.Retry -> return Delivery.Stopped(notDelivered(result))
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
            is UploadResult.Retry -> notDelivered(result)
            UploadResult.Unauthorized -> refused(session)
            UploadResult.Stale -> stale
            is UploadResult.Ok, UploadResult.TooLarge, UploadResult.Conflict -> Outcome.TypeFailed(bug.errorCode)
        }
    }

    /** A batch the server did not take this time. Pushback when it was a 429 that said so. */
    private fun notDelivered(result: UploadResult.Retry): Outcome.RunFailed = Outcome.RunFailed(
        result.errorCode,
        result.retryAfterMs,
        upload = true,
        pushback = serverGate.remainingMs() != null && serverGate.uncounted && serverGate.errorCode == result.errorCode,
    )

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
            val reply = try {
                transport.post(pairing.ingestUrl, pairing.token, batch.gzip)
            } catch (_: IOException) {
                null
            }
            val result = reply?.let(UploadClassifier::classify) ?: UploadClassifier.network()
            if (result is UploadResult.Ok) serverGate.passed()
            if (result !is UploadResult.Retry) return result
            // A 429, or any refusal that names a time: nobody in the process asks again before
            // it. Only the 429 is pushback; a 503 with `retry-after` is still a failure.
            val limited = reply?.status == HTTP_TOO_MANY_REQUESTS
            if (limited || result.retryAfterMs != null) {
                serverGate.close(result.errorCode, result.retryAfterMs, uncounted = limited)
            }
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

        /** The phone could not read or write its own sync state. Nothing was lost: see [SyncStateStore]. */
        const val ERROR_STATE_STORE = "state_store_failed"
        private const val HTTP_TOO_MANY_REQUESTS = 429

        /** Tries per batch within one scheduled run before the run gives up until next time. */
        const val IN_RUN_ATTEMPTS = 3

        /** The backfill loop does its own, longer backoff between steps. */
        const val BACKFILL_ATTEMPTS = 1
        const val UPLOAD_BACKOFF_BASE_MS = 2_000L
        const val UPLOAD_BACKOFF_CAP_MS = 30_000L

        /** A scheduled run never sleeps longer than this in one go; it ends and is rescheduled. */
        const val MAX_IN_RUN_WAIT_MS = 90_000L
        const val MAX_TRANSIENT_STRIKES = 5

        /** Failed reads of one page in a row before the backfill tries a smaller page. */
        const val SHRINK_AFTER_STRIKES = 2
        private const val ROTATION_MODULUS = 1_000_000

        /** The refused pairing: its token's tag and the act of pairing it came from. */
        fun pairingTag(session: Session): String = "${tokenTag(session.pairing.token)}:${session.pairingGeneration}"

        /** Enough of a digest to tell one token from another, far too little to recover one. */
        fun tokenTag(token: String): String =
            MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
                .take(4).joinToString("") { "%02x".format(it) }
    }
}
