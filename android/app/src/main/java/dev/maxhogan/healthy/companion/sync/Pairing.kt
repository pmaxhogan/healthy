package dev.maxhogan.healthy.companion.sync

import dev.maxhogan.healthy.companion.BuildConfig
import java.net.URI
import java.net.URISyntaxException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * Seam: what the phone needs to upload. Where the server is, which device row this phone is,
 * and the bearer token for that row. Produced only by [PairingParser] and [PairingStore], so an
 * instance is always well formed.
 *
 * @property url the server's origin (`scheme://host[:port]`, no path and no trailing slash)
 * @property deviceId the server's own id for this phone; goes in every batch as `deviceId`
 * @property token the bearer token, shown once by the admin UI; never logged, never displayed
 */
data class Pairing(val url: String, val deviceId: String, val token: String) {
    /** The one endpoint the app talks to. */
    val ingestUrl: String get() = "$url/ingest/health-connect"

    // A data class prints every property, and this one holds a credential.
    override fun toString(): String = "Pairing(url=$url, deviceId=$deviceId, token=<redacted>)"
}

/** Why a scanned or pasted pairing payload was refused. */
enum class PairingError {
    /** Not JSON, or not a JSON object. */
    NOT_JSON,

    /** `v` is missing or is not a version this build understands. */
    UNSUPPORTED_VERSION,

    /** `url`, `deviceId` or `token` is missing, empty or not a string. */
    MISSING_FIELD,

    /** `url` is not a bare origin: no host, or it carries credentials, a path, a query or a fragment. */
    BAD_URL,

    /** `url` is plain http for a host other than this device's own loopback. */
    INSECURE_URL,

    /** `deviceId` is not an id the server mints. */
    BAD_DEVICE_ID,

    /** `token` is not a device token, or it belongs to a different device than `deviceId`. */
    BAD_TOKEN,
}

sealed interface PairingResult {
    data class Ok(val pairing: Pairing) : PairingResult

    data class Invalid(val error: PairingError) : PairingResult
}

/**
 * Validates the pairing payload the admin UI shows as a QR code:
 * `{"v":1,"url":"https://…","deviceId":"…","token":"hcd1.<deviceId>.<secret>"}`.
 *
 * Strict on purpose. The payload decides where health data is sent, so anything that is not
 * exactly a v1 payload is refused rather than repaired: https only (a debug build, and only a
 * debug build, also accepts plain http for `localhost` and `127.0.0.1`, which is how it reaches
 * a development server over `adb reverse`), an origin with nothing after the authority, and a token whose embedded device
 * id matches `deviceId`. Unknown extra keys are ignored, so the server may add optional fields
 * to v1 without breaking installed apps.
 */
object PairingParser {
    const val VERSION = 1

    /** The server's row ids: 26 characters of Crockford base32. */
    private val DEVICE_ID = Regex("^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$")

    /** 32 random bytes as unpadded base64url. */
    private val TOKEN_SECRET = Regex("^[A-Za-z0-9_-]{43}$")
    private const val TOKEN_VERSION = "hcd1"
    private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1")

    /**
     * @param allowLoopbackHttp whether `http://localhost` is acceptable. Only a debug build
     *   says yes; a release build takes https and nothing else.
     */
    fun parse(text: String, allowLoopbackHttp: Boolean = BuildConfig.DEBUG): PairingResult {
        val root = try {
            Json.parseToJsonElement(text.trim()) as? JsonObject
        } catch (_: SerializationException) {
            null
        } ?: return PairingResult.Invalid(PairingError.NOT_JSON)

        val version = (root["v"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        if (version != VERSION) return PairingResult.Invalid(PairingError.UNSUPPORTED_VERSION)

        val rawUrl = root.string("url")
        val deviceId = root.string("deviceId")
        val token = root.string("token")
        if (rawUrl == null || deviceId == null || token == null) {
            return PairingResult.Invalid(PairingError.MISSING_FIELD)
        }

        val url = when (val origin = parseOrigin(rawUrl, allowLoopbackHttp)) {
            is Origin.Ok -> origin.value
            is Origin.Invalid -> return PairingResult.Invalid(origin.error)
        }
        if (!DEVICE_ID.matches(deviceId)) return PairingResult.Invalid(PairingError.BAD_DEVICE_ID)

        val parts = token.split('.')
        val tokenOk = parts.size == 3 &&
            parts[0] == TOKEN_VERSION &&
            parts[1] == deviceId &&
            TOKEN_SECRET.matches(parts[2])
        if (!tokenOk) return PairingResult.Invalid(PairingError.BAD_TOKEN)

        return PairingResult.Ok(Pairing(url = url, deviceId = deviceId, token = token))
    }

    private sealed interface Origin {
        data class Ok(val value: String) : Origin

        data class Invalid(val error: PairingError) : Origin
    }

    private fun parseOrigin(raw: String, allowLoopbackHttp: Boolean): Origin {
        val uri = try {
            URI(raw)
        } catch (_: URISyntaxException) {
            return Origin.Invalid(PairingError.BAD_URL)
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        val bare = uri.rawUserInfo == null &&
            uri.rawQuery == null &&
            uri.rawFragment == null &&
            (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
        if (!bare || host.isNullOrEmpty() || (scheme != "https" && scheme != "http")) {
            return Origin.Invalid(PairingError.BAD_URL)
        }
        if (scheme == "http" && !(allowLoopbackHttp && host in LOOPBACK_HOSTS)) {
            return Origin.Invalid(PairingError.INSECURE_URL)
        }
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return Origin.Ok("$scheme://$host$port")
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotEmpty() }
}
