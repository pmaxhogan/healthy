package dev.maxhogan.healthy.companion.pair

import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import dev.maxhogan.healthy.companion.sync.PairingParser
import dev.maxhogan.healthy.companion.sync.PairingResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QrDecoderTest {
    private val deviceId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    private val payload =
        "{\"v\":1,\"url\":\"https://healthy.example\",\"deviceId\":\"$deviceId\"," +
            "\"token\":\"hcd1.$deviceId.${"A".repeat(43)}\"}"

    /** A greyscale frame holding [text] as a QR code: dark modules 0x00 on 0xFF, or inverted. */
    private fun frame(text: String, size: Int, inverted: Boolean = false): ByteArray {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        return ByteArray(size * size) { index ->
            val dark = matrix.get(index % size, index / size)
            if (dark != inverted) 0x00 else 0xFF.toByte()
        }
    }

    @Test
    fun readsAPairingCodeOutOfAFrame() {
        val size = 480
        val text = QrDecoder.decode(frame(payload, size), size, size)
        assertEquals(payload, text)
        assertTrue(PairingParser.parse(text!!) is PairingResult.Ok)
    }

    @Test
    fun readsALightOnDarkCode() {
        val size = 480
        assertEquals(payload, QrDecoder.decode(frame(payload, size, inverted = true), size, size))
    }

    @Test
    fun aFrameWithoutACodeIsNull() {
        val size = 320
        assertNull(QrDecoder.decode(ByteArray(size * size) { 0x7F }, size, size))
        assertNull(QrDecoder.decode(ByteArray(size * size) { (it % 251).toByte() }, size, size))
    }
}
