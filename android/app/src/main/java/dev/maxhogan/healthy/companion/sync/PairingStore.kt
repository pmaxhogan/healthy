package dev.maxhogan.healthy.companion.sync

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Seam: the one place the pairing is persisted and read.
 *
 * The pairing screen writes it; the status screen and the sync engine observe [pairing]. The
 * URL and device id are stored as they are (neither is a secret); the token is stored only as
 * [TokenCipher] output. A stored pairing whose token no longer opens reads as null: the app
 * shows "not paired" and the owner scans again.
 *
 * Replacing the pairing or clearing it is the engine's cue to drop state that belonged to the
 * old device (changes tokens, backfill cursors): it should key that state by
 * [Pairing.deviceId], or reset it when this flow emits a different id.
 */
class PairingStore(
    private val store: DataStore<Preferences>,
    private val cipher: TokenCipher,
) {
    /** The current pairing, or null when the app is not paired. Emits on every change. */
    val pairing: Flow<Pairing?> = store.data.map(::read).distinctUntilChanged()

    /**
     * Stores [pairing]. False when it could not be stored (the Keystore refused to seal the
     * token, or the disk write failed): nothing is saved and the app stays as it was.
     */
    suspend fun save(pairing: Pairing): Boolean = try {
        val sealed = cipher.encrypt(pairing.token)
        store.edit {
            it[URL] = pairing.url
            it[DEVICE_ID] = pairing.deviceId
            it[TOKEN_SEALED] = sealed
            it[GENERATION] = (it[GENERATION] ?: 0) + 1
        }
        true
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        false
    }

    suspend fun clear() {
        store.edit {
            it.remove(URL)
            it.remove(DEVICE_ID)
            it.remove(TOKEN_SEALED)
            it[GENERATION] = (it[GENERATION] ?: 0) + 1
        }
    }

    private fun read(prefs: Preferences): Pairing? {
        val url = prefs[URL] ?: return null
        val deviceId = prefs[DEVICE_ID] ?: return null
        val token = prefs[TOKEN_SEALED]?.let(::open) ?: return null
        return Pairing(url = url, deviceId = deviceId, token = token)
    }

    /**
     * Counts every [save] and [clear]. Two pairings with the same URL, device and token are
     * equal as values, but pairing again is an act the sync engine has to notice: it is the
     * owner saying "try this one", which lifts a refusal the server gave the same token before.
     */
    suspend fun generation(): Long = try {
        store.data.first()[GENERATION] ?: 0
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        0
    }

    /** A cipher that throws instead of answering null still reads as "not paired". */
    private fun open(sealed: String): String? = try {
        cipher.decrypt(sealed)
    } catch (_: Exception) {
        null
    }

    private companion object {
        val GENERATION = longPreferencesKey("pairing.generation")
        val URL = stringPreferencesKey("pairing.url")
        val DEVICE_ID = stringPreferencesKey("pairing.device_id")
        val TOKEN_SEALED = stringPreferencesKey("pairing.token_sealed")
    }
}
