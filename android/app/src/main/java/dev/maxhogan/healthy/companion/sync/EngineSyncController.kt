package dev.maxhogan.healthy.companion.sync

import android.app.ActivityManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import dev.maxhogan.healthy.companion.BuildConfig
import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import dev.maxhogan.healthy.companion.hc.RecordTypes
import dev.maxhogan.healthy.companion.hc.mapper.HcRecordSerializer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.transformLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Waits out a backoff of [waitMs]. With [interruptible], a signal on [wake] (the network came
 * back) ends the wait at once; the caller then starts its backoff again from the base, so
 * recovery from a lost connection does not lag behind the connection by up to the backoff's cap.
 *
 * @return true when the wait was cut short
 */
internal suspend fun awaitRetry(waitMs: Long, wake: ReceiveChannel<Unit>, interruptible: Boolean): Boolean {
    if (!interruptible) {
        delay(waitMs)
        return false
    }
    return withTimeoutOrNull(waitMs) { wake.receive() } != null
}

/**
 * Waits out a backoff that ends at the wall-clock time [untilMs], which is what the status
 * screen shows as "waiting to retry at".
 *
 * A plain delay counts only the time the phone is awake, so after a sleep it would still be
 * waiting long past the time on screen. This looks at the clock every [sliceMs] instead and ends
 * as soon as the moment has come. It also ends once [waitMs] of waiting has actually been done,
 * so a clock that is set back cannot stretch the wait.
 *
 * @return true when the wait was cut short by [wake]
 */
internal suspend fun awaitDeadline(
    untilMs: Long,
    waitMs: Long,
    wake: ReceiveChannel<Unit>,
    interruptible: Boolean,
    now: () -> Long = System::currentTimeMillis,
    sliceMs: Long = 15_000L,
): Boolean {
    var waited = 0L
    while (true) {
        val left = minOf(untilMs - now(), waitMs - waited)
        if (left <= 0) return false
        val slice = minOf(left, sliceMs)
        if (awaitRetry(slice, wake, interruptible)) return true
        waited += slice
    }
}

/**
 * How long the backfill waits before trying the same unit again.
 *
 * When the other side named a time (the server's `retry-after`, or the moment the shared Health
 * Connect gate opens) that is the wait, with a little jitter, however many times in a row it has
 * been asked for: a server that says "30 seconds" every time is asked every 30 seconds, not ever
 * more rarely. Only a failure that names no time backs off exponentially.
 */
internal fun backfillWaitMs(backoff: Backoff, attempt: Int, retryAfterMs: Long?): Long =
    if (retryAfterMs != null) backoff.delayMs(0, retryAfterMs) else backoff.delayMs(attempt)

/** Pure mapping from what the engine knows to what the status screen shows. */
object SyncUiStates {
    /** What changes without touching the store: grants, exemptions, and what is running. */
    data class Live(
        val access: HealthAccess = HealthAccess.none(HealthConnectStatus.UNAVAILABLE),
        val batteryExempt: Boolean = false,
        val hibernationExempt: Boolean = false,
        val syncing: Boolean = false,
        val backfilling: Boolean = false,
        /**
         * Set while the app cannot read or write its own sync state. Shown ahead of anything the
         * store says, since what the store says may be out of date for exactly that reason.
         */
        val storeError: StoredError? = null,
    )

    fun build(
        types: List<String>,
        pairing: PairingState,
        wifiOnly: Boolean,
        snapshot: SyncSnapshot,
        live: Live,
        nowMs: Long = System.currentTimeMillis(),
    ): SyncUiState = SyncUiState(
        pairing = pairing,
        access = live.access,
        activity = when {
            live.backfilling -> SyncActivity.BACKFILLING
            live.syncing -> SyncActivity.SYNCING
            else -> SyncActivity.IDLE
        },
        lastSyncMs = snapshot.global.lastSyncMs,
        backlog = types.filter { live.access.types[it] == Grant.GRANTED }.sumOf { snapshot.type(it).backlog },
        lastError = live.storeError?.let {
            SyncError(it.errorCode, it.atMs, snapshot.global.consecutiveFailures.coerceAtLeast(1))
        } ?: SyncStateReport.lastError(types, live.access, snapshot)?.let {
            SyncError(
                errorCode = it.errorCode,
                atMs = it.atMs,
                consecutiveFailures = snapshot.global.consecutiveFailures.coerceAtLeast(1),
                // A retry is only pending while something is running that will make it, and
                // only until its time comes: neither a stopped backfill nor a passed moment
                // is "waiting to retry".
                retryAtMs = SyncStateReport.retryAt(snapshot, it, nowMs).takeIf { live.backfilling },
            )
        },
        skipReason = snapshot.global.skipReason?.let { SyncError(it.errorCode, it.atMs) },
        backfill = progress(types, live.access, snapshot, live.backfilling),
        wifiOnly = wifiOnly,
        batteryExempt = live.batteryExempt,
        hibernationExempt = live.hibernationExempt,
        types = types.map { type ->
            val state = snapshot.type(type)
            TypeRow(
                type = type,
                permission = live.access.types[type] ?: Grant.UNAVAILABLE,
                firstMs = state.firstMs,
                lastMs = state.lastMs,
                uploaded = state.uploaded,
                rejected = state.rejected,
                stubbed = state.stubbed,
            )
        },
    )

    /**
     * Backfill progress in (type, month) units over the granted types.
     *
     * The phase is COMPLETE only while there is nothing left to fetch. A backfill that finished
     * without the history permission goes back to PAUSED when the permission is granted, which
     * is what makes the "Full backfill" button available again.
     */
    fun progress(types: List<String>, access: HealthAccess, snapshot: SyncSnapshot, running: Boolean): BackfillProgress {
        val states = types.filter { access.types[it] == Grant.GRANTED }.map { snapshot.type(it).backfill }
        val phase = when {
            !snapshot.global.backfillRequested -> BackfillPhase.NOT_STARTED
            SyncStateReport.backfillComplete(types, access, snapshot) -> BackfillPhase.COMPLETE
            running -> BackfillPhase.RUNNING
            else -> BackfillPhase.PAUSED
        }
        var done = 0
        var total = 0
        for (state in states) {
            val top = state.topMonthMs ?: continue
            val floor = state.floorMonthMs ?: continue
            val months = Months.count(floor, top)
            total += months
            done += when {
                state.complete -> months
                else -> state.monthMs?.let { Months.count(Months.next(it), top) } ?: 0
            }
        }
        return BackfillProgress(
            phase = phase,
            doneUnits = done,
            // Not known until every granted type has had its range measured.
            totalUnits = total.takeIf { states.isNotEmpty() && states.all { it.started } },
            oldestDoneMs = states.mapNotNull { it.oldestDoneMs }.minOrNull(),
            errorCode = SyncStateReport.backfillError(types, access, snapshot)?.errorCode,
        )
    }

    /**
     * Whether a backfill that is not running should be started again without the owner asking:
     * it was asked for, it is not complete (which includes "history has since been granted"),
     * the server has not refused this phone's token, and a read can be trusted from where the
     * app is now. Without the token check a refused pairing would have the service started,
     * stopped and its notification posted again on every periodic run.
     *
     * Nor is it started while a session that gave up still stands
     * ([GlobalState.backfillGaveUp]): that is read from the store, so it holds across process
     * death, and it is lifted by a change in what the phone allows or who it is paired with, by
     * a new build, by time for a cause that can pass, and by the owner asking.
     *
     * @param appVersion this build, or null to leave it out of the comparison
     */
    fun shouldResumeBackfill(
        types: List<String>,
        session: Session,
        snapshot: SyncSnapshot,
        nowMs: Long = System.currentTimeMillis(),
        appVersion: String? = null,
    ): Boolean =
        snapshot.global.backfillRequested &&
            snapshot.global.rejectedTokenTag == null &&
            session.canRead &&
            types.any { session.access.types[it] == Grant.GRANTED } &&
            !SyncStateReport.backfillComplete(types, session.access, snapshot) &&
            snapshot.global.backfillGaveUp?.lifted(BackfillGaveUp.fingerprint(types, session), appVersion, nowMs) != false
}

/**
 * The real [SyncController]: owns the [SyncEngine], its store and its schedule, and folds them
 * into the one [SyncUiState] the UI observes. The worker, the backfill service and the Tasker
 * receiver all come through here, so there is one engine and one lock per process.
 */
class EngineSyncController(private val dependencies: SyncDependencies) : SyncController {
    private val context: Context = dependencies.context
    private val scope = dependencies.scope
    private val types: List<String> = RecordTypes.ALL.map(RecordTypes::typeName)
    private val store: SyncStateStore = DataStoreSyncStateStore(context)
    private val scheduler = SyncScheduler(context)
    private val alarm = SyncAlarm(context)
    internal val notifications = SyncNotifications(context)
    private val engine = SyncEngine(
        store = store,
        source = HealthConnectSource(dependencies.healthConnect, HcRecordSerializer()),
        transport = UrlConnectionTransport(),
        appVersion = BuildConfig.VERSION_NAME,
        types = types,
        currentPairing = { dependencies.pairingStore.pairing.first() },
    )
    private val live = MutableStateFlow(SyncUiStates.Live())
    private val backfillRunning = AtomicBoolean(false)

    /** Runs in a row that could not read or write the sync state, which cannot count them itself. */
    private val storeFailures = AtomicInteger(0)
    private val providerVersion: String? by lazy { readProviderVersion() }

    /**
     * Keeps the CPU on while the backfill is working. A foreground service keeps the process, not
     * the processor: with the screen off the phone would otherwise sleep between two pages and
     * the backfill would only move when something else woke it. Always taken with a timeout, and
     * given up for a long wait, when there is nothing to stay awake for.
     */
    private val wakeLock: PowerManager.WakeLock? by lazy {
        try {
            context.getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "healthy:backfill")
                .apply { setReferenceCounted(false) }
        } catch (_: RuntimeException) {
            null
        }
    }

    /** A read of a store that failed is tried again; the flows the app hangs on must not end. */
    private fun <T> Flow<T>.survivingStoreFailures(): Flow<T> = retryWhen { cause, _ ->
        if (cause is Exception) delay(STORE_RETRY_MS)
        cause is Exception
    }

    private val pairingState = dependencies.pairingStore.pairing
        .map<Pairing?, PairingState> { it?.let { p -> PairingState.Paired(p.url, p.deviceId) } ?: PairingState.NotPaired }
        .distinctUntilChanged()
        .survivingStoreFailures()

    private class Inputs(val pairing: PairingState, val wifiOnly: Boolean, val snapshot: SyncSnapshot, val live: SyncUiStates.Live)

    @OptIn(ExperimentalCoroutinesApi::class) // transformLatest: the newest inputs replace a pending re-emission
    override val state: StateFlow<SyncUiState> =
        combine(
            pairingState,
            dependencies.settings.wifiOnly,
            store.snapshots,
            live,
            engine.storeFailure,
        ) { pairing, wifiOnly, snapshot, live, storeFailure ->
            Inputs(pairing, wifiOnly, snapshot, live.copy(storeError = storeFailure))
        }.transformLatest { inputs ->
            fun build() = SyncUiStates.build(types, inputs.pairing, inputs.wifiOnly, inputs.snapshot, inputs.live)
            var ui = build()
            emit(ui)
            // "Waiting to retry at T" is true only until T. Nothing else changes when T comes, so
            // the state is built again then, against the clock rather than a timer: a timer
            // stands still while the phone sleeps and the clock does not.
            while (true) {
                val retryAt = ui.lastError?.retryAtMs ?: break
                delay((retryAt - System.currentTimeMillis()).coerceIn(1, RETRY_POLL_MS))
                ui = build()
                emit(ui)
            }
        }.survivingStoreFailures().stateIn(scope, SharingStarted.Eagerly, SyncUiState())

    init {
        // The schedule follows the pairing and the Wi-Fi-only preference.
        scope.launch {
            combine(pairingState, dependencies.settings.wifiOnly) { pairing, wifiOnly -> pairing to wifiOnly }
                .survivingStoreFailures()
                .collect { (pairing, wifiOnly) ->
                    guarded {
                        if (pairing is PairingState.Paired) {
                            scheduler.schedulePeriodic(wifiOnly)
                            alarm.arm(SyncCadence.nextAlarmInMs(lastAttemptMs(), System.currentTimeMillis()))
                        } else {
                            scheduler.cancelAll()
                            alarm.cancel()
                            // Unpairing lifts a refused pairing and takes its error off screen.
                            engine.pairingCleared()
                        }
                    }
                }
        }
        refresh()
    }

    override fun syncNow(trigger: SyncTrigger) {
        scope.launch { requestSync(trigger) }
        refresh()
    }

    /**
     * Enqueues a one-off sync and returns once WorkManager has it on disk. For callers that
     * must not let go before then (a broadcast receiver whose process may be reaped).
     */
    suspend fun requestSync(trigger: SyncTrigger = SyncTrigger.MANUAL) {
        guarded {
            if (dependencies.pairingStore.pairing.first() == null) return@guarded
            scheduler.syncNow(dependencies.settings.wifiOnly.first(), trigger)
        }
    }

    /**
     * The watchdog alarm went off, the phone started, or the app was updated: put the schedule
     * back, ask for a sync if one is overdue, and set the alarm again. See [SyncCadence].
     *
     * The alarm is set again whatever else fails here, since it is what calls this the next
     * time; only an app that is known not to be paired lets it lapse.
     */
    suspend fun onWake() {
        var paired = true
        var next = SyncCadence.WATCHDOG_MS
        try {
            guarded {
                if (dependencies.pairingStore.pairing.first() == null) {
                    paired = false
                    return@guarded
                }
                val wifiOnly = dependencies.settings.wifiOnly.first()
                guarded { scheduler.schedulePeriodic(wifiOnly) }
                val now = System.currentTimeMillis()
                val last = lastAttemptMs()
                if (SyncCadence.overdue(last, now)) {
                    scheduler.syncNow(wifiOnly, SyncTrigger.ALARM)
                } else {
                    next = SyncCadence.nextAlarmInMs(last, now)
                }
            }
        } finally {
            if (paired) alarm.arm(next) else alarm.cancel()
        }
    }

    /** When a sync last started, or null when none has or the store cannot say. */
    private suspend fun lastAttemptMs(): Long? = try {
        store.snapshot().global.lastAttemptMs
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    override fun startBackfill() {
        scope.launch {
            guarded {
                val pairing = dependencies.pairingStore.pairing.first() ?: return@guarded
                val session = session(pairing)
                if (session == null) {
                    // The button was pressed and nothing can start: say why.
                    engine.noteProblem(SyncEngine.ERROR_HC_UNAVAILABLE)
                    return@guarded
                }
                // Asking is what lifts a backfill that had given up; the engine clears that.
                engine.requestBackfill(session)
                if (!backfillRunning.get() && !BackfillService.start(context)) noteBackfillNotStarted()
            }
        }
    }

    override fun refresh() {
        scope.launch { guarded { readAccess() } }
    }

    override fun setWifiOnly(enabled: Boolean) {
        // The schedule is re-planned by the collector in init when the preference changes.
        scope.launch { guarded { dependencies.settings.setWifiOnly(enabled) } }
    }

    /**
     * One incremental sync, for the worker. Null when the app is not paired, and when a scheduled
     * run finds that another sync started moments ago ([SyncCadence.shouldRun]). Never throws: an
     * unexpected failure is recorded as `internal_error` and reported as retryable.
     */
    suspend fun runSync(trigger: SyncTrigger = SyncTrigger.MANUAL): RunResult? {
        val pairing = try {
            dependencies.pairingStore.pairing.first()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Who the phone is paired with could not be read: nothing is sent on a guess.
            return storeFailed()
        }
        if (pairing == null) return null
        if (!SyncCadence.shouldRun(trigger, lastAttemptMs(), System.currentTimeMillis())) return null
        // A sync is starting: the watchdog has nothing to say until one is overdue again.
        alarm.arm(SyncCadence.WATCHDOG_MS)
        live.update { it.copy(syncing = true) }
        val result = try {
            // When the grants cannot be read the run must not go ahead on a guess: it would
            // "succeed" having read nothing and tell the server every type is unavailable.
            val session = session(pairing)
            if (session == null) engine.failRun(SyncEngine.ERROR_HC_UNAVAILABLE) else engine.syncOnce(session, trigger)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            try {
                engine.failRun(ERROR_INTERNAL)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                RunResult.Failed(ERROR_INTERNAL)
            }
        } finally {
            live.update { it.copy(syncing = false) }
        }
        if (result is RunResult.Failed && result.errorCode == SyncEngine.ERROR_STATE_STORE) return storeFailed()
        storeFailures.set(0)
        guarded {
            val global = store.snapshot().global
            when (result) {
                RunResult.Success -> notifications.clearFailure()
                // Told when the server says so, not again on every run that the refusal blocks.
                is RunResult.PairingRejected ->
                    if (result.notify) notifications.showFailure(SyncEngine.ERROR_UNAUTHORIZED, 1)
                // Told once, not every fifteen minutes.
                is RunResult.Skipped -> if (result.notify) notifications.showFailure(result.errorCode, 0)
                is RunResult.Failed ->
                    if (global.consecutiveFailures >= SyncNotifications.FAILURE_THRESHOLD) {
                        notifications.showFailure(result.errorCode, global.consecutiveFailures)
                    }
            }
        }
        return result
    }

    /**
     * A run that could not read or write the app's own state. The store cannot count these, so
     * they are counted here, and the owner is told after the same number as for any failure.
     */
    private fun storeFailed(): RunResult.Failed {
        val failures = storeFailures.incrementAndGet()
        if (failures >= SyncNotifications.FAILURE_THRESHOLD) {
            guarded { notifications.showFailure(SyncEngine.ERROR_STATE_STORE, failures) }
        }
        return RunResult.Failed(SyncEngine.ERROR_STATE_STORE)
    }

    /**
     * The backfill loop, for the foreground service. Returns when the history is uploaded, when
     * nothing more can be done until the owner acts (unpaired, token refused, every remaining
     * type failing, no trustworthy read), or when cancelled. Quota, network and server pushback
     * are waited out here, for as long as they last.
     */
    suspend fun runBackfill() {
        if (!backfillRunning.compareAndSet(false, true)) return
        live.update { it.copy(backfilling = true) }
        try {
            val run = BackfillRun()
            val backoff = Backoff(BACKFILL_BACKOFF_BASE_MS, BACKFILL_BACKOFF_CAP_MS)
            var attempt = 0
            var session: Session? = null
            var sessionAtMs = 0L
            val networkBack = Channel<Unit>(Channel.CONFLATED)
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    networkBack.trySend(Unit)
                }
            }
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            val watching = try {
                connectivity.registerDefaultNetworkCallback(callback)
                true
            } catch (_: RuntimeException) {
                // Without it the backfill still recovers, only on the backoff's own schedule.
                false
            }
            try {
            while (true) {
                // Awake for the step that follows; see wakeLock.
                stayAwake(WORK_WAKE_MS)
                val stored = try {
                    dependencies.pairingStore.pairing.first() to dependencies.settings.wifiOnly.first()
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // The pairing or the Wi-Fi preference could not be read. Nothing is sent on
                    // a guess at either; it is asked again shortly.
                    letSleep()
                    delay(STORE_RETRY_MS)
                    continue
                }
                val pairing = stored.first ?: break
                if (stored.second && isMetered()) {
                    // Said, not only done: otherwise the screen shows a backfill that looks busy.
                    val until = System.currentTimeMillis() + WAIT_FOR_WIFI_MS
                    val waiting = BackfillWait(ERROR_WAITING_FOR_WIFI, until)
                    guarded { engine.noteBackfillWaiting(waiting.errorCode, until) }
                    guarded { notifications.updateBackfill(state.value.backfill, waiting, force = true) }
                    letSleep()
                    awaitDeadline(until, WAIT_FOR_WIFI_MS, networkBack, interruptible = true)
                    continue
                }
                val now = System.currentTimeMillis()
                val current = session?.takeIf { it.pairing == pairing && now - sessionAtMs < ACCESS_REFRESH_MS }
                    ?: session(pairing)?.also {
                        session = it
                        sessionAtMs = now
                    }
                val step = try {
                    if (current == null) {
                        BackfillStep.Backoff(SyncEngine.ERROR_HC_UNAVAILABLE)
                    } else {
                        engine.backfillStep(current, run)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    BackfillStep.Backoff(ERROR_INTERNAL)
                }
                when (step) {
                    is BackfillStep.Progress -> {
                        attempt = 0
                        guarded { notifications.updateBackfill(state.value.backfill) }
                        // Stay under the server's per-device request rate: a pause for every
                        // request the step made, not one per step, since one page of large
                        // records goes up as several batches.
                        if (step.requests > 0) delay(UPLOAD_PACING_MS * step.requests)
                    }
                    is BackfillStep.Backoff -> {
                        // A session the engine would not use (the pairing changed) is rebuilt.
                        session = null
                        val wait = backfillWaitMs(backoff, attempt++, step.retryAfterMs)
                        val until = System.currentTimeMillis() + wait
                        if (step.errorCode != SyncEngine.ERROR_PAIRING_CHANGED) {
                            // Before the wait, not after: this is what says "waiting to retry".
                            guarded { engine.noteBackfillWaiting(step.errorCode, until) }
                            guarded {
                                notifications.updateBackfill(state.value.backfill, BackfillWait(step.errorCode, until), force = true)
                            }
                        }
                        // A short wait is stayed awake through; for a long one the phone may
                        // sleep, and the wait ends by the clock when it next wakes.
                        if (wait > MAX_AWAKE_WAIT_MS) letSleep() else stayAwake(wait + WORK_WAKE_MS)
                        // Only a lost connection is cut short by the network coming back; a
                        // server that asked for time (429, 5xx) is given it.
                        val cutShort = awaitDeadline(until, wait, networkBack, step.errorCode == SyncEngine.ERROR_NETWORK)
                        if (cutShort) attempt = 0
                        guarded { notifications.updateBackfill(state.value.backfill, force = true) }
                    }
                    BackfillStep.Complete -> break
                    // The engine has recorded that this session gave up, in the store, so the
                    // periodic worker does not start the service again only to stop at the same
                    // place: not in this process and not in the next.
                    is BackfillStep.Incomplete -> break
                    BackfillStep.PairingRejected -> {
                        // Told when the server says so, not again by a session that finds the
                        // refusal already there (a restart after the process was killed).
                        if (run.rejectedNow) guarded { notifications.showFailure(SyncEngine.ERROR_UNAUTHORIZED, 1) }
                        break
                    }
                }
            }
            } finally {
                letSleep()
                if (watching) {
                    try {
                        connectivity.unregisterNetworkCallback(callback)
                    } catch (_: RuntimeException) {
                        // Already gone.
                    }
                }
            }
        } finally {
            backfillRunning.set(false)
            live.update { it.copy(backfilling = false) }
        }
    }

    /**
     * Restarts the backfill service when there is backfill left that nobody is running: after
     * the process was killed part-way, or when the history permission was granted after a
     * backfill that had to make do without it. The system only allows the start from the
     * background for an app exempt from battery optimisation; otherwise the backfill stays
     * paused until the owner opens the app and resumes it.
     */
    suspend fun resumeBackfillIfWanted() {
        guarded {
            if (backfillRunning.get()) return@guarded
            val pairing = dependencies.pairingStore.pairing.first() ?: return@guarded
            val session = session(pairing) ?: return@guarded
            val wanted = SyncUiStates.shouldResumeBackfill(
                types,
                session,
                store.snapshot(),
                System.currentTimeMillis(),
                BuildConfig.VERSION_NAME,
            )
            if (wanted) BackfillService.start(context)
        }
    }

    private fun stayAwake(forMs: Long) {
        try {
            wakeLock?.acquire(forMs)
        } catch (_: RuntimeException) {
            // Without it the backfill still runs whenever the phone is awake.
        }
    }

    private fun letSleep() {
        try {
            wakeLock?.takeIf { it.isHeld }?.release()
        } catch (_: RuntimeException) {
            // Released by its timeout in the meantime.
        }
    }

    /** The system would not let the backfill service run; the UI shows it as paused. */
    internal fun noteBackfillNotStarted() {
        scope.launch { guarded { engine.noteProblem(ERROR_BACKFILL_NOT_STARTED) } }
    }

    /** Null when Health Connect is there but would not say what is granted. */
    private suspend fun session(pairing: Pairing): Session? {
        val access = readAccess() ?: return null
        val facts = DeviceFacts(
            batteryExempt = isBatteryExempt(),
            hcProviderVersion = providerVersion,
            androidSdk = Build.VERSION.SDK_INT,
            hibernationExempt = isHibernationExempt(),
        )
        return Session(
            pairing = pairing,
            access = access,
            facts = facts,
            foreground = isForeground(),
            pairingGeneration = dependencies.pairingStore.generation(),
        )
    }

    private suspend fun readAccess(): HealthAccess? {
        val access = dependencies.healthConnect.readOrNull()
        val battery = isBatteryExempt()
        val hibernation = isHibernationExempt()
        live.update {
            it.copy(
                access = access ?: HealthAccess.none(HealthConnectStatus.UNAVAILABLE),
                batteryExempt = battery,
                hibernationExempt = hibernation,
            )
        }
        return access
    }

    private fun isBatteryExempt(): Boolean =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    /** True when the system will not withdraw this app's permissions for being unused. */
    private fun isHibernationExempt(): Boolean = try {
        context.packageManager.isAutoRevokeWhitelisted
    } catch (_: RuntimeException) {
        false
    }

    /**
     * Whether Health Connect treats the app as in the foreground: an activity on screen, or its
     * foreground service running. Anything less is the background, where a read needs the
     * background-read grant.
     */
    private fun isForeground(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE
    }

    private fun isMetered(): Boolean = try {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        capabilities == null || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    } catch (_: SecurityException) {
        // Without ACCESS_NETWORK_STATE the network cannot be judged; Wi-Fi only then means wait.
        true
    }

    /** Health Connect's version name, from whichever package provides it on this phone. */
    private fun readProviderVersion(): String? = PROVIDER_PACKAGES.firstNotNullOfOrNull { name ->
        try {
            context.packageManager.getPackageInfo(name, 0).versionName
        } catch (_: Exception) {
            null
        }
    }

    /** The controller's contract is that no method throws; a failure here has nowhere to go. */
    private inline fun guarded(block: () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Deliberately not logged: nothing in this class may write record or token content.
        }
    }

    private companion object {
        const val ERROR_INTERNAL = SyncEngine.ERROR_INTERNAL
        const val ERROR_BACKFILL_NOT_STARTED = "backfill_not_started"
        const val BACKFILL_BACKOFF_BASE_MS = 5_000L
        const val BACKFILL_BACKOFF_CAP_MS = 15 * 60_000L
        const val ERROR_WAITING_FOR_WIFI = "waiting_for_wifi"
        const val WAIT_FOR_WIFI_MS = 60_000L
        const val ACCESS_REFRESH_MS = 30_000L

        /** 600 ms after every upload is at most 100 requests a minute; the server allows 120. */
        const val UPLOAD_PACING_MS = 600L

        /** How long a failed read of the pairing or the sync state is left before it is tried again. */
        const val STORE_RETRY_MS = 5_000L

        /** How often a pending "waiting to retry at" is checked against the clock. */
        const val RETRY_POLL_MS = 1_000L

        /** The wake lock's timeout for one step of work; taken again before every step. */
        const val WORK_WAKE_MS = 10 * 60_000L

        /** A wait longer than this is not worth keeping the CPU on for. */
        const val MAX_AWAKE_WAIT_MS = 60_000L

        val PROVIDER_PACKAGES = listOf(
            "com.google.android.healthconnect.controller",
            "com.android.healthconnect.controller",
            "com.google.android.apps.healthdata",
        )
    }
}
