package dev.maxhogan.healthy.companion.pair

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * Finds a QR code in one greyscale frame, entirely on the device.
 *
 * ZXing rather than a Google scanning SDK on purpose: both ML Kit barcode scanning and the Play
 * services code scanner bundle a usage-reporting pipeline, and this app sends nothing anywhere
 * except to the paired server. Only the QR reader is referenced, so R8 drops every other format.
 */
object QrDecoder {
    private val HINTS = mapOf(
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.CHARACTER_SET to "UTF-8",
    )

    /**
     * @param luma one byte of brightness per pixel, row by row, [width] bytes per row
     * @return the code's text, or null when the frame holds no readable QR code
     */
    fun decode(luma: ByteArray, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(luma, width, height, 0, 0, width, height, false)
        // A screen in dark mode can show the code light-on-dark; try that before giving up.
        return read(source) ?: read(source.invert())
    }

    private fun read(source: LuminanceSource): String? = try {
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text
    } catch (_: ReaderException) {
        null
    }
}
