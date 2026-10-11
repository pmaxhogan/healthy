package dev.maxhogan.healthy.companion.sync

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Seals the device token before it is written to disk.
 *
 * An interface so [PairingStore] can be unit-tested on the JVM, where there is no Android
 * Keystore. [decrypt] returns null for anything it cannot open (a restored backup, a wiped
 * key, a failing Keystore): the caller treats that as "not paired" rather than crashing.
 * [encrypt] may throw; [PairingStore.save] turns that into "not saved".
 */
interface TokenCipher {
    fun encrypt(plaintext: String): String

    fun decrypt(sealed: String): String?
}

/**
 * AES-256-GCM under a key that lives in the Android Keystore and cannot be exported, so a copy
 * of the app's data directory alone does not yield the token. Output is base64 of the 12-byte
 * nonce followed by the ciphertext and tag; the Keystore generates a fresh nonce per call.
 */
class KeystoreTokenCipher(private val alias: String = "healthy.pairing.v1") : TokenCipher {
    override fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val body = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(cipher.iv + body)
    }

    override fun decrypt(sealed: String): String? = try {
        val bytes = Base64.getDecoder().decode(sealed)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, NONCE_BYTES))
        String(cipher.doFinal(bytes, NONCE_BYTES, bytes.size - NONCE_BYTES), Charsets.UTF_8)
    } catch (_: Exception) {
        // Not base64, shorter than a nonce, a key that is gone, or the Keystore itself failing
        // (which surfaces as an unchecked ProviderException). All of them mean the same thing
        // to the caller: there is no usable token, pair again.
        null
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_BITS)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BITS = 256
        const val TAG_BITS = 128
        const val NONCE_BYTES = 12
    }
}
