package dev.maxhogan.healthy.companion.sync

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * The owner's sync preferences. One today: whether uploads wait for an unmetered network.
 * Off by default, because the agreed cadence is "any network".
 */
class SyncSettings(private val store: DataStore<Preferences>) {
    val wifiOnly: Flow<Boolean> = store.data.map { it[WIFI_ONLY] ?: false }.distinctUntilChanged()

    suspend fun setWifiOnly(enabled: Boolean) {
        store.edit { it[WIFI_ONLY] = enabled }
    }

    private companion object {
        val WIFI_ONLY = booleanPreferencesKey("sync.wifi_only")
    }
}
