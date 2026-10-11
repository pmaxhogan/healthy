@file:OptIn(ExperimentalMaterial3Api::class)

package dev.maxhogan.healthy.companion.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * The screen Health Connect opens from its "privacy policy" link in the permission dialog, and
 * from the app's entry in the system's permission-usage view. It explains what this software
 * does with what it reads. It describes the software, never whoever runs a particular server.
 */
class PermissionsRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HealthyTheme {
                Scaffold(topBar = { TopAppBar(title = { Text("Your data and this app") }) }) { padding ->
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(padding)
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        for ((heading, body) in RATIONALE) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(heading, style = MaterialTheme.typography.titleMedium)
                                Text(body, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** Heading and body pairs. Plain statements of behaviour that the code has to keep true. */
internal val RATIONALE: List<Pair<String, String>> = listOf(
    "What this app is" to
        "Healthy Companion is the phone half of Healthy, open-source software a person runs " +
        "for themselves. It copies Health Connect records from this phone to one Healthy " +
        "server, so that server can answer questions about them while the phone is off.",
    "What it reads" to
        "Only the Health Connect record types you grant. It asks for read access to every " +
        "type Health Connect has, to read in the background, and to read history older than " +
        "30 days. It never asks to write, and it changes nothing in Health Connect. A type " +
        "you do not grant is reported to the server as not permitted, with no data.",
    "Where the data goes" to
        "To the single server this phone was paired with by scanning that server's pairing " +
        "code, over an encrypted connection, and nowhere else. The app has no analytics, no " +
        "advertising, no crash reporting and no third-party services. It contacts no other " +
        "host.",
    "What stays on the phone" to
        "The server's address, the device token (encrypted with a key held in the Android " +
        "Keystore) and sync bookkeeping. None of it is included in device backups. " +
        "The camera is used only to read the pairing code; " +
        "frames are analysed on the phone and never stored or sent.",
    "How to stop it" to
        "Revoke any permission in Health Connect at any time; the app stops reading that " +
        "type. Unpair in the app to forget the server and stop all uploads. Uninstalling " +
        "removes everything the app stored on the phone. Data already uploaded is deleted " +
        "from the server's own admin page, not from this app.",
)
