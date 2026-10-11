package dev.maxhogan.healthy.companion.ui

import dev.maxhogan.healthy.companion.sync.TypeRow
import dev.maxhogan.healthy.companion.sync.ErrorMessages
import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.sync.BackfillPhase
import dev.maxhogan.healthy.companion.sync.BackfillProgress
import dev.maxhogan.healthy.companion.sync.PairingError
import java.net.URI
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Display helpers for the status screen. Pure, so they are unit-tested on the JVM. */
object Format {
    private val DATE_TIME = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
    private val DATE = DateTimeFormatter.ISO_LOCAL_DATE

    /** A timestamp in the phone's own zone and locale, or a dash for "never". */
    fun dateTime(epochMs: Long?, zone: ZoneId = ZoneId.systemDefault()): String =
        epochMs?.let { DATE_TIME.format(Instant.ofEpochMilli(it).atZone(zone)) } ?: NONE

    /** The calendar day of a timestamp in the phone's own zone, or a dash for "none". */
    fun date(epochMs: Long?, zone: ZoneId = ZoneId.systemDefault()): String =
        epochMs?.let { DATE.format(Instant.ofEpochMilli(it).atZone(zone)) } ?: NONE

    /** The host part of the paired server's origin: enough to recognise it, short enough to fit. */
    fun host(url: String): String = runCatching { URI(url).host }.getOrNull() ?: url

    fun grant(grant: Grant): String = when (grant) {
        Grant.GRANTED -> "Granted"
        Grant.DENIED -> "Not granted"
        Grant.UNAVAILABLE -> "Unavailable"
    }

    fun backfill(progress: BackfillProgress): String {
        val counts = progress.totalUnits?.let { "${progress.doneUnits} of $it" } ?: "${progress.doneUnits}"
        return when (progress.phase) {
            BackfillPhase.NOT_STARTED -> "Not started"
            BackfillPhase.RUNNING -> "Running, $counts type-months done"
            BackfillPhase.PAUSED -> "Paused, $counts type-months done" +
                (progress.errorCode?.let { ": ${ErrorMessages.describe(it)} ($it)" } ?: "")
            BackfillPhase.COMPLETE -> "Complete"
        }
    }

    /**
     * The "waiting to retry" line, or null when there is no retry pending. A moment that has
     * passed is not a plan any more, so a time in the past is never shown, whatever the state
     * that was handed in still says.
     */
    fun retryLine(errorCode: String, retryAtMs: Long?, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        if (retryAtMs == null || retryAtMs <= nowMs) return null
        // Only a wait for the network is cut short by it; a server or a quota that asked for time
        // gets all of it.
        val sooner = when (errorCode) {
            "network" -> "; sooner if the connection comes back"
            "waiting_for_wifi" -> "; sooner if Wi-Fi connects"
            else -> ""
        }
        return "Waiting to retry at ${dateTime(retryAtMs, zone)}$sooner."
    }

    /** "2 rejected, 1 stubbed" for a type with records that did not arrive as themselves, else null. */
    fun shortfall(row: TypeRow): String? = listOfNotNull(
        row.rejected.takeIf { it > 0 }?.let { "$it rejected" },
        row.stubbed.takeIf { it > 0 }?.let { "$it stubbed" },
    ).takeIf { it.isNotEmpty() }?.joinToString(", ")

    fun pairingError(error: PairingError): String = when (error) {
        PairingError.NOT_JSON -> "That is not a pairing code."
        PairingError.UNSUPPORTED_VERSION -> "This pairing code is from a newer server. Update the app."
        PairingError.MISSING_FIELD -> "The pairing code is incomplete."
        PairingError.BAD_URL -> "The pairing code's server address is not valid."
        PairingError.INSECURE_URL -> "The server address must use https."
        PairingError.BAD_DEVICE_ID -> "The pairing code's device id is not valid."
        PairingError.BAD_TOKEN -> "The pairing code's token is not valid for this device."
    }

    private const val NONE = "—"
}
