@file:OptIn(ExperimentalMaterial3Api::class)

package dev.maxhogan.healthy.companion.ui

import kotlinx.coroutines.async
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.DisposableEffect
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import dev.maxhogan.healthy.companion.pair.QrScanner
import dev.maxhogan.healthy.companion.sync.Pairing
import dev.maxhogan.healthy.companion.sync.PairingError
import dev.maxhogan.healthy.companion.sync.PairingParser
import dev.maxhogan.healthy.companion.sync.PairingResult
import dev.maxhogan.healthy.companion.sync.PairingStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Clears the stored pairing on a scope that outlives the screen that asked for it.
 *
 * @param onResult told whether the pairing is gone. False means the write failed and the phone
 *   is still paired, which the owner who pressed "Unpair" has to see
 */
fun CoroutineScope.launchUnpair(store: PairingStore, onResult: (Boolean) -> Unit = {}) {
    launch { onResult(store.clear()) }
}

/**
 * Pairs the app with a server: scan the QR code the admin UI shows, or paste the same JSON as
 * text (the only way in on an emulator, and handy over adb). Either way the payload goes
 * through [PairingParser] and the owner confirms the destination before anything is stored.
 */
@Composable
fun PairingScreen(pairingStore: PairingStore, scope: CoroutineScope, onDone: () -> Unit) {
    val context = LocalContext.current
    var cameraGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    var scanning by rememberSaveable { mutableStateOf(false) }
    // The pasted text contains the device token. `remember`, never `rememberSaveable`: saved
    // state is written to disk by the system and outlives the process. It is also cleared as
    // soon as it has been used, refused, or the screen is left.
    var pasted by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<PairingError?>(null) }
    var candidate by remember { mutableStateOf<Pairing?>(null) }
    var saving by remember { mutableStateOf(false) }
    var saveFailed by remember { mutableStateOf(false) }
    val uiScope = rememberCoroutineScope()
    DisposableEffect(Unit) {
        onDispose {
            pasted = ""
            candidate = null
        }
    }

    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        cameraGranted = granted
        scanning = granted
    }

    fun submit(text: String) {
        when (val result = PairingParser.parse(text)) {
            is PairingResult.Ok -> {
                error = null
                saveFailed = false
                scanning = false
                pasted = ""
                candidate = result.pairing
            }
            is PairingResult.Invalid -> {
                pasted = ""
                error = result.error
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pair with a server") },
                navigationIcon = { TextButton(onClick = onDone) { Text("Back") } },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Open the Phone page of the server's admin UI, add a device, and scan the QR " +
                    "code it shows. The code is shown once.",
                style = MaterialTheme.typography.bodyMedium,
            )

            if (scanning && cameraGranted && candidate == null) {
                QrScanner(
                    onCode = ::submit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(1f)
                        .clip(RoundedCornerShape(16.dp)),
                )
                OutlinedButton(onClick = { scanning = false }) { Text("Stop camera") }
            } else {
                Button(
                    onClick = {
                        if (cameraGranted) scanning = true else cameraPermission.launch(Manifest.permission.CAMERA)
                    },
                ) { Text("Scan QR code") }
            }

            Text("Or paste the pairing code as text", style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(
                value = pasted,
                onValueChange = { pasted = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Pairing code (JSON)") },
                minLines = 3,
            )
            OutlinedButton(onClick = { submit(pasted) }, enabled = pasted.isNotBlank()) {
                Text("Use pasted code")
            }

            error?.let {
                Text(Format.pairingError(it), color = MaterialTheme.colorScheme.error)
            }
            if (saveFailed) {
                Text(
                    "The pairing could not be saved on this phone, so it is not paired. Try again; " +
                        "if it keeps failing, restart the phone.",
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }

    candidate?.let { pairing ->
        AlertDialog(
            onDismissRequest = { candidate = null },
            title = { Text("Pair with ${Format.host(pairing.url)}?") },
            text = {
                Text(
                    "Health Connect data this app is allowed to read will be uploaded to " +
                        "${pairing.url} and nowhere else. Only pair with a server you run.",
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !saving,
                    onClick = {
                        saving = true
                        uiScope.launch {
                            // Saved on the app's own scope, so leaving the screen cannot cut the
                            // write short; awaited here, so the screen only closes once it is
                            // known to have worked.
                            val saved = scope.async { pairingStore.save(pairing) }.await()
                            saving = false
                            candidate = null
                            pasted = ""
                            if (saved) onDone() else saveFailed = true
                        }
                    },
                ) { Text(if (saving) "Pairing…" else "Pair") }
            },
            dismissButton = { TextButton(onClick = { candidate = null }) { Text("Cancel") } },
        )
    }
}
