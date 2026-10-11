package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import dev.maxhogan.healthy.companion.hc.RecordTypes
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncStateReportTest {
    private val types = listOf("Steps", "HeartRate", "SkinTemperature")

    private fun typeEntry(report: JsonObject, name: String): JsonObject =
        report.getValue("types").jsonArray.map { it.jsonObject }
            .single { it.getValue("type").jsonPrimitive.content == name }

    private val granted = HealthAccess(
        status = HealthConnectStatus.AVAILABLE,
        types = mapOf("Steps" to Grant.GRANTED, "HeartRate" to Grant.DENIED, "SkinTemperature" to Grant.UNAVAILABLE),
        backgroundRead = Grant.GRANTED,
        historyRead = Grant.UNAVAILABLE,
        exerciseRoutes = Grant.DENIED,
    )

    @Test
    fun `every known type is reported with its permission, whether or not it has data`() {
        val report = SyncStateReport.build(types, granted, SyncSnapshot(), FACTS, NOW)
        assertEquals(types, report.getValue("types").jsonArray.map { it.jsonObject.getValue("type").jsonPrimitive.content })
        // The route permission is a grant, not a record type: a field of its own, never a row.
        assertEquals("denied", report.getValue("exerciseRoutes").jsonPrimitive.content)
        assertEquals("granted", typeEntry(report, "Steps").getValue("permission").jsonPrimitive.content)
        assertEquals("denied", typeEntry(report, "HeartRate").getValue("permission").jsonPrimitive.content)
        assertEquals("unavailable", typeEntry(report, "SkinTemperature").getValue("permission").jsonPrimitive.content)
        val steps = typeEntry(report, "Steps")
        assertEquals(JsonNull, steps.getValue("tokenAgeS"))
        assertEquals(0L, steps.getValue("backlog").jsonPrimitive.long)
        assertFalse(steps.getValue("backfill").jsonObject.getValue("complete").jsonPrimitive.boolean)
    }

    @Test
    fun `the whole registry fits the report`() {
        val all = RecordTypes.ALL.map(RecordTypes::typeName)
        val report = SyncStateReport.build(all, HealthAccess.none(HealthConnectStatus.UNAVAILABLE), SyncSnapshot(), FACTS, NOW)
        assertEquals(all.size, report.getValue("types").jsonArray.size)
        assertEquals("unavailable", report.getValue("exerciseRoutes").jsonPrimitive.content)
        assertTrue(report.getValue("types").jsonArray.size <= 500)
        assertTrue(report.getValue("types").jsonArray.all { it.jsonObject.getValue("permission").jsonPrimitive.content == "unavailable" })
        assertTrue(all.all { Regex("^[A-Za-z][A-Za-z0-9_.:-]{0,63}$").matches(it) })
    }

    @Test
    fun `token age, backlog and backfill come from the type's state`() {
        val snapshot = SyncSnapshot(
            GlobalState(backfillRequested = true),
            mapOf(
                "Steps" to TypeState(
                    token = "t",
                    tokenCreatedMs = NOW - 90_500,
                    backlog = 7,
                    backfill = BackfillState(started = true, complete = true, oldestDoneMs = 1_700_000_000_000),
                ),
            ),
        )
        val report = SyncStateReport.build(types, granted, snapshot, FACTS, NOW)
        val steps = typeEntry(report, "Steps")
        assertEquals(90L, steps.getValue("tokenAgeS").jsonPrimitive.long)
        assertEquals(7L, steps.getValue("backlog").jsonPrimitive.long)
        val backfill = steps.getValue("backfill").jsonObject
        assertTrue(backfill.getValue("complete").jsonPrimitive.boolean)
        assertEquals(1_700_000_000_000, backfill.getValue("oldestDoneMs").jsonPrimitive.long)
        // Steps is the only granted type and it is done.
        assertTrue(report.getValue("backfillComplete").jsonPrimitive.boolean)
    }

    @Test
    fun `device facts and grants are reported as the server expects`() {
        val report = SyncStateReport.build(types, granted, SyncSnapshot(), FACTS, NOW)
        assertTrue(report.getValue("backgroundRead").jsonPrimitive.boolean)
        // Unavailable on this phone is not "granted".
        assertFalse(report.getValue("historyRead").jsonPrimitive.boolean)
        assertTrue(report.getValue("batteryExempt").jsonPrimitive.boolean)
        assertTrue(report.getValue("hibernationExempt").jsonPrimitive.boolean)
        val restricted = SyncStateReport.build(types, granted, SyncSnapshot(), FACTS.copy(hibernationExempt = false), NOW)
        assertFalse(restricted.getValue("hibernationExempt").jsonPrimitive.boolean)
        assertEquals("2026.01.01", report.getValue("hcProviderVersion").jsonPrimitive.content)
        assertEquals(37, report.getValue("androidSdk").jsonPrimitive.int)
        assertFalse(report.getValue("backfillComplete").jsonPrimitive.boolean)
        assertFalse("lastError" in report)
    }

    @Test
    fun `an unreadable provider version is left out and a long one is cut to the server's limit`() {
        val none = SyncStateReport.build(types, granted, SyncSnapshot(), FACTS.copy(hcProviderVersion = null), NOW)
        assertFalse("hcProviderVersion" in none)
        val long = SyncStateReport.build(types, granted, SyncSnapshot(), FACTS.copy(hcProviderVersion = "9".repeat(200)), NOW)
        assertEquals(64, long.getValue("hcProviderVersion").jsonPrimitive.content.length)
    }

    @Test
    fun `the newest error wins, whether it stopped a run or one type`() {
        val snapshot = SyncSnapshot(
            GlobalState(lastError = StoredError("network", NOW - 10)),
            mapOf(
                "Steps" to TypeState(lastError = StoredError("bad_request", NOW - 5)),
                "HeartRate" to TypeState(lastError = StoredError("permission_denied", NOW - 50)),
            ),
        )
        val error = SyncStateReport.build(types, granted, snapshot, FACTS, NOW).getValue("lastError").jsonObject
        assertEquals("bad_request", error.getValue("errorCode").jsonPrimitive.content)
        assertEquals(NOW - 5, error.getValue("at").jsonPrimitive.long)
    }

    @Test
    fun `backfill is not complete while a granted type is unfinished, or before it was asked for`() {
        val done = TypeState(backfill = BackfillState(started = true, complete = true))
        val both = granted.copy(types = mapOf("Steps" to Grant.GRANTED, "HeartRate" to Grant.GRANTED))
        val requested = GlobalState(backfillRequested = true)
        assertFalse(SyncStateReport.backfillComplete(types, both, SyncSnapshot(requested, mapOf("Steps" to done))))
        assertTrue(SyncStateReport.backfillComplete(types, both, SyncSnapshot(requested, mapOf("Steps" to done, "HeartRate" to done))))
        assertFalse(SyncStateReport.backfillComplete(types, both, SyncSnapshot(GlobalState(), mapOf("Steps" to done, "HeartRate" to done))))
    }

    @Test
    fun `the status screen always has a row per type`() {
        val snapshot = SyncSnapshot(
            GlobalState(lastSyncMs = NOW, consecutiveFailures = 2, lastError = StoredError("network", NOW)),
            mapOf("Steps" to TypeState(uploaded = 12, firstMs = 5, lastMs = 9, backlog = 3)),
        )
        val state = SyncUiStates.build(
            types,
            PairingState.Paired(PAIRING.url, DEVICE),
            wifiOnly = true,
            snapshot = snapshot,
            live = SyncUiStates.Live(access = granted, batteryExempt = true, syncing = true),
        )
        assertEquals(types, state.types.map { it.type })
        assertEquals(TypeRow("Steps", Grant.GRANTED, firstMs = 5, lastMs = 9, uploaded = 12), state.types.first())
        assertEquals(Grant.UNAVAILABLE, state.types.last().permission)
        assertEquals(SyncActivity.SYNCING, state.activity)
        assertEquals(3L, state.backlog)
        assertEquals(SyncError("network", NOW, consecutiveFailures = 2), state.lastError)
        assertEquals(BackfillPhase.NOT_STARTED, state.backfill.phase)
        assertTrue(state.wifiOnly)
        assertTrue(state.batteryExempt)
        assertEquals(NOW, state.lastSyncMs)
    }

    @Test
    fun `an error of a type that is not granted is not the phone's last error`() {
        val snapshot = SyncSnapshot(
            GlobalState(lastError = StoredError("network", NOW - 10)),
            mapOf("HeartRate" to TypeState(lastError = StoredError("permission_denied", NOW - 1))),
        )
        // HeartRate is denied in `granted`: its newer error describes nothing still attempted.
        assertEquals(StoredError("network", NOW - 10), SyncStateReport.lastError(types, granted, snapshot))
        val state = SyncUiStates.build(types, PairingState.NotPaired, false, snapshot, SyncUiStates.Live(access = granted))
        assertEquals("network", state.lastError?.errorCode)
    }

    @Test
    fun `a backfill without history stops being complete when history is granted`() {
        val partial = TypeState(backfill = BackfillState(started = true, complete = true, fullHistory = false))
        val full = TypeState(backfill = BackfillState(started = true, complete = true, fullHistory = true))
        val requested = GlobalState(backfillRequested = true)
        val withHistory = granted.copy(historyRead = Grant.GRANTED)
        val withoutHistory = granted.copy(historyRead = Grant.DENIED)
        assertTrue(SyncStateReport.backfillComplete(types, withoutHistory, SyncSnapshot(requested, mapOf("Steps" to partial))))
        assertFalse(SyncStateReport.backfillComplete(types, withHistory, SyncSnapshot(requested, mapOf("Steps" to partial))))
        assertTrue(SyncStateReport.backfillComplete(types, withHistory, SyncSnapshot(requested, mapOf("Steps" to full))))
        val report = SyncStateReport.build(types, withHistory, SyncSnapshot(requested, mapOf("Steps" to partial)), FACTS, NOW)
        assertFalse(report.getValue("backfillComplete").jsonPrimitive.boolean)
    }

    @Test
    fun `the status screen shows the hibernation exemption`() {
        val live = SyncUiStates.Live(access = granted, hibernationExempt = true)
        assertTrue(SyncUiStates.build(types, PairingState.NotPaired, false, SyncSnapshot(), live).hibernationExempt)
        assertFalse(SyncUiStates.build(types, PairingState.NotPaired, false, SyncSnapshot(), SyncUiStates.Live()).hibernationExempt)
    }

    @Test
    fun `a retry time is reported only for the error that is being waited out`() {
        val waiting = SyncSnapshot(GlobalState(lastError = StoredError("network", NOW - 10), retryAtMs = NOW + 5_000))
        val error = SyncStateReport.build(types, granted, waiting, FACTS, NOW).getValue("lastError").jsonObject
        assertEquals(NOW + 5_000, error.getValue("retryAt").jsonPrimitive.long)

        // A newer error of a granted type is the last error; the retry time is not its.
        val other = waiting.copy(types = mapOf("Steps" to TypeState(lastError = StoredError("bad_request", NOW - 1))))
        val newest = SyncStateReport.build(types, granted, other, FACTS, NOW).getValue("lastError").jsonObject
        assertEquals("bad_request", newest.getValue("errorCode").jsonPrimitive.content)
        assertFalse("retryAt" in newest)

        val none = SyncSnapshot(GlobalState(lastError = StoredError("network", NOW - 10)))
        assertFalse("retryAt" in SyncStateReport.build(types, granted, none, FACTS, NOW).getValue("lastError").jsonObject)
    }

    @Test
    fun `every code the app can show has a sentence, and the code is never the sentence`() {
        val codes = listOf(
            "unauthorized", "background_read_missing", "no_permissions", "backfill_not_started", "hc_unavailable",
            "hc_rate_limited", "network", "bad_request", "payload_too_large", "record_oversize_stubbed",
            "records_rejected", "batch_id_conflict", "pairing_changed", "aggregate_failed", "permission_denied",
            "changes_token_unstable", "page_token_invalid", "record_too_large", "unsupported_media_type",
            "rate_limited", "backlogged", "bad_response", "internal_error", "hc_remote", "hc_io", "hc_error",
            "hc_invalid_argument", "sync_failed", "backfill_state_invalid", "unknown_record_type",
        )
        assertTrue(ErrorMessages.known.containsAll(codes))
        for (code in ErrorMessages.known) {
            val text = ErrorMessages.describe(code)
            assertTrue(code, text.length > 20 && text.endsWith(".") && !text.contains(code))
        }
        assertTrue(ErrorMessages.describe("unauthorized").startsWith("This phone's pairing was rejected. Pair again from the Phone page"))
        // Statuses, by what the owner can do about them.
        assertTrue(ErrorMessages.describe("http_503").contains("HTTP 503"))
        assertTrue(ErrorMessages.describe("http_302").contains("redirected"))
        assertTrue(ErrorMessages.describe("http_403").contains("in front of the server"))
        assertTrue(ErrorMessages.describe("http_418").contains("HTTP 418"))
        // A code nobody wrote a sentence for still gets one.
        assertTrue(ErrorMessages.describe("something_new").isNotEmpty())
    }

    @Test
    fun `rejected and stubbed counts are reported per type and shown in its row`() {
        val snapshot = SyncSnapshot(types = mapOf("Steps" to TypeState(uploaded = 10, rejected = 2, stubbed = 1)))
        val steps = typeEntry(SyncStateReport.build(types, granted, snapshot, FACTS, NOW), "Steps")
        assertEquals(2L, steps.getValue("rejected").jsonPrimitive.long)
        assertEquals(1L, steps.getValue("stubbed").jsonPrimitive.long)
        val row = SyncUiStates.build(types, PairingState.NotPaired, false, snapshot, SyncUiStates.Live(access = granted)).types.first()
        assertEquals(TypeRow("Steps", Grant.GRANTED, uploaded = 10, rejected = 2, stubbed = 1), row)
        assertEquals("2 rejected, 1 stubbed", dev.maxhogan.healthy.companion.ui.Format.shortfall(row))
        assertEquals(null, dev.maxhogan.healthy.companion.ui.Format.shortfall(TypeRow("Steps", Grant.GRANTED, uploaded = 10)))
    }

    @Test
    fun `a retry time that has passed is neither reported nor shown`() {
        val waiting = SyncSnapshot(GlobalState(lastError = StoredError("network", NOW - 10), retryAtMs = NOW + 5_000))
        val later = SyncStateReport.build(types, granted, waiting, FACTS, NOW + 5_000).getValue("lastError").jsonObject
        assertFalse("retryAt" in later)
        assertEquals("network", later.getValue("errorCode").jsonPrimitive.content)
    }

    @Test
    fun `the paused backfill line carries the reason`() {
        val paused = BackfillProgress(BackfillPhase.PAUSED, doneUnits = 3, totalUnits = 9, errorCode = "permission_denied")
        val line = dev.maxhogan.healthy.companion.ui.Format.backfill(paused)
        assertTrue(line.startsWith("Paused, 3 of 9 type-months done: "))
        assertTrue(line.endsWith("(permission_denied)"))
        assertEquals("Paused, 3 of 9 type-months done", dev.maxhogan.healthy.companion.ui.Format.backfill(paused.copy(errorCode = null)))
    }

    @Test
    fun `a skip is reported beside the last error, not in its place`() {
        val snapshot = SyncSnapshot(
            GlobalState(lastError = StoredError("network", NOW - 100), skipReason = StoredError("background_read_missing", NOW - 1)),
        )
        val report = SyncStateReport.build(types, granted, snapshot, FACTS, NOW)
        assertEquals("network", report.getValue("lastError").jsonObject.getValue("errorCode").jsonPrimitive.content)
        assertEquals("background_read_missing", report.getValue("skipReason").jsonObject.getValue("errorCode").jsonPrimitive.content)
        val ui = SyncUiStates.build(types, PairingState.NotPaired, false, snapshot, SyncUiStates.Live(access = granted))
        assertEquals("network", ui.lastError?.errorCode)
        assertEquals("background_read_missing", ui.skipReason?.errorCode)
    }
}
