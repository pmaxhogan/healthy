package dev.maxhogan.healthy.companion.sync

import java.net.HttpRetryException
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploaderTest {
    private fun classify(status: Int, body: String = "", retryAfterS: Long? = null) =
        UploadClassifier.classify(HttpReply(status, retryAfterS, body))

    @Test
    fun `200 with the server answer is an acknowledgement`() {
        val body = """{"accepted":3,"deleted":1,"rejected":[{"id":"x","errorCode":"invalid_record"}],"duplicate":true,"serverTime":5}"""
        assertEquals(
            UploadResult.Ok(accepted = 3, deleted = 1, rejected = 1, duplicate = true, serverTime = 5, rejectedIds = setOf("x")),
            classify(200, body),
        )
    }

    @Test
    fun `the exact rejected count comes from rejectedTotal, not the truncated list`() {
        val body = """{"accepted":900,"deleted":0,"rejected":[{"id":"x","errorCode":"invalid_record"}],"rejectedTotal":250,"duplicate":false,"serverTime":5}"""
        assertEquals(250, (classify(200, body) as UploadResult.Ok).rejected)
    }

    @Test
    fun `stale hours are read per type, leniently, and their absence is not an empty list`() {
        val h = Hours.MS
        val body = """{"accepted":0,"deleted":0,"rejected":[],"duplicate":false,"serverTime":5,""" +
            """"staleHours":{"Steps":[${3 * h},${h},"x",${h + 1},-$h,${h}],"Distance":"no","Hydration":[]}}"""
        assertEquals(
            mapOf("Steps" to listOf(h, 3 * h), "Distance" to emptyList(), "Hydration" to emptyList()),
            (classify(200, body) as UploadResult.Ok).staleHours,
        )
        val none = """{"accepted":0,"deleted":0,"rejected":[],"duplicate":false,"serverTime":5}"""
        assertEquals(null, (classify(200, none) as UploadResult.Ok).staleHours)
        val odd = """{"accepted":0,"deleted":0,"rejected":[],"duplicate":false,"serverTime":5,"staleHours":[1]}"""
        assertEquals(null, (classify(200, odd) as UploadResult.Ok).staleHours)
    }

    @Test
    fun `409 is a conflict, never an acknowledgement and never a bug`() {
        assertEquals(UploadResult.Conflict, classify(409, """{"error":"batch_id_conflict"}"""))
    }

    @Test
    fun `200 that is not the server answer is not an acknowledgement`() {
        assertEquals(UploadResult.Retry("bad_response", null), classify(200, "<html>Sign in</html>"))
        assertEquals(UploadResult.Retry("bad_response", null), classify(200, """{"ok":true}"""))
        assertEquals(UploadResult.Retry("bad_response", null), classify(200, ""))
    }

    @Test
    fun `401 stops, 413 halves, 400 and 415 are bugs`() {
        assertEquals(UploadResult.Unauthorized, classify(401, """{"error":"unauthorized"}"""))
        assertEquals(UploadResult.TooLarge, classify(413, """{"error":"payload_too_large"}"""))
        assertEquals(UploadResult.Bug("bad_request"), classify(400, """{"error":"bad_request"}"""))
        assertEquals(UploadResult.Bug("bad_request"), classify(400, "not json"))
        assertEquals(UploadResult.Bug("unsupported_media_type"), classify(415))
    }

    @Test
    fun `429 and 5xx are retried, with retry-after`() {
        assertEquals(UploadResult.Retry("rate_limited", 60_000), classify(429, """{"error":"rate_limited"}""", 60))
        assertEquals(UploadResult.Retry("backlogged", 30_000), classify(429, """{"error":"backlogged"}""", 30))
        assertEquals(UploadResult.Retry("http_500", null), classify(500))
        assertEquals(UploadResult.Retry("http_503", 5_000), classify(503, "", 5))
        assertEquals(UploadResult.Retry("network", null), UploadClassifier.network())
    }

    @Test
    fun `a status the contract does not name keeps the batch`() {
        for (status in listOf(302, 403, 404, 405, 408)) {
            assertEquals(UploadResult.Retry("http_$status", null), classify(status, "<html></html>"))
        }
    }

    @Test
    fun `an error code is never taken from free text`() {
        assertEquals(UploadResult.Bug("bad_request"), classify(400, """{"error":"Something Went Wrong!"}"""))
    }

    @Test
    fun `backoff doubles, is capped, and stays within its jitter`() {
        val backoff = Backoff(baseMs = 1_000, capMs = 10_000, jitter = 0.25, random = Random(1))
        repeat(200) {
            assertTrue(backoff.delayMs(0) in 750..1_250)
            assertTrue(backoff.delayMs(2) in 3_000..5_000)
            assertTrue(backoff.delayMs(10) in 7_500..12_500)
            assertTrue(backoff.delayMs(500) in 7_500..12_500)
        }
    }

    @Test
    fun `retry-after is a minimum`() {
        val backoff = Backoff(baseMs = 1_000, capMs = 10_000, jitter = 0.25, random = Random(1))
        repeat(200) {
            assertTrue(backoff.delayMs(0, retryAfterMs = 60_000) in 60_000..75_000)
            assertTrue(backoff.delayMs(3, retryAfterMs = 100) >= 6_000)
        }
    }

    @Test
    fun `a 401 that the streaming connection throws instead of returning is still a 401`() {
        // HttpURLConnection cannot replay a streamed body to answer an authentication
        // challenge, so it throws; the status is on the exception.
        val thrown = HttpRetryException("cannot retry due to server authentication, in streaming mode", 401)
        val reply = UrlConnectionTransport.replyFor(thrown)
        assertEquals(401, reply.status)
        assertEquals(UploadResult.Unauthorized, UploadClassifier.classify(reply))
        // Any other status it carries is classified the usual way, never as "network".
        assertEquals(
            UploadResult.Retry("http_407", null),
            UploadClassifier.classify(UrlConnectionTransport.replyFor(HttpRetryException("proxy", 407))),
        )
    }

    @Test
    fun `no sync ever asks WorkManager to retry, so the period stays fifteen minutes`() {
        // "Retry" on periodic work swaps the period for WorkManager's backoff, which grows to
        // hours. The outcome type has no such value, and every result maps to one that ends.
        assertEquals(setOf(WorkOutcome.SUCCESS, WorkOutcome.FAILURE), WorkOutcome.entries.toSet())
        assertEquals(WorkOutcome.FAILURE, SyncWorker.outcomeFor(RunResult.Failed("network")))
        assertEquals(WorkOutcome.FAILURE, SyncWorker.outcomeFor(RunResult.Failed("http_503", 30_000)))
        assertEquals(WorkOutcome.FAILURE, SyncWorker.outcomeFor(RunResult.Failed("no_permissions", retryable = false)))
        assertEquals(WorkOutcome.FAILURE, SyncWorker.outcomeFor(RunResult.PairingRejected(notify = true)))
        assertEquals(WorkOutcome.SUCCESS, SyncWorker.outcomeFor(RunResult.Skipped("background_read_missing", notify = true)))
        assertEquals(WorkOutcome.SUCCESS, SyncWorker.outcomeFor(RunResult.Success))
        assertEquals(WorkOutcome.SUCCESS, SyncWorker.outcomeFor(null))
        assertEquals(15 * 60_000L, SyncCadence.PERIOD_MS)
    }
}
