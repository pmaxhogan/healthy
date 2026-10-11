package dev.maxhogan.healthy.companion.sync

import kotlinx.serialization.json.long
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.Grant
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncEngineTest {
    private val day = 24 * Hours.MS

    private fun upserts(vararg wire: JsonObject) = wire.map { HcChange.Upsert(it) }

    private fun page(changes: List<HcChange>, next: String, hasMore: Boolean = false) =
        ChangesPage(changes, next, hasMore, expired = false)

    private fun hr(id: String, start: Long = NOW) = record(id, type = "HeartRate", start = start)

    private val failData: (SentBatch) -> HttpReply? = { if (it.isStateOnly) null else FakeTransport.status(500, "oops") }

    // --- tokens and the state report -----------------------------------------------------------

    @Test
    fun `a first run takes a token per type and still tells the server its state`() = runTest {
        val rig = Rig()
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("Steps#1", rig.type("Steps").token)
        assertEquals(NOW, rig.type("HeartRate").tokenCreatedMs)
        val only = rig.transport.sent.single()
        assertTrue(only.isStateOnly)
        assertEquals(3, only.json.getValue("syncState").jsonObject.getValue("types").jsonArray.size)
        assertEquals(PAIRING.token, rig.transport.tokens.single())
        assertEquals(NOW, rig.store.snapshot().global.lastSyncMs)
    }

    @Test
    fun `types that are not granted are never read`() = runTest {
        val rig = Rig()
        rig.access = access("Steps", denied = listOf("HeartRate", "TotalCaloriesBurned"))
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("token:Steps", "changes:Steps#1"), rig.source.calls)
    }

    // --- ack, then commit ----------------------------------------------------------------------

    @Test
    fun `a token is not persisted until the server acknowledges, and a retry is the same batch`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#next")
        rig.transport.rule = failData

        val failed = rig.sync()
        assertEquals(RunResult.Failed("http_500"), failed)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        assertEquals(2, rig.type("HeartRate").backlog)
        assertEquals(0, rig.type("HeartRate").uploaded)
        assertEquals(1, rig.store.snapshot().global.consecutiveFailures)
        val attempts = rig.transport.data.map { it.batchId }
        assertEquals(SyncEngine.IN_RUN_ATTEMPTS, attempts.size)
        assertEquals(1, attempts.toSet().size)
        assertEquals(SyncEngine.IN_RUN_ATTEMPTS - 1, rig.sleeps.size)

        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#next", rig.type("HeartRate").token)
        assertEquals(2, rig.type("HeartRate").uploaded)
        assertEquals(0, rig.type("HeartRate").backlog)
        // The next run reads the same position and sends the same records again.
        assertEquals(listOf("a", "b"), rig.transport.data.last().upsertIds)
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)
        assertNull(rig.store.snapshot().global.lastError)
    }

    @Test
    fun `a replay that has grown is not mistaken for a duplicate`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#n1")
        rig.transport.rule = failData
        rig.sync()
        val first = rig.transport.data.last().batchId

        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#n2")
        rig.transport.rule = { null }
        rig.sync()
        assertNotEquals(first, rig.transport.data.last().batchId)
        assertEquals("HeartRate#n2", rig.type("HeartRate").token)
    }

    @Test
    fun `changes are followed while there are more, committing page by page`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#p2", hasMore = true)
        rig.source.changePages["HeartRate#p2"] = page(upserts(hr("b")), "HeartRate#p3")
        var dataPosts = 0
        rig.transport.rule = { if (!it.isStateOnly && ++dataPosts > 1) FakeTransport.status(503, "down") else null }

        assertEquals(RunResult.Failed("http_503"), rig.sync())
        // The first page was acknowledged, so its token is kept; the second was not.
        assertEquals("HeartRate#p2", rig.type("HeartRate").token)
        assertEquals(1, rig.type("HeartRate").uploaded)

        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#p3", rig.type("HeartRate").token)
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `deletions are sent as ids and the last change to a record wins`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(
            listOf(
                HcChange.Upsert(hr("a")),
                HcChange.Delete("a"),
                HcChange.Delete("x"),
                HcChange.Upsert(hr("x")),
                HcChange.Delete("gone"),
            ),
            "HeartRate#2",
        )
        rig.sync()
        val batch = rig.transport.data.single()
        assertEquals(listOf("x"), batch.upsertIds)
        assertEquals(listOf("a", "gone"), batch.deletes)
        assertEquals(1, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `first and last record times and the uploaded count follow acknowledged records`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a", NOW - 5 * day), hr("b", NOW - day)), "HeartRate#2")
        rig.sync()
        val state = rig.type("HeartRate")
        assertEquals(NOW - 5 * day, state.firstMs)
        assertEquals(NOW - day + 60_000, state.lastMs)
        assertEquals(2, state.uploaded)
    }

    // --- what each failure does ----------------------------------------------------------------

    @Test
    fun `401 stops everything until the owner pairs again`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }

        assertTrue(rig.sync() is RunResult.PairingRejected)
        assertEquals("unauthorized", rig.store.snapshot().global.lastError?.errorCode)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        assertTrue(rig.sleeps.isEmpty())

        val posts = rig.transport.sent.size
        val reads = rig.source.calls.size
        assertTrue(rig.sync() is RunResult.PairingRejected)
        assertEquals(BackfillStep.PairingRejected, rig.engine.backfillStep(rig.session(), BackfillRun()))
        assertEquals(posts, rig.transport.sent.size)
        assertEquals(reads, rig.source.calls.size)

        // The same device row with a rotated token: positions are kept, uploads resume.
        rig.transport.rule = { null }
        val repaired = PAIRING.copy(token = "hcd1.$DEVICE.${"b".repeat(43)}")
        assertEquals(RunResult.Success, rig.sync(repaired))
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertNull(rig.store.snapshot().global.rejectedTokenTag)
        assertEquals(repaired.token, rig.transport.tokens.last())
    }

    @Test
    fun `413 halves the batch until it is taken, and nothing is skipped`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] =
            page(upserts(hr("a"), hr("b"), hr("c"), hr("d"), hr("e")), "HeartRate#2")
        rig.transport.rule = { if (it.upserts.size > 1) FakeTransport.status(413, "payload_too_large") else null }

        assertEquals(RunResult.Success, rig.sync())
        val taken = rig.transport.data.filter { it.upserts.size == 1 }.flatMap { it.upsertIds }
        assertEquals(listOf("a", "b", "c", "d", "e"), taken)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(5, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `409 resends the same content under a fresh id and is never taken as success`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#2")
        var conflicts = 0
        rig.transport.rule = {
            if (!it.isStateOnly && conflicts++ == 0) FakeTransport.status(409, "batch_id_conflict") else null
        }
        assertEquals(RunResult.Success, rig.sync())
        val (refused, resent) = rig.transport.data
        assertNotEquals(refused.batchId, resent.batchId)
        assertEquals(refused.upsertIds, resent.upsertIds)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(2, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `a 409 that persists keeps the position and fails the run`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(409, "batch_id_conflict") }
        assertEquals(RunResult.Failed("batch_id_conflict"), rig.sync())
        assertEquals(2, rig.transport.data.size)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        assertEquals(0, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `429 honours retry-after and then succeeds within the run`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        var first = true
        rig.transport.rule = {
            if (!it.isStateOnly && first) {
                first = false
                FakeTransport.status(429, "rate_limited", retryAfterS = 30)
            } else {
                null
            }
        }
        assertEquals(RunResult.Success, rig.sync())
        assertTrue(rig.sleeps.single() in 30_000..37_500)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
    }

    @Test
    fun `a retry-after longer than a run can wait ends the run without losing the batch`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(429, "backlogged", retryAfterS = 600) }
        assertEquals(RunResult.Failed("backlogged", 600_000), rig.sync())
        assertTrue(rig.sleeps.isEmpty())
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    @Test
    fun `no network is retried and then left for the next run`() = runTest {
        val rig = Rig()
        rig.transport.rule = FakeTransport.offline
        assertEquals(RunResult.Failed("network"), rig.sync())
        assertEquals(SyncEngine.IN_RUN_ATTEMPTS, rig.transport.sent.size)
        assertEquals("network", rig.store.snapshot().global.lastError?.errorCode)
        assertEquals(RunResult.Failed("network"), rig.sync())
        assertEquals(RunResult.Failed("network"), rig.sync())
        assertEquals(3, rig.store.snapshot().global.consecutiveFailures)
        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(0, rig.store.snapshot().global.consecutiveFailures)
    }

    // --- per-type isolation --------------------------------------------------------------------

    @Test
    fun `a revoked type does not block the rest, and recovers when it is granted again`() = runTest {
        val rig = Rig()
        rig.source.failing["HeartRate"] =
            HealthSourceException(HealthSourceException.Kind.PERMISSION, "permission_denied")
        rig.source.changePages["Steps#1"] = page(upserts(record("s")), "Steps#2")

        assertEquals(RunResult.Success, rig.sync())
        assertEquals("permission_denied", rig.type("HeartRate").lastError?.errorCode)
        assertNull(rig.type("HeartRate").token)
        assertEquals("Steps#2", rig.type("Steps").token)

        rig.source.failing.clear()
        rig.now += 1_000
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.type("HeartRate").lastError)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    @Test
    fun `a type the platform keeps failing does not block the rest`() = runTest {
        val rig = Rig()
        rig.source.failing["Steps"] = HealthSourceException(HealthSourceException.Kind.TRANSIENT, "hc_remote")
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("hc_remote", rig.type("Steps").lastError?.errorCode)
        assertNotNull(rig.type("HeartRate").token)
        assertNotNull(rig.type("TotalCaloriesBurned").token)
    }

    @Test
    fun `a run in which every type failed is a failed run, and the server still hears about it`() = runTest {
        val rig = Rig()
        for (type in listOf("Steps", "HeartRate", "TotalCaloriesBurned")) {
            rig.source.failing[type] = HealthSourceException(HealthSourceException.Kind.PERMISSION, "permission_denied")
        }
        assertEquals(RunResult.Failed("permission_denied"), rig.sync())
        assertTrue(rig.transport.sent.single().isStateOnly)
    }

    @Test
    fun `the Health Connect rate limit ends the run, to be resumed`() = runTest {
        val rig = Rig()
        rig.source.failNext.add(HealthSourceException(HealthSourceException.Kind.RATE_LIMITED, "hc_rate_limited"))
        assertEquals(RunResult.Failed("hc_rate_limited"), rig.sync())
        assertEquals(1, rig.source.calls.size)
        assertTrue(rig.transport.sent.single().isStateOnly)
        assertEquals(RunResult.Success, rig.sync())
    }

    @Test
    fun `no type is always read last`() = runTest {
        val rig = Rig()
        rig.sync()
        val first = rig.source.calls.first()
        rig.source.calls.clear()
        rig.sync()
        assertNotEquals(first.substringAfter(':').substringBefore('#'), rig.source.calls.first().substringAfter(':').substringBefore('#'))
    }

    @Test
    fun `a different device starts from nothing`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#next")
        rig.sync()
        assertEquals(1, rig.type("HeartRate").uploaded)

        val otherDevice = "01HYYYYYYYYYYYYYYYYYYYYYYY"
        val other = Pairing(PAIRING.url, otherDevice, "hcd1.$otherDevice.${"c".repeat(43)}")
        assertEquals(RunResult.Success, rig.sync(other))
        assertEquals(otherDevice, rig.store.snapshot().global.deviceId)
        assertEquals(0, rig.type("HeartRate").uploaded)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(otherDevice, rig.transport.sent.last().json.getValue("deviceId").jsonPrimitive.content)
    }

    // --- an expired token ----------------------------------------------------------------------

    @Test
    fun `an expired token is replaced first, then the last 30 days are re-read page by page`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.calls.clear()
        rig.source.changePages["HeartRate#1"] = ChangesPage(emptyList(), "", hasMore = false, expired = true)
        rig.source.add("HeartRate", hr("recent", NOW - day), hr("older", NOW - 2 * day), hr("ancient", NOW - 40 * day))
        rig.source.pageSize = 1

        assertEquals(RunResult.Success, rig.sync())
        val calls = rig.source.calls.filter { "HeartRate" in it }
        val window = "read:HeartRate:${NOW - 30 * day}:${SyncEngine.FAR_FUTURE_MS}"
        assertEquals(
            listOf("changes:HeartRate#1", "token:HeartRate", "$window:-", "$window:1", "changes:HeartRate#2"),
            calls,
        )
        assertEquals(listOf(listOf("older"), listOf("recent")), rig.transport.data.map { it.upsertIds })
        val state = rig.type("HeartRate")
        assertEquals("HeartRate#2", state.token)
        assertNull(state.reread)
        assertEquals(2, state.uploaded)
    }

    @Test
    fun `an interrupted re-read keeps the old token and resumes at the page it stopped on`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = ChangesPage(emptyList(), "", hasMore = false, expired = true)
        rig.source.add("HeartRate", hr("recent", NOW - day), hr("older", NOW - 2 * day))
        rig.source.pageSize = 1
        rig.transport.rule = { if ("recent" in it.upsertIds) FakeTransport.status(500, "oops") else null }

        assertEquals(RunResult.Failed("http_500"), rig.sync())
        val pending = rig.type("HeartRate")
        assertEquals("HeartRate#1", pending.token)
        assertEquals("1", pending.reread?.pageToken)
        assertEquals("HeartRate#2", pending.reread?.newToken)

        rig.transport.rule = { null }
        rig.source.calls.clear()
        rig.now += 60_000
        assertEquals(RunResult.Success, rig.sync())
        val calls = rig.source.calls.filter { "HeartRate" in it }
        assertEquals("read:HeartRate:${NOW - 30 * day}:${SyncEngine.FAR_FUTURE_MS}:1", calls.first())
        assertFalse("token:HeartRate" in calls)
        assertEquals(listOf("recent"), rig.transport.data.last().upsertIds)
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertNull(rig.type("HeartRate").reread)
    }

    // --- platform aggregates -------------------------------------------------------------------

    @Test
    fun `changed hours get the platform total, and an hour left empty is deleted`() = runTest {
        val rig = Rig()
        rig.sync()
        val hour = Hours.floor(NOW)
        val walk = record("walk", start = hour + 10 * 60_000, end = hour + 70 * 60_000)
        rig.source.changePages["Steps#1"] = page(upserts(walk), "Steps#2")
        rig.source.total(AggMetric.STEPS, hour, 500.0, "com.example.wearable", "com.example.phone")

        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf(Triple(AggMetric.STEPS, hour, hour + 2 * Hours.MS)), rig.source.aggregateRequests)
        val batch = rig.transport.data.single()
        assertEquals(listOf("walk", "agg:Steps:$hour"), batch.upsertIds)
        assertEquals(listOf("agg:Steps:${hour + Hours.MS}"), batch.deletes)
        val total = batch.upserts[1].jsonObject
        assertEquals("Agg.Steps", total.getValue("type").jsonPrimitive.content)
        assertEquals("500.0", total.getValue("data").jsonObject.getValue("value").jsonPrimitive.content)
        // The synthetic record is not one of the owner's records.
        assertEquals(1, rig.type("Steps").uploaded)
        assertEquals("Steps#2", rig.type("Steps").token)
    }

    @Test
    fun `total calories and non-cumulative types get no platform aggregate`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["TotalCaloriesBurned#1"] =
            page(upserts(record("t", type = "TotalCaloriesBurned")), "TotalCaloriesBurned#2")
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.sync()
        assertTrue(rig.source.aggregateRequests.isEmpty())
        assertEquals(listOf(listOf("a"), listOf("t")), rig.transport.data.map { it.upsertIds }.sortedBy { it.first() })
    }

    @Test
    fun `a deletion recomputes every hour the token could cover`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["Steps#1"] = page(listOf(HcChange.Delete("gone")), "Steps#2")
        val kept = Hours.floor(NOW - 3 * day)
        rig.source.total(AggMetric.STEPS, kept, 10.0, "com.example.phone")

        rig.sync()
        val request = rig.source.aggregateRequests.single()
        assertEquals(Hours.floor(NOW - 30 * day), request.second)
        assertEquals(Hours.floor(NOW) + 2 * Hours.MS, request.third)
        val batch = rig.transport.data.single()
        assertEquals(listOf("agg:Steps:$kept"), batch.upsertIds)
        assertEquals("gone", batch.deletes.first())
        assertEquals(((request.third - request.second) / Hours.MS).toInt(), batch.deletes.size)
    }

    @Test
    fun `an aggregate the platform will not compute does not hold the records back`() = runTest {
        val rig = Rig(types = listOf("Steps"))
        rig.sync()
        rig.source.changePages["Steps#1"] = page(upserts(record("walk")), "Steps#2")
        rig.source.aggregateFailure = HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")

        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("walk"), rig.transport.data.single().upsertIds)
        assertEquals("Steps#2", rig.type("Steps").token)
        assertEquals("aggregate_failed", rig.type("Steps").lastError?.errorCode)
    }

    // --- one record the server cannot take ------------------------------------------------------

    @Test
    fun `a record over the hard caps even alone goes up as a stub, and the type moves on`() = runTest {
        val rig = Rig(limits = BatchLimits(hardGzipBytes = 1_000_000, hardRawBytes = 9_000))
        rig.sync()
        val padding = "x".repeat(12_000)
        val huge = record("huge", type = "HeartRate", start = NOW - 5_000, padding = padding)
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), huge, hr("b")), "HeartRate#2")

        assertEquals(RunResult.Success, rig.sync())
        val sent = rig.transport.data.flatMap { batch -> batch.upserts.map { it.jsonObject } }
        assertEquals(listOf("a", "huge", "b"), sent.map { it.getValue("id").jsonPrimitive.content })
        val stub = sent[1]
        // The envelope is the record's own; only the data is replaced.
        for (key in listOf("id", "type", "origin", "lastModified", "start", "end")) {
            assertEquals(key, huge.getValue(key), stub.getValue(key))
        }
        val data = stub.getValue("data").jsonObject
        assertEquals(setOf("oversize", "bytes"), data.keys)
        assertEquals("true", data.getValue("oversize").jsonPrimitive.content)
        assertEquals(huge.toString().toByteArray().size.toLong(), data.getValue("bytes").jsonPrimitive.long)

        val state = rig.type("HeartRate")
        assertEquals("HeartRate#2", state.token)
        assertEquals(1, state.stubbed)
        assertEquals(2, state.uploaded)
        assertEquals("record_oversize_stubbed", state.lastError?.errorCode)
        assertEquals(0, state.backlog)
    }

    @Test
    fun `413 for a single record sends its stub instead`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { batch ->
            if (batch.data.any { "oversize" !in it }) FakeTransport.status(413, "payload_too_large") else null
        }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(listOf("a", "a"), rig.transport.data.flatMap { it.upsertIds })
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(1, rig.type("HeartRate").stubbed)
        assertEquals(0, rig.type("HeartRate").uploaded)
    }

    @Test
    fun `when even the stub is refused as too large the type stops and keeps its position`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(413, "payload_too_large") }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals(2, rig.transport.data.size)
        assertEquals("payload_too_large", rig.type("HeartRate").lastError?.errorCode)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        assertEquals(1, rig.type("HeartRate").backlog)
    }

    @Test
    fun `only records the server accepted count as uploaded or move the first and last times`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] =
            page(upserts(hr("old", NOW - 9 * day), hr("mid", NOW - 5 * day), hr("new", NOW - day)), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.ok(it, rejectedIds = listOf("old")) }
        assertEquals(RunResult.Success, rig.sync())
        val state = rig.type("HeartRate")
        assertEquals("HeartRate#2", state.token)
        assertEquals(2, state.uploaded)
        assertEquals(1, state.rejected)
        assertEquals(NOW - 5 * day, state.firstMs)
        assertEquals(NOW - day + 60_000, state.lastMs)
        assertEquals("records_rejected", state.lastError?.errorCode)
    }

    @Test
    fun `when the rejected list is cut short the count is exact and the times are left alone`() = runTest {
        val rig = Rig()
        rig.sync()
        val many = (0 until 300).map { hr("r$it", NOW - it * 1_000L) }
        rig.source.changePages["HeartRate#1"] = page(many.map { HcChange.Upsert(it) }, "HeartRate#2")
        rig.transport.rule = {
            if (it.isStateOnly) null else FakeTransport.ok(it, rejectedIds = (0 until 100).map { n -> "r$n" }, rejectedTotal = 150)
        }
        assertEquals(RunResult.Success, rig.sync())
        val state = rig.type("HeartRate")
        assertEquals(150, state.uploaded)
        assertEquals(150, state.rejected)
        assertNull(state.firstMs)
        assertNull(state.lastMs)
    }

    // --- runs that read nothing -----------------------------------------------------------------

    @Test
    fun `paired with nothing granted is a failed run that still reports its state`() = runTest {
        val rig = Rig()
        rig.access = access(denied = listOf("Steps", "HeartRate", "TotalCaloriesBurned"))
        assertEquals(RunResult.Failed("no_permissions", retryable = false), rig.sync())
        assertTrue(rig.source.calls.isEmpty())
        assertTrue(rig.transport.sent.single().isStateOnly)
        val global = rig.store.snapshot().global
        assertEquals(1, global.consecutiveFailures)
        assertEquals("no_permissions", global.lastError?.errorCode)
        assertNull(global.lastSyncMs)
        rig.sync()
        rig.sync()
        assertEquals(3, rig.store.snapshot().global.consecutiveFailures)
    }

    @Test
    fun `Health Connect being unavailable is not the same as nothing being granted`() = runTest {
        val rig = Rig()
        rig.access = HealthAccess.none(HealthConnectStatus.UPDATE_REQUIRED)
        assertEquals(RunResult.Failed("hc_unavailable", retryable = false), rig.sync())
        assertNull(rig.store.snapshot().global.lastSyncMs)
    }

    @Test
    fun `a run whose grants could not be read fails, retryably, and sends no state`() = runTest {
        val rig = Rig()
        assertEquals(RunResult.Failed("hc_unavailable"), rig.engine.failRun("hc_unavailable"))
        assertTrue(rig.transport.sent.isEmpty())
        assertTrue(rig.source.calls.isEmpty())
        val global = rig.store.snapshot().global
        assertEquals(1, global.consecutiveFailures)
        assertEquals("hc_unavailable", global.lastError?.errorCode)
        assertNull(global.lastSyncMs)
    }

    @Test
    fun `a background run without the background-read grant reads nothing and moves nothing`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        // Mid re-read as well: the cursor of a resumed re-read must not move either.
        rig.store.updateType("Steps") { it.copy(reread = RereadState("Steps#9", NOW, NOW - 30 * day, SyncEngine.FAR_FUTURE_MS, "7")) }
        rig.access = access("Steps", "HeartRate", "TotalCaloriesBurned", background = Grant.DENIED)
        rig.foreground = false
        rig.source.calls.clear()
        rig.transport.sent.clear()
        val before = rig.store.snapshot().types

        assertEquals(RunResult.Skipped("background_read_missing", notify = true), rig.sync())
        assertTrue(rig.source.calls.isEmpty())
        assertEquals(before, rig.store.snapshot().types)
        // The server still hears from the phone, and learns why there is no data.
        val state = rig.transport.sent.single()
        assertTrue(state.isStateOnly)
        assertEquals("false", state.json.getValue("syncState").jsonObject.getValue("backgroundRead").jsonPrimitive.content)
        val global = rig.store.snapshot().global
        assertEquals(0, global.consecutiveFailures)
        assertEquals("background_read_missing", global.skipReason?.errorCode)
        // A skip is not an error and does not pose as one.
        assertNull(global.lastError)
        assertEquals("background_read_missing", skipCode(state))

        // The owner is told once.
        assertEquals(RunResult.Skipped("background_read_missing", notify = false), rig.sync())

        // In the foreground the same phone syncs, and a later skip is announced afresh.
        rig.foreground = true
        rig.now += 1_000
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        rig.foreground = false
        assertEquals(RunResult.Skipped("background_read_missing", notify = true), rig.sync())
    }

    @Test
    fun `with the background-read grant a background run syncs as usual`() = runTest {
        val rig = Rig()
        rig.foreground = false
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    @Test
    fun `an error of a type that is no longer granted is cleared and not reported`() = runTest {
        val rig = Rig()
        rig.source.failing["HeartRate"] = HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
        rig.sync()
        assertEquals("hc_invalid_argument", rig.type("HeartRate").lastError?.errorCode)

        rig.access = access("Steps", "TotalCaloriesBurned", denied = listOf("HeartRate"))
        // Not reported even before the next run has cleared it.
        assertNull(SyncStateReport.lastError(listOf("Steps", "HeartRate", "TotalCaloriesBurned"), rig.access, rig.store.snapshot()))
        rig.now += 1_000
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.type("HeartRate").lastError)
        assertFalse("lastError" in rig.transport.sent.last().json.getValue("syncState").jsonObject)
    }

    // --- a session that is out of date ----------------------------------------------------------

    @Test
    fun `a run handed a pairing that has since been replaced touches nothing`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        val before = rig.store.snapshot()
        val posts = rig.transport.sent.size
        val reads = rig.source.calls.size

        // The owner pairs with another device while a run built for the old one waits its turn.
        val otherDevice = "01HYYYYYYYYYYYYYYYYYYYYYYY"
        val stale = rig.session(PAIRING)
        rig.storedPairing = Pairing(PAIRING.url, otherDevice, "hcd1.$otherDevice.${"c".repeat(43)}")

        assertEquals(RunResult.Failed("pairing_changed", retryable = false), rig.engine.syncOnce(stale))
        assertEquals(BackfillStep.Backoff("pairing_changed"), rig.engine.backfillStep(stale, BackfillRun()))
        rig.engine.requestBackfill(stale)
        assertEquals(before, rig.store.snapshot())
        assertEquals(posts, rig.transport.sent.size)
        assertEquals(reads, rig.source.calls.size)

        // Unpaired counts as changed too.
        rig.storedPairing = null
        assertEquals(RunResult.Failed("pairing_changed", retryable = false), rig.engine.syncOnce(stale))
        assertEquals(before, rig.store.snapshot())
    }

    // --- found on a device ------------------------------------------------------------------------

    @Test
    fun `pairing again with the very same token lifts a refusal`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }
        assertTrue(rig.sync() is RunResult.PairingRejected)
        val posts = rig.transport.sent.size
        assertTrue(rig.sync() is RunResult.PairingRejected)
        assertEquals(posts, rig.transport.sent.size)

        // Unpair, then pair with the same payload: two more acts of pairing, the same token.
        rig.engine.pairingCleared()
        assertNull(rig.store.snapshot().global.rejectedTokenTag)
        assertNull(rig.store.snapshot().global.lastError)
        rig.pairingGeneration += 2
        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertTrue(rig.transport.sent.size > posts)
    }

    @Test
    fun `pairing again lifts the refusal even without an unpair in between`() = runTest {
        val rig = Rig()
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }
        assertTrue(rig.sync() is RunResult.PairingRejected)
        rig.pairingGeneration += 1
        // Still refused by the server: one request finds that out, and the latch is set again.
        val posts = rig.transport.sent.size
        assertTrue(rig.sync() is RunResult.PairingRejected)
        assertEquals(posts + 1, rig.transport.sent.size)
        assertTrue(rig.sync() is RunResult.PairingRejected)
        assertEquals(posts + 1, rig.transport.sent.size)
    }

    @Test
    fun `unpairing keeps positions and other errors, and only drops the refusal`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.transport.rule = FakeTransport.offline
        rig.sync()
        rig.engine.pairingCleared()
        assertEquals("network", rig.store.snapshot().global.lastError?.errorCode)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    private fun skipCode(batch: SentBatch): String? =
        batch.json.getValue("syncState").jsonObject["skipReason"]?.jsonObject?.getValue("errorCode")?.jsonPrimitive?.content

    private fun reportedError(batch: SentBatch): String? =
        batch.json.getValue("syncState").jsonObject["lastError"]?.jsonObject?.getValue("errorCode")?.jsonPrimitive?.content

    @Test
    fun `the first sync after a refusal no longer reports unauthorized`() = runTest {
        val rig = Rig()
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }
        rig.sync()
        rig.transport.rule = { null }
        rig.transport.sent.clear()
        val repaired = PAIRING.copy(token = "hcd1.$DEVICE.${"b".repeat(43)}")
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        assertEquals(RunResult.Success, rig.sync(repaired))
        assertTrue(rig.transport.sent.size >= 2)
        assertTrue(rig.transport.sent.all { reportedError(it) == null })
    }

    @Test
    fun `the closing report describes this run, not the one before`() = runTest {
        val rig = Rig()
        rig.transport.rule = FakeTransport.offline
        assertEquals(RunResult.Failed("network"), rig.sync())
        rig.transport.rule = { null }
        rig.transport.sent.clear()
        assertEquals(RunResult.Success, rig.sync())
        assertNull(reportedError(rig.transport.sent.last()))

        // And a failure that still lets the phone report is in that very report.
        rig.access = access(denied = listOf("Steps", "HeartRate", "TotalCaloriesBurned"))
        rig.sync()
        assertEquals("no_permissions", reportedError(rig.transport.sent.last()))
    }

    @Test
    fun `a skipped run tells the server why in the same report`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.access = access("Steps", "HeartRate", "TotalCaloriesBurned", background = Grant.DENIED)
        rig.foreground = false
        rig.transport.sent.clear()
        rig.sync()
        assertEquals("background_read_missing", skipCode(rig.transport.sent.single()))
        assertNull(reportedError(rig.transport.sent.single()))
    }

    // --- 400: nothing is ever skipped --------------------------------------------------------------

    @Test
    fun `a 400 advances nothing and skips nothing, and the next run delivers`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b"), hr("c")), "HeartRate#2")
        rig.source.changePages["TotalCaloriesBurned#1"] =
            page(upserts(record("t", type = "TotalCaloriesBurned")), "TotalCaloriesBurned#2")
        // Not the server's own verdict on a record (it never gives one as a 400): something on
        // the way mangled this one request.
        var mangled = 0
        rig.transport.rule = { if ("a" in it.upsertIds && mangled++ == 0) FakeTransport.status(400, "bad_request") else null }

        assertEquals(RunResult.Success, rig.sync())
        val failed = rig.type("HeartRate")
        assertEquals("HeartRate#1", failed.token)
        assertEquals(0, failed.uploaded)
        assertEquals(0, failed.rejected)
        assertEquals(3, failed.backlog)
        assertEquals("bad_request", failed.lastError?.errorCode)
        // The batch was not split: it went once, whole, then one empty probe.
        assertEquals(listOf(listOf("a", "b", "c")), rig.transport.data.filter { "a" in it.upsertIds }.map { it.upsertIds })
        // The other type is not held up.
        assertEquals("TotalCaloriesBurned#2", rig.type("TotalCaloriesBurned").token)

        rig.now += 1_000
        assertEquals(RunResult.Success, rig.sync())
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
        assertEquals(3, rig.type("HeartRate").uploaded)
        assertNull(rig.type("HeartRate").lastError)
    }

    @Test
    fun `a 400 for every request stops the run and still skips nothing`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#2")
        rig.transport.rule = { FakeTransport.status(400, "bad_request") }
        assertEquals(RunResult.Failed("bad_request"), rig.sync())
        val state = rig.type("HeartRate")
        assertEquals("HeartRate#1", state.token)
        assertEquals(0, state.rejected)
        assertEquals(0, state.uploaded)
        assertEquals("bad_request", rig.store.snapshot().global.lastError?.errorCode)
        // One data batch, one probe; no halves.
        assertEquals(1, rig.transport.data.size)
    }

    @Test
    fun `a probe that cannot reach the server makes the run retryable, not a bad request`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = {
            if (it.isStateOnly) FakeTransport.status(503, "down", retryAfterS = 5) else FakeTransport.status(400, "bad_request")
        }
        val result = rig.sync()
        assertEquals(RunResult.Failed("http_503", 5_000), result)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        // Not blamed on the type as a bad request.
        assertNull(rig.type("HeartRate").lastError)
        assertEquals("http_503", rig.store.snapshot().global.lastError?.errorCode)
    }

    @Test
    fun `a probe that is refused with 401 latches the pairing`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.transport.rule = {
            if (it.isStateOnly) FakeTransport.status(401, "unauthorized") else FakeTransport.status(400, "bad_request")
        }
        assertEquals(RunResult.PairingRejected(notify = true), rig.sync())
        assertEquals("unauthorized", rig.store.snapshot().global.lastError?.errorCode)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        val posts = rig.transport.sent.size
        assertEquals(RunResult.PairingRejected(notify = false), rig.sync())
        assertEquals(posts, rig.transport.sent.size)
    }

    @Test
    fun `415 advances nothing either`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.status(415, "unsupported_media_type") }
        rig.sync()
        assertEquals(1, rig.transport.data.size)
        assertEquals("unsupported_media_type", rig.type("HeartRate").lastError?.errorCode)
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
    }

    // --- second review ------------------------------------------------------------------------------

    @Test
    fun `the owner is told of a refused token once, not on every run it blocks`() = runTest {
        val rig = Rig()
        rig.transport.rule = { FakeTransport.status(401, "unauthorized") }
        assertEquals(RunResult.PairingRejected(notify = true), rig.sync())
        assertEquals(RunResult.PairingRejected(notify = false), rig.sync())
        assertEquals(RunResult.PairingRejected(notify = false), rig.sync())
    }

    @Test
    fun `nothing granted is reported as that even in the background`() = runTest {
        val rig = Rig()
        rig.access = access(denied = listOf("Steps", "HeartRate", "TotalCaloriesBurned"), background = Grant.DENIED)
        rig.foreground = false
        assertEquals(RunResult.Failed("no_permissions", retryable = false), rig.sync())
        assertEquals("no_permissions", reportedError(rig.transport.sent.single()))
        assertNull(rig.store.snapshot().global.skipReason)
    }

    @Test
    fun `a skip does not hide a real error behind it`() = runTest {
        val rig = Rig()
        rig.source.failing["HeartRate"] = HealthSourceException(HealthSourceException.Kind.INVALID, "hc_invalid_argument")
        rig.sync()
        rig.access = access("Steps", "HeartRate", "TotalCaloriesBurned", background = Grant.DENIED)
        rig.foreground = false
        rig.now += 60_000
        rig.sync()
        rig.now += 60_000
        rig.sync()
        val types = listOf("Steps", "HeartRate", "TotalCaloriesBurned")
        assertEquals("hc_invalid_argument", SyncStateReport.lastError(types, rig.access, rig.store.snapshot())?.errorCode)
        assertEquals("hc_invalid_argument", reportedError(rig.transport.sent.last()))
        assertEquals("background_read_missing", skipCode(rig.transport.sent.last()))

        // A run that does read ends the skip.
        rig.foreground = true
        rig.source.failing.clear()
        rig.now += 60_000
        assertEquals(RunResult.Success, rig.sync())
        assertNull(rig.store.snapshot().global.skipReason)
        assertNull(skipCode(rig.transport.sent.last()))
    }

    @Test
    fun `a fresh token that is itself reported expired is recovered once per run, not for ever`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.add("HeartRate", hr("recent", NOW - day))
        // Every token this type is ever given is reported expired.
        rig.source.alwaysExpired.add("HeartRate")
        rig.source.calls.clear()

        assertEquals(RunResult.Success, rig.sync())
        assertEquals("changes_token_unstable", rig.type("HeartRate").lastError?.errorCode)
        // One re-read of the window, then stop.
        assertEquals(1, rig.source.calls.count { it.startsWith("read:HeartRate") })
        assertEquals(1, rig.source.calls.count { it == "token:HeartRate" })
        assertEquals(1, rig.transport.data.size)
        // The other types were not held up by it.
        assertNotNull(rig.type("Steps").token)
    }

    @Test
    fun `a re-read whose page token keeps being refused restarts once and then gives up for the run`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = ChangesPage(emptyList(), "", hasMore = false, expired = true)
        rig.source.add("HeartRate", hr("a", NOW - 2 * day), hr("b", NOW - day))
        rig.source.pageSize = 1
        rig.source.refusePageTokens.add("HeartRate")
        rig.source.calls.clear()

        assertEquals(RunResult.Success, rig.sync())
        assertEquals("page_token_invalid", rig.type("HeartRate").lastError?.errorCode)
        val reads = rig.source.calls.filter { it.startsWith("read:HeartRate") }
        // First page, refused second page, first page again, refused again: four reads, no more.
        assertEquals(4, reads.size)
        // The old token is still the type's token: nothing was skipped.
        assertEquals("HeartRate#1", rig.type("HeartRate").token)
        assertNotNull(rig.type("HeartRate").reread)
    }

    @Test
    fun `unpairing during a run stops it before the next request`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        rig.source.changePages["Steps#1"] = page(upserts(record("s")), "Steps#2")
        rig.source.changePages["TotalCaloriesBurned#1"] =
            page(upserts(record("t", type = "TotalCaloriesBurned")), "TotalCaloriesBurned#2")
        // The owner unpairs while the first data batch of the run is in flight.
        var data = 0
        rig.transport.rule = {
            if (!it.isStateOnly && ++data == 1) rig.storedPairing = null
            null
        }
        val before = rig.store.snapshot().global
        val stale = rig.session(PAIRING)
        assertEquals(RunResult.Failed("pairing_changed", retryable = false), rig.engine.syncOnce(stale))
        // One request went out; the other two types and the closing report did not.
        assertEquals(1, data)
        assertEquals(1, rig.transport.data.size)
        assertTrue(rig.transport.sent.last().upserts.isNotEmpty())
        // No failure is recorded against a pairing that is gone.
        assertEquals(before.consecutiveFailures, rig.store.snapshot().global.consecutiveFailures)
        assertNull(rig.store.snapshot().global.lastError)
    }

    @Test
    fun `a 401 for a pairing that has just been replaced is not held against the new one`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a")), "HeartRate#2")
        val repaired = PAIRING.copy(token = "hcd1.$DEVICE.${"b".repeat(43)}")
        // The owner rotates the token while a request with the old one is in flight.
        rig.transport.rule = {
            rig.storedPairing = repaired
            FakeTransport.status(401, "unauthorized")
        }
        assertEquals(RunResult.Failed("pairing_changed", retryable = false), rig.engine.syncOnce(rig.session(PAIRING)))
        val global = rig.store.snapshot().global
        assertNull(global.rejectedTokenTag)
        assertNull(global.lastError)

        rig.transport.rule = { null }
        assertEquals(RunResult.Success, rig.sync(repaired))
        assertEquals("HeartRate#2", rig.type("HeartRate").token)
    }

    @Test
    fun `a record the server rejects inside a 200 is counted for good and reported per type`() = runTest {
        val rig = Rig()
        rig.sync()
        rig.source.changePages["HeartRate#1"] = page(upserts(hr("a"), hr("b")), "HeartRate#2")
        rig.transport.rule = { if (it.isStateOnly) null else FakeTransport.ok(it, rejectedIds = listOf("b")) }
        rig.sync()
        // Two clean runs later the error code has gone; the count has not.
        rig.transport.rule = { null }
        rig.now += 1_000
        rig.sync()
        rig.now += 1_000
        rig.sync()
        assertNull(rig.type("HeartRate").lastError)
        assertEquals(1, rig.type("HeartRate").rejected)
        val types = listOf("Steps", "HeartRate", "TotalCaloriesBurned")
        val ui = SyncUiStates.build(types, PairingState.NotPaired, false, rig.store.snapshot(), SyncUiStates.Live(access = rig.access))
        assertEquals(1, ui.types.single { it.type == "HeartRate" }.rejected)
        val reported = rig.transport.sent.last().json.getValue("syncState").jsonObject.getValue("types").jsonArray
            .map { it.jsonObject }.single { it.getValue("type").jsonPrimitive.content == "HeartRate" }
        assertEquals(1L, reported.getValue("rejected").jsonPrimitive.long)
        assertEquals(0L, reported.getValue("stubbed").jsonPrimitive.long)
    }
}
