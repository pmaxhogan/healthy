package dev.maxhogan.healthy.companion.sync

/**
 * One sentence for every error code the app can show: what happened and, where the owner can do
 * something about it, what. The code itself is always shown beside the sentence, because it is
 * what the server's Phone page and the logs say.
 *
 * Codes are stable identifiers, never messages, so this table is the only place wording lives.
 */
object ErrorMessages {
    private val HTTP = Regex("^http_(\\d{3})$")

    private val MESSAGES: Map<String, String> = mapOf(
        SyncEngine.ERROR_UNAUTHORIZED to
            "This phone's pairing was rejected. Pair again from the Phone page (as a new phone if this one was revoked).",
        SyncEngine.ERROR_BACKGROUND_READ to
            "Health Connect only lets this app read while it is open. Allow reading in the background, " +
            "or open the app to sync.",
        SyncEngine.ERROR_NO_PERMISSIONS to
            "No Health Connect record type is granted, so there is nothing to sync. Use Grant all.",
        "backfill_not_started" to
            "Android would not start the backfill. Keep the app open and try again; it needs the heart rate, " +
            "skin temperature or oxygen saturation permission.",
        SyncEngine.ERROR_HC_UNAVAILABLE to
            "Health Connect did not answer, or is not available on this phone. It is tried again on the next sync.",
        "hc_rate_limited" to
            "Health Connect's read quota is used up for now. Syncing resumes by itself when it refills.",
        "hc_remote" to "Health Connect stopped answering part-way. It is tried again on the next sync.",
        "hc_io" to "Health Connect could not read its data. It is tried again on the next sync.",
        "hc_error" to "Health Connect reported an error. It is tried again on the next sync.",
        "hc_invalid_argument" to "Health Connect refused the request for this type. It is tried again on the next sync.",
        SyncEngine.ERROR_NETWORK to "The server could not be reached. Nothing is lost; it is tried again.",
        "bad_request" to
            "The server could not read an upload. Nothing was skipped; it is sent again on the next sync. " +
            "If it keeps happening, update the app.",
        "unsupported_media_type" to
            "The server refused the upload's format. Nothing was skipped. Update the app or the server.",
        "payload_too_large" to
            "The server found an upload too large even after it was split. That type waits; nothing was skipped.",
        "record_too_large" to "A record is too large to send and could not be reduced. That type waits.",
        SyncEngine.ERROR_STUBBED to
            "A record was too large to upload. A placeholder with its times and size was sent instead; " +
            "see the Stubbed count.",
        SyncEngine.ERROR_REJECTED to
            "The server refused some records it could not read. They are counted under Rejected for their type.",
        SyncEngine.ERROR_CONFLICT to "The server had already seen an upload id with different content. It is sent again.",
        SyncEngine.ERROR_PAIRING_CHANGED to "The pairing changed while a sync was running. The next sync uses the new one.",
        SyncEngine.ERROR_AGGREGATE to
            "Health Connect could not compute its hourly totals for a type. The records themselves were uploaded.",
        "permission_denied" to
            "Health Connect refused to let this app read a type. Check its permission in Health Connect.",
        SyncEngine.ERROR_TOKEN_UNSTABLE to
            "Health Connect keeps expiring this type's change marker. The last 30 days were re-read; it is tried again.",
        SyncEngine.ERROR_PAGE_TOKEN to
            "Health Connect lost its place while paging through a type. That type is tried again on the next run.",
        "rate_limited" to "The server asked the phone to slow down. It waits and carries on.",
        "backlogged" to "The server is still working through earlier uploads. The phone waits and carries on.",
        "bad_response" to
            "Something other than the server answered (a sign-in page or a network portal). Nothing was taken as sent.",
        "internal_error" to "The app hit an unexpected error. It is tried again on the next sync.",
        "backfill_state_invalid" to "The saved backfill position for a type was unreadable. Run the full backfill again.",
        "unknown_record_type" to "The app asked Health Connect for a type it does not know. Update the app.",
        "sync_failed" to "The sync failed. It is tried again on the next run.",
        SyncEngine.ERROR_STATE_STORE to
            "The app could not save its own sync position on this phone. Nothing is lost: what was sent is sent " +
            "again. If it keeps happening, free up storage or restart the phone.",
        HealthConnectSource.ERROR_PAGE_TOO_LARGE to
            "A batch of very large records did not fit in memory. It is read again in smaller pieces.",
        "waiting_for_wifi" to
            "The backfill is waiting for Wi-Fi, because uploading on Wi-Fi only is switched on.",
    )

    /** The sentence for [errorCode]. Never empty: a code this table lacks still gets a plain one. */
    fun describe(errorCode: String): String {
        MESSAGES[errorCode]?.let { return it }
        val status = HTTP.matchEntire(errorCode)?.groupValues?.get(1)?.toIntOrNull()
        return when {
            status == null -> "The sync reported an error. It is tried again on the next run."
            status >= 500 -> "The server reported an error of its own (HTTP $status). Nothing is lost; it is tried again."
            status in 300..399 ->
                "The server address redirected (HTTP $status) instead of answering. Check the address this phone is paired with."
            status == 403 || status == 404 || status == 405 ->
                "Something in front of the server refused the upload (HTTP $status). Check that the ingest address is reachable without signing in."
            else -> "The server answered unexpectedly (HTTP $status). Nothing was taken as sent; it is tried again."
        }
    }

    /** Every code with a sentence of its own, for the test that keeps the table complete. */
    val known: Set<String> get() = MESSAGES.keys
}
