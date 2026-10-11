package dev.maxhogan.healthy.companion.sync

import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.okio.OkioStorage
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferencesSerializer
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okio.FileSystem
import okio.Path.Companion.toPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PairingStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    /** Reversible and recognisable, so a test can tell sealed text from plain text. */
    private class FakeCipher(private val key: String = "k1") : TokenCipher {
        override fun encrypt(plaintext: String): String = "sealed[$key]:" + plaintext.reversed()

        override fun decrypt(sealed: String): String? =
            sealed.removePrefix("sealed[$key]:").takeIf { it != sealed }?.reversed()
    }

    private val deviceId = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

    // Synthetic and deliberately low-entropy: the right shape, obviously not a credential.
    private val pairing = Pairing(
        url = "https://healthy.example",
        deviceId = deviceId,
        token = "hcd1.$deviceId.${"A".repeat(43)}",
    )

    /** Runs [block] against a DataStore on [file], then closes it so the file can be reopened. */
    private fun withStore(file: File, block: suspend (DataStore<Preferences>) -> Unit) = runBlocking {
        val job = Job()
        // Okio-backed storage, stated explicitly: the java.io storage replaces its file with a
        // rename that Windows refuses when the target exists, and these tests run there too.
        val store = DataStoreFactory.create(
            storage = OkioStorage(FileSystem.SYSTEM, PreferencesSerializer) { file.absolutePath.toPath() },
            scope = CoroutineScope(Dispatchers.IO + job),
        )
        try {
            block(store)
        } finally {
            job.cancelAndJoin()
        }
    }

    private fun file(): File = File(folder.root, "pairing.preferences_pb")

    @Test
    fun startsUnpaired() = withStore(file()) { data ->
        assertNull(PairingStore(data, FakeCipher()).pairing.first())
    }

    @Test
    fun savedPairingSurvivesReopening() {
        val file = file()
        withStore(file) { PairingStore(it, FakeCipher()).save(pairing) }
        withStore(file) { assertEquals(pairing, PairingStore(it, FakeCipher()).pairing.first()) }
    }

    @Test
    fun tokenIsWrittenOnlySealed() {
        val file = file()
        withStore(file) { PairingStore(it, FakeCipher()).save(pairing) }
        val onDisk = String(file.readBytes(), Charsets.ISO_8859_1)
        assertFalse("the plaintext token reached the disk", onDisk.contains(pairing.token))
        assertTrue(onDisk.contains("sealed[k1]:"))
    }

    @Test
    fun aTokenThatNoLongerOpensReadsAsUnpaired() {
        val file = file()
        withStore(file) { PairingStore(it, FakeCipher("k1")).save(pairing) }
        withStore(file) { assertNull(PairingStore(it, FakeCipher("k2")).pairing.first()) }
    }

    @Test
    fun clearForgetsEverything() {
        val file = file()
        withStore(file) { data ->
            val store = PairingStore(data, FakeCipher())
            store.save(pairing)
            store.clear()
            assertNull(store.pairing.first())
        }
        val onDisk = String(file.readBytes(), Charsets.ISO_8859_1)
        assertFalse(onDisk.contains("healthy.example"))
        assertFalse(onDisk.contains("sealed["))
    }

    @Test
    fun savingAgainReplacesThePairing() = withStore(file()) { data ->
        val store = PairingStore(data, FakeCipher())
        store.save(pairing)
        val next = pairing.copy(url = "http://localhost:8787")
        store.save(next)
        assertEquals(next, store.pairing.first())
    }

    @Test
    fun wifiOnlyDefaultsOffAndPersists() {
        val file = file()
        withStore(file) { data ->
            val settings = SyncSettings(data)
            assertFalse(settings.wifiOnly.first())
            settings.setWifiOnly(true)
        }
        withStore(file) { assertTrue(SyncSettings(it).wifiOnly.first()) }
    }

    /** A Keystore that fails the way the real one does: with an unchecked exception. */
    private class BrokenCipher(private val failEncrypt: Boolean) : TokenCipher {
        override fun encrypt(plaintext: String): String =
            if (failEncrypt) throw java.security.ProviderException("keystore") else "sealed:" + plaintext

        override fun decrypt(sealed: String): String? = throw java.security.ProviderException("keystore")
    }

    @Test
    fun aKeystoreThatThrowsOnSaveStoresNothingAndDoesNotCrash() = withStore(file()) { data ->
        val store = PairingStore(data, BrokenCipher(failEncrypt = true))
        assertFalse(store.save(pairing))
        assertNull(store.pairing.first())
    }

    @Test
    fun aKeystoreThatThrowsOnReadMeansNotPaired() {
        val file = file()
        withStore(file) { assertTrue(PairingStore(it, BrokenCipher(failEncrypt = false)).save(pairing)) }
        withStore(file) { assertNull(PairingStore(it, BrokenCipher(failEncrypt = false)).pairing.first()) }
    }

    @Test
    fun everyPairAndUnpairIsANewGenerationEvenWithTheSameToken() = withStore(file()) { data ->
        val store = PairingStore(data, FakeCipher())
        assertEquals(0L, store.generation())
        store.save(pairing)
        assertEquals(1L, store.generation())
        store.clear()
        assertEquals(2L, store.generation())
        store.save(pairing)
        assertEquals(3L, store.generation())
        assertEquals(pairing, store.pairing.first())
    }

    @Test
    fun aFailedSaveIsNotANewGeneration() = withStore(file()) { data ->
        val store = PairingStore(data, BrokenCipher(failEncrypt = true))
        store.save(pairing)
        assertEquals(0L, store.generation())
    }
}
