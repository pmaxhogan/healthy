package dev.maxhogan.healthy.companion.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.maxhogan.healthy.companion.graph

/**
 * The app's only launchable activity: the status screen, with the pairing screen swapped in
 * over it. Two screens do not need a navigation library.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = graph
        // Opening the app is a request for fresh data; a rotation is not.
        if (savedInstanceState == null) graph.syncController.syncNow()

        setContent {
            HealthyTheme {
                val state by graph.syncController.state.collectAsStateWithLifecycle()
                var pairing by rememberSaveable { mutableStateOf(false) }
                if (pairing) {
                    BackHandler { pairing = false }
                    PairingScreen(
                        pairingStore = graph.pairingStore,
                        scope = graph.scope,
                        onDone = { pairing = false },
                    )
                } else {
                    StatusScreen(
                        state = state,
                        controller = graph.syncController,
                        healthConnect = graph.healthConnect,
                        onPair = { pairing = true },
                        onUnpair = { graph.scope.launchUnpair(graph.pairingStore) },
                    )
                }
            }
        }
    }
}
