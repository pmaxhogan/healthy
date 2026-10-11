package dev.maxhogan.healthy.companion.sync

import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PairingParserTest {
    private val deviceId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    private val otherDeviceId = "01ARZ3NDEKTSV4RRFFQ69G5FAW"

    // Synthetic and deliberately low-entropy: the right shape, obviously not a credential.
    private val secret = "A".repeat(43)
    private val token = "hcd1.$deviceId.$secret"

    private fun payload(
        v: String = "1",
        url: String? = "https://healthy.example",
        deviceId: String? = this.deviceId,
        token: String? = this.token,
        extra: String = "",
    ): String = buildString {
        append("{\"v\":").append(v)
        url?.let { append(",\"url\":\"").append(it).append('"') }
        deviceId?.let { append(",\"deviceId\":\"").append(it).append('"') }
        token?.let { append(",\"token\":\"").append(it).append('"') }
        append(extra).append('}')
    }

    private fun ok(text: String): Pairing = when (val result = PairingParser.parse(text)) {
        is PairingResult.Ok -> result.pairing
        is PairingResult.Invalid -> throw AssertionError("expected a pairing, got ${result.error}")
    }

    private fun error(text: String): PairingError = when (val result = PairingParser.parse(text)) {
        is PairingResult.Ok -> throw AssertionError("expected a refusal, got ${result.pairing}")
        is PairingResult.Invalid -> result.error
    }

    @Test
    fun acceptsTheDocumentedPayload() {
        val pairing = ok(payload())
        assertEquals(Pairing("https://healthy.example", deviceId, token), pairing)
        assertEquals("https://healthy.example/ingest/health-connect", pairing.ingestUrl)
    }

    @Test
    fun normalisesTheUrlToABareOrigin() {
        assertEquals("https://healthy.example", ok(payload(url = "https://healthy.example/")).url)
        assertEquals("https://healthy.example", ok(payload(url = "HTTPS://Healthy.Example")).url)
        assertEquals("https://healthy.example:8443", ok(payload(url = "https://healthy.example:8443")).url)
    }

    @Test
    fun toleratesSurroundingWhitespaceAndUnknownKeys() {
        assertEquals(deviceId, ok("  \n" + payload(extra = ",\"name\":\"phone\"") + "\n").deviceId)
    }

    @Test
    fun allowsPlainHttpOnlyForLoopback() {
        assertEquals("http://localhost:8787", ok(payload(url = "http://localhost:8787")).url)
        assertEquals("http://127.0.0.1:8787", ok(payload(url = "http://127.0.0.1:8787")).url)
        for (url in listOf(
            "http://healthy.example",
            "http://10.0.2.2:8787",
            "http://192.168.1.10:8787",
            "http://localhost.example:8787",
            "http://127.0.0.1.example",
        )) {
            assertEquals(url, PairingError.INSECURE_URL, error(payload(url = url)))
        }
    }

    @Test
    fun refusesUrlsThatAreNotABareOrigin() {
        for (url in listOf(
            "healthy.example",
            "ftp://healthy.example",
            "https://",
            "https:///ingest",
            "https://user:pass@healthy.example",
            "https://healthy.example/admin",
            "https://healthy.example?x=1",
            "https://healthy.example#frag",
            "https://healthy example",
            "javascript:alert(1)",
        )) {
            assertEquals(url, PairingError.BAD_URL, error(payload(url = url)))
        }
    }

    @Test
    fun refusesAnythingThatIsNotAJsonObject() {
        for (text in listOf("", "   ", "not json", "[1]", "\"text\"", "42", "{\"v\":1", token)) {
            assertEquals(text, PairingError.NOT_JSON, error(text))
        }
    }

    @Test
    fun refusesOtherVersions() {
        for (v in listOf("2", "0", "\"1\"", "1.5", "null", "true")) {
            assertEquals(v, PairingError.UNSUPPORTED_VERSION, error(payload(v = v)))
        }
        assertEquals(PairingError.UNSUPPORTED_VERSION, error("{\"url\":\"https://healthy.example\"}"))
    }

    @Test
    fun refusesMissingEmptyOrNonStringFields() {
        assertEquals(PairingError.MISSING_FIELD, error(payload(url = null)))
        assertEquals(PairingError.MISSING_FIELD, error(payload(deviceId = null)))
        assertEquals(PairingError.MISSING_FIELD, error(payload(token = null)))
        assertEquals(PairingError.MISSING_FIELD, error(payload(url = "")))
        assertEquals(PairingError.MISSING_FIELD, error(payload(token = null, extra = ",\"token\":7")))
        assertEquals(PairingError.MISSING_FIELD, error(payload(deviceId = null, extra = ",\"deviceId\":null")))
    }

    @Test
    fun refusesDeviceIdsTheServerDoesNotMint() {
        for (id in listOf("dev_1", deviceId.lowercase(), deviceId.dropLast(1), deviceId + "0", deviceId.replace('A', 'I'))) {
            assertEquals(id, PairingError.BAD_DEVICE_ID, error(payload(deviceId = id, token = "hcd1.$id.$secret")))
        }
    }

    @Test
    fun refusesMalformedOrMismatchedTokens() {
        for (bad in listOf(
            "hcd2.$deviceId.$secret",
            "hcd1.$otherDeviceId.$secret",
            "hcd1.$deviceId.${secret.dropLast(1)}",
            "hcd1.$deviceId.${secret}A",
            "hcd1.$deviceId.${secret.dropLast(1)}=",
            "hcd1.$deviceId.$secret.extra",
            "$deviceId.$secret",
            secret,
        )) {
            assertEquals(bad, PairingError.BAD_TOKEN, error(payload(token = bad)))
        }
    }

    @Test
    fun neverPrintsTheToken() {
        assertFalse(ok(payload()).toString().contains(secret))
    }

    @Test
    fun aReleaseBuildRefusesPlainHttpEvenForLoopback() {
        fun release(url: String) = PairingParser.parse(payload(url = url), allowLoopbackHttp = false)
        assertEquals(PairingResult.Invalid(PairingError.INSECURE_URL), release("http://localhost:8787"))
        assertEquals(PairingResult.Invalid(PairingError.INSECURE_URL), release("http://127.0.0.1:8787"))
        assertEquals(PairingResult.Invalid(PairingError.INSECURE_URL), release("http://healthy.example"))
        assertTrue(release("https://healthy.example") is PairingResult.Ok)
        // https to loopback is still https.
        assertTrue(release("https://localhost:8443") is PairingResult.Ok)
    }

    @Test
    fun onlyADebugBuildAllowsLoopbackHttpByDefault() {
        val byDefault = PairingParser.parse(payload(url = "http://localhost:8787"))
        assertEquals(dev.maxhogan.healthy.companion.BuildConfig.DEBUG, byDefault is PairingResult.Ok)
    }
}
