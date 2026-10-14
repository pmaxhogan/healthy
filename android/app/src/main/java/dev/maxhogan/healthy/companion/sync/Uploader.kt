package dev.maxhogan.healthy.companion.sync

import java.io.IOException
import java.net.HttpRetryException
import java.net.HttpURLConnection
import java.net.URL
import kotlin.random.Random
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/** What came back from one POST. [retryAfterS] is the `retry-after` header in seconds, if any. */
data class HttpReply(val status: Int, val retryAfterS: Long?, val body: String)

/** The HTTP layer, small enough to fake. Throws [IOException] when no reply was received. */
fun interface HttpTransport {
    suspend fun post(url: String, token: String, gzipBody: ByteArray): HttpReply
}

/** What the engine does about a reply. */
sealed interface UploadResult {
    /**
     * 200: the batch is validated and durably queued. Positions may be committed.
     *
     * @property rejected how many of its records the server refused one by one
     */
    data class Ok(
        val accepted: Int,
        val deleted: Int,
        val rejected: Int,
        val duplicate: Boolean,
        val serverTime: Long?,
        /** Ids of rejected records, as far as the server listed them (the first hundred). */
        val rejectedIds: Set<String> = emptySet(),
        /**
         * The hours whose platform total the server holds stale, by record type, each as the
         * epoch ms of its start: the whole of what it knows to be stale, as far as one answer
         * carries. Null when the answer did not say (the server could not tell just then, or is
         * a build that does not send it): what the phone was told before still stands.
         */
        val staleHours: Map<String, List<Long>>? = null,
    ) : UploadResult

    /** 401: the token is revoked or rotated. Stop until the owner pairs again. */
    data object Unauthorized : UploadResult

    /** 413: the body is over the server's limits. Halve it and try again. */
    data object TooLarge : UploadResult

    /**
     * 409: this batch id was already used for different bytes. Nothing was applied; the same
     * content goes again under a fresh id. Never an acknowledgement.
     */
    data object Conflict : UploadResult

    /**
     * 400 or 415: the server could not read the request. Both are about the request as a whole;
     * the server never answers either for one record (a record it cannot read is rejected
     * inside a 200). So nothing is skipped and nothing is split: the position stays put.
     */
    data class Bug(val errorCode: String) : UploadResult

    /**
     * Not sent: the pairing this request belongs to is no longer the stored one. Produced by the
     * engine before a request, never by a reply.
     */
    data object Stale : UploadResult

    /** 429, 5xx, anything unexpected, or no reply at all. Keep the batch and try again later. */
    data class Retry(val errorCode: String, val retryAfterMs: Long?) : UploadResult
}

object UploadClassifier {
    private val CODE = Regex("^[a-z][a-z0-9_]{0,63}$")

    fun classify(reply: HttpReply): UploadResult {
        val retryAfterMs = reply.retryAfterS?.takeIf { it >= 0 }?.let { it * 1000 }
        return when (reply.status) {
            200 -> ok(reply.body)
            401 -> UploadResult.Unauthorized
            413 -> UploadResult.TooLarge
            409 -> UploadResult.Conflict
            400 -> UploadResult.Bug(errorCode(reply.body) ?: "bad_request")
            415 -> UploadResult.Bug(errorCode(reply.body) ?: "unsupported_media_type")
            429 -> UploadResult.Retry(errorCode(reply.body) ?: "rate_limited", retryAfterMs)
            // Everything else, 5xx and the statuses the contract does not name (a redirect to a
            // login page, a 403 from a proxy in front of the server), is kept and retried: the
            // batch is not known to be wrong, so it must not be dropped.
            else -> UploadResult.Retry("http_${reply.status}", retryAfterMs)
        }
    }

    /** No reply: DNS, TLS, a dropped connection, a timeout. */
    fun network(): UploadResult.Retry = UploadResult.Retry("network", null)

    private fun ok(body: String): UploadResult {
        // A 200 that is not the server's own answer (a captive portal, an interposed page) is
        // not an acknowledgement.
        val json = parse(body) ?: return UploadResult.Retry("bad_response", null)
        val accepted = (json["accepted"] as? JsonPrimitive)?.intOrNull
            ?: return UploadResult.Retry("bad_response", null)
        return UploadResult.Ok(
            accepted = accepted,
            deleted = (json["deleted"] as? JsonPrimitive)?.intOrNull ?: 0,
            // `rejected` lists only the first hundred; `rejectedTotal` is the exact count.
            rejected = (json["rejectedTotal"] as? JsonPrimitive)?.intOrNull
                ?: (json["rejected"] as? JsonArray)?.size
                ?: 0,
            duplicate = (json["duplicate"] as? JsonPrimitive)?.booleanOrNull ?: false,
            serverTime = (json["serverTime"] as? JsonPrimitive)?.longOrNull,
            rejectedIds = (json["rejected"] as? JsonArray).orEmpty().mapNotNullTo(HashSet()) { entry ->
                ((entry as? JsonObject)?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.content
            },
            staleHours = staleHours(json["staleHours"]),
        )
    }

    /**
     * `staleHours`, read leniently: an hour that is not a whole UTC hour, or anything that is not
     * a number, is left out, and so is a value that is not a list. Anything other than an object
     * is the field not being there.
     */
    private fun staleHours(element: JsonElement?): Map<String, List<Long>>? {
        val byType = element as? JsonObject ?: return null
        return byType.mapValues { (_, hours) ->
            (hours as? JsonArray).orEmpty()
                .mapNotNull { (it as? JsonPrimitive)?.takeIf { hour -> !hour.isString }?.longOrNull }
                .filter { it >= 0 && it % Hours.MS == 0L }
                .distinct()
                .sorted()
        }
    }

    private fun errorCode(body: String): String? =
        (parse(body)?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(CODE::matches)

    private fun parse(body: String): JsonObject? = try {
        Json.parseToJsonElement(body) as? JsonObject
    } catch (_: SerializationException) {
        null
    }
}

/**
 * Exponential backoff with jitter.
 *
 * The wait before retry number `attempt` (0 for the first retry) is `base * 2^attempt`, capped at
 * [capMs], then spread by plus or minus [jitter]. A server's `retry-after` is honoured as a
 * minimum, with up to [jitter] added so retries from one outage do not line up.
 */
class Backoff(
    private val baseMs: Long,
    private val capMs: Long,
    private val jitter: Double = 0.25,
    private val random: Random = Random.Default,
) {
    fun delayMs(attempt: Int, retryAfterMs: Long? = null): Long {
        val exponential = if (attempt >= 30) capMs else minOf(capMs, baseMs shl attempt.coerceAtLeast(0))
        val spread = (exponential * (1 + jitter * (random.nextDouble() * 2 - 1))).toLong()
        if (retryAfterMs == null) return spread.coerceAtLeast(0)
        val honoured = retryAfterMs + (retryAfterMs * jitter * random.nextDouble()).toLong()
        return maxOf(honoured, spread)
    }
}

/**
 * [HttpTransport] on `HttpURLConnection`. Redirects are not followed: the request carries a
 * bearer token, and the one endpoint the app talks to never redirects. Nothing here logs.
 */
class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 20_000,
    private val readTimeoutMs: Int = 60_000,
) : HttpTransport {
    companion object {
        /**
         * A body sent in fixed-length streaming mode cannot be replayed, so when the server
         * answers with an authentication challenge (the 401 of a revoked token) the connection
         * throws instead of returning the status. The status is on the exception; without this
         * a revoked token would look like a network error and be retried for ever.
         */
        fun replyFor(e: HttpRetryException): HttpReply = HttpReply(e.responseCode(), null, "")
    }

    override suspend fun post(url: String, token: String, gzipBody: ByteArray): HttpReply =
        withContext(Dispatchers.IO) {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.instanceFollowRedirects = false
                connection.connectTimeout = connectTimeoutMs
                connection.readTimeout = readTimeoutMs
                connection.doOutput = true
                connection.useCaches = false
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Content-Encoding", "gzip")
                connection.setRequestProperty("Accept", "application/json")
                connection.setFixedLengthStreamingMode(gzipBody.size)
                connection.outputStream.use { it.write(gzipBody) }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                HttpReply(status, connection.getHeaderField("retry-after")?.trim()?.toLongOrNull(), body)
            } catch (e: HttpRetryException) {
                replyFor(e)
            } catch (e: IOException) {
                throw e
            } catch (e: RuntimeException) {
                // The platform's HTTP stack reports some failures (a malformed reply, a refused
                // cleartext connection) as unchecked exceptions; to the engine they are all
                // "no reply". The message is dropped: it can carry the URL.
                throw IOException("transport_failure")
            } finally {
                connection.disconnect()
            }
        }
}
