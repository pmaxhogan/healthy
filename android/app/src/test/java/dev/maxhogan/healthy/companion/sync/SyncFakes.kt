package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import java.io.ByteArrayInputStream
import java.io.IOException
import java.util.zip.GZIPInputStream
import kotlin.random.Random
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/** A fixed instant every test starts from: 400 seconds into a UTC hour, in the middle of a month. */
const val NOW = 1_790_003_200_000L

const val DEVICE = "01HZZZZZZZZZZZZZZZZZZZZZZZ"
val PAIRING = Pairing("https://healthy.example.com", DEVICE, "hcd1.$DEVICE.${"a".repeat(43)}")

/** A synthetic wire record. Every value is made up; origins are `com.example.*`. */
fun record(
    id: String,
    type: String = "Steps",
    start: Long = NOW,
    end: Long = start + 60_000,
    lastModified: Long = start,
    padding: String = "",
): JsonObject = buildJsonObject {
    put("id", JsonPrimitive(id))
    put("type", JsonPrimitive(type))
    put("origin", JsonPrimitive("com.example.wearable"))
    put("lastModified", JsonPrimitive(lastModified))
    put("start", JsonPrimitive(start))
    put("end", JsonPrimitive(end))
    put("data", buildJsonObject { put("count", JsonPrimitive(1)); if (padding.isNotEmpty()) put("pad", JsonPrimitive(padding)) })
}

fun access(
    vararg granted: String,
    denied: List<String> = emptyList(),
    history: Grant = Grant.GRANTED,
    background: Grant = Grant.GRANTED,
): HealthAccess = HealthAccess(
    status = HealthConnectStatus.AVAILABLE,
    types = granted.associateWith { Grant.GRANTED } + denied.associateWith { Grant.DENIED },
    backgroundRead = background,
    historyRead = history,
    exerciseRoutes = Grant.GRANTED,
)

val FACTS = DeviceFacts(batteryExempt = true, hcProviderVersion = "2026.01.01", androidSdk = 37, hibernationExempt = true)

class InMemorySyncStateStore : SyncStateStore {
    private val state = MutableStateFlow(SyncSnapshot())
    override val snapshots: Flow<SyncSnapshot> = state

    override suspend fun snapshot(): SyncSnapshot = state.value

    override suspend fun updateType(type: String, transform: (TypeState) -> TypeState): TypeState {
        val next = transform(state.value.type(type))
        state.value = state.value.copy(types = state.value.types + (type to next))
        return next
    }

    override suspend fun updateGlobal(transform: (GlobalState) -> GlobalState): GlobalState {
        val next = transform(state.value.global)
        state.value = state.value.copy(global = next)
        return next
    }

    override suspend fun reset(deviceId: String) {
        state.value = SyncSnapshot(GlobalState(deviceId = deviceId))
    }
}

/** A scriptable Health Connect. Page tokens are offsets; changes tokens are `<type>#<n>`. */
class FakeHealthSource : HealthSource {
    val calls = ArrayList<String>()
    val records = HashMap<String, MutableList<JsonObject>>()
    val changePages = HashMap<String, ChangesPage>()
    val aggregates = HashMap<AggMetric, MutableMap<Long, HourAggregate>>()
    val aggregateRequests = ArrayList<Triple<AggMetric, Long, Long>>()

    /** Thrown by every call that names the type, until removed. */
    val failing = HashMap<String, HealthSourceException>()

    /** Thrown once each, by the next calls of any kind. */
    val failNext = ArrayDeque<HealthSourceException>()
    var pageSize = 1000

    /** Types whose every changes token is reported expired, however fresh. */
    val alwaysExpired = HashSet<String>()

    /** Types for which any read with a page token is refused as invalid. */
    val refusePageTokens = HashSet<String>()

    /** Thrown by every aggregate call, and by nothing else. */
    var aggregateFailure: HealthSourceException? = null
    private val tokenCounters = HashMap<String, Int>()

    fun add(type: String, vararg wire: JsonObject) {
        records.getOrPut(type) { ArrayList() }.addAll(wire)
    }

    fun total(metric: AggMetric, hourStartMs: Long, value: Double, vararg origins: String) {
        aggregates.getOrPut(metric) { HashMap() }[hourStartMs] = HourAggregate(hourStartMs, value, origins.toList())
    }

    private fun gate(type: String?) {
        failNext.removeFirstOrNull()?.let { throw it }
        type?.let(failing::get)?.let { throw it }
    }

    override suspend fun changesToken(type: String): String {
        calls.add("token:$type")
        gate(type)
        val n = (tokenCounters[type] ?: 0) + 1
        tokenCounters[type] = n
        return "$type#$n"
    }

    override suspend fun changes(token: String): ChangesPage {
        calls.add("changes:$token")
        gate(token.substringBefore('#'))
        if (token.substringBefore('#') in alwaysExpired) return ChangesPage(emptyList(), "", hasMore = false, expired = true)
        return changePages[token] ?: ChangesPage(emptyList(), token, hasMore = false, expired = false)
    }

    override suspend fun readRecords(
        type: String,
        startMs: Long,
        endMs: Long,
        pageToken: String?,
        ascending: Boolean,
        pageSize: Int,
    ): RecordsPage {
        calls.add("read:$type:$startMs:$endMs:${pageToken ?: "-"}")
        gate(type)
        if (pageToken != null && type in refusePageTokens) {
            throw HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
        }
        val size = if (pageSize == 1) 1 else this.pageSize
        val matching = records[type].orEmpty()
            .filter { it.getValue("start").jsonPrimitive.long in startMs until endMs }
            .sortedBy { it.getValue("start").jsonPrimitive.long }
            .let { if (ascending) it else it.reversed() }
        val offset = pageToken?.toInt() ?: 0
        val page = matching.drop(offset).take(size)
        val next = (offset + size).takeIf { it < matching.size }?.toString()
        return RecordsPage(page, next)
    }

    override suspend fun aggregateHourly(metric: AggMetric, startMs: Long, endMs: Long): List<HourAggregate> {
        calls.add("aggregate:${metric.metric}")
        gate(metric.sourceType)
        aggregateFailure?.let { throw it }
        aggregateRequests.add(Triple(metric, startMs, endMs))
        return aggregates[metric].orEmpty().values.filter { it.hourStartMs in startMs until endMs }
    }
}

/** One uploaded body, decoded. */
class SentBatch(val json: JsonObject) {
    val batchId: String get() = json.getValue("batchId").jsonPrimitive.content
    val upserts: JsonArray get() = json.getValue("upserts").jsonArray
    val deletes: List<String> get() = json.getValue("deletes").jsonArray.map { it.jsonPrimitive.content }
    val upsertIds: List<String> get() = upserts.map { it.jsonObject.getValue("id").jsonPrimitive.content }
    val isStateOnly: Boolean get() = upserts.isEmpty() && deletes.isEmpty()

    /** The `data` object of each upsert, in order. */
    val data: List<JsonObject> get() = upserts.map { it.jsonObject.getValue("data").jsonObject }
}

/** Records every POST and answers from a script; once the script runs out, every POST is a 200. */
class FakeTransport : HttpTransport {
    val sent = ArrayList<SentBatch>()
    val tokens = ArrayList<String>()
    val script = ArrayDeque<(SentBatch) -> HttpReply?>()

    /** Applied to every POST before the script; return null to fall through. */
    var rule: (SentBatch) -> HttpReply? = { null }

    val data: List<SentBatch> get() = sent.filter { !it.isStateOnly }

    override suspend fun post(url: String, token: String, gzipBody: ByteArray): HttpReply {
        val raw = GZIPInputStream(ByteArrayInputStream(gzipBody)).readBytes().toString(Charsets.UTF_8)
        val batch = SentBatch(Json.parseToJsonElement(raw).jsonObject)
        sent.add(batch)
        tokens.add(token)
        rule(batch)?.let { return it }
        script.removeFirstOrNull()?.let { step -> step(batch)?.let { return it } }
        return ok(batch)
    }

    companion object {
        /**
         * @param rejectedIds the ids the server lists as rejected
         * @param rejectedTotal the exact count, which can be more than the list (it is cut short)
         */
        fun ok(batch: SentBatch, rejectedIds: List<String> = emptyList(), rejectedTotal: Int = rejectedIds.size): HttpReply {
            val list = rejectedIds.joinToString(",") { """{"id":"$it","errorCode":"invalid_record"}""" }
            val accepted = batch.upserts.size - rejectedTotal
            return HttpReply(
                200,
                null,
                """{"accepted":$accepted,"deleted":${batch.deletes.size},"rejected":[$list],"rejectedTotal":$rejectedTotal,"duplicate":false,"serverTime":$NOW}""",
            )
        }

        fun status(code: Int, error: String, retryAfterS: Long? = null): HttpReply =
            HttpReply(code, retryAfterS, """{"error":"$error"}""")

        val offline: (SentBatch) -> HttpReply? = { throw IOException("offline") }
    }
}

/** An engine wired to fakes, with a clock that only moves when the engine sleeps. */
class Rig(types: List<String> = listOf("Steps", "HeartRate", "TotalCaloriesBurned"), limits: BatchLimits = BatchLimits()) {
    val store = InMemorySyncStateStore()
    val source = FakeHealthSource()
    val transport = FakeTransport()
    val sleeps = ArrayList<Long>()
    var now = NOW

    /** What the pairing store holds "right now"; null is unpaired. */
    var storedPairing: Pairing? = PAIRING
    val engine = SyncEngine(
        store = store,
        source = source,
        transport = transport,
        appVersion = "0.1.0",
        types = types,
        clock = { now },
        sleeper = {
            sleeps.add(it)
            now += it
        },
        random = Random(7),
        limits = limits,
        currentPairing = { storedPairing },
    )
    var access = access(*types.toTypedArray())

    /** True as if the app were on screen; false is a background run. */
    var foreground = true

    /** Bumped by every pair and unpair, as [PairingStore.generation] is. */
    var pairingGeneration = 1L

    fun session(pairing: Pairing = PAIRING) = Session(pairing, access, FACTS, foreground, pairingGeneration)

    /** A run with [pairing] as the stored pairing, the way the controller would start one. */
    suspend fun sync(pairing: Pairing = PAIRING): RunResult {
        storedPairing = pairing
        return engine.syncOnce(session(pairing))
    }

    suspend fun type(name: String): TypeState = store.snapshot().type(name)

    /** Runs backfill steps until one is not progress (or [maxSteps] is reached). */
    suspend fun backfill(run: BackfillRun = BackfillRun(), maxSteps: Int = 10_000): BackfillStep {
        engine.requestBackfill(session())
        repeat(maxSteps) {
            val step = engine.backfillStep(session(), run)
            if (step !is BackfillStep.Progress) return step
        }
        return BackfillStep.Progress(false)
    }
}
