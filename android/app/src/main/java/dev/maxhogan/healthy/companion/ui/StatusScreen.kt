@file:OptIn(ExperimentalMaterial3Api::class)

package dev.maxhogan.healthy.companion.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.health.connect.HealthConnectManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.compose.LifecycleResumeEffect
import dev.maxhogan.healthy.companion.BuildConfig
import dev.maxhogan.healthy.companion.hc.Grant
import dev.maxhogan.healthy.companion.hc.HealthAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectAccess
import dev.maxhogan.healthy.companion.hc.HealthConnectStatus
import dev.maxhogan.healthy.companion.sync.BackfillPhase
import dev.maxhogan.healthy.companion.sync.ErrorMessages
import dev.maxhogan.healthy.companion.sync.PairingState
import dev.maxhogan.healthy.companion.sync.SyncActivity
import dev.maxhogan.healthy.companion.sync.SyncController
import dev.maxhogan.healthy.companion.sync.SyncUiState
import dev.maxhogan.healthy.companion.sync.TypeRow

/**
 * The status screen: pairing, sync state and controls, permissions, and one coverage row per
 * record type. It renders [SyncUiState] and calls [SyncController]; it holds no sync logic.
 */
@Composable
fun StatusScreen(
    state: SyncUiState,
    controller: SyncController,
    healthConnect: HealthConnectAccess,
    onPair: () -> Unit,
    onUnpair: () -> Unit,
    unpairFailed: Boolean = false,
) {
    val context = LocalContext.current
    var notificationsGranted by remember { mutableStateOf(hasNotificationPermission(context)) }

    // Grants and the battery exemption change in system screens, outside the app.
    LifecycleResumeEffect(controller) {
        controller.refresh()
        notificationsGranted = hasNotificationPermission(context)
        onPauseOrDispose {}
    }

    val healthPermissions = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { controller.refresh() }
    val notificationPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { notificationsGranted = it }

    Scaffold(topBar = { TopAppBar(title = { Text("Healthy Companion") }) }) { padding ->
        PullToRefreshBox(
            isRefreshing = state.activity == SyncActivity.SYNCING,
            onRefresh = {
                controller.refresh()
                controller.syncNow()
            },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                item { PairingCard(state.pairing, onPair, onUnpair, unpairFailed) }
                item { SyncCard(state, controller) }
                item {
                    PermissionsCard(
                        access = state.access,
                        onGrantAll = { healthPermissions.launch(healthConnect.requestablePermissions()) },
                        onManage = { openHealthPermissions(context) },
                    )
                }
                if (!notificationsGranted || !state.batteryExempt || !state.hibernationExempt) {
                    item {
                        BackgroundCard(
                            notificationsGranted = notificationsGranted,
                            batteryExempt = state.batteryExempt,
                            hibernationExempt = state.hibernationExempt,
                            onExemptHibernation = { requestHibernationExemption(context) },
                            onAllowNotifications = {
                                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                            },
                            onExemptBattery = { requestBatteryExemption(context) },
                        )
                    }
                }
                item { CoverageHeader() }
                items(state.types, key = { it.type }) { CoverageRow(it) }
                item { Footer(onPrivacy = { context.startActivity(Intent(context, PermissionsRationaleActivity::class.java)) }) }
            }
        }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun PairingCard(pairing: PairingState, onPair: () -> Unit, onUnpair: () -> Unit, unpairFailed: Boolean) {
    var confirmUnpair by remember { mutableStateOf(false) }
    Section("Server") {
        when (pairing) {
            PairingState.Loading -> Text("Checking…")
            PairingState.NotPaired -> {
                Text("Not paired. Nothing is uploaded until this phone is paired with a server.")
                Button(onClick = onPair) { Text("Pair") }
            }
            is PairingState.Paired -> {
                Fact("Paired with", Format.host(pairing.url))
                Fact("Device id", pairing.deviceId)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = onPair) { Text("Pair again") }
                    TextButton(onClick = { confirmUnpair = true }) { Text("Unpair") }
                }
                if (unpairFailed) {
                    Text(
                        "The pairing could not be removed on this phone, so it is still paired and still " +
                            "uploading. Try again; if it keeps failing, restart the phone.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this phone?") },
            text = {
                Text(
                    "The app forgets the server and its token and stops uploading. Data already " +
                        "uploaded stays on the server until it is wiped there.",
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmUnpair = false
                        onUnpair()
                    },
                ) { Text("Unpair") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun SyncCard(state: SyncUiState, controller: SyncController) {
    val paired = state.pairing is PairingState.Paired
    val idle = state.activity == SyncActivity.IDLE
    val backfillDone = state.backfill.phase == BackfillPhase.COMPLETE
    var confirmAgain by remember { mutableStateOf(false) }
    Section("Sync") {
        Fact(
            "Status",
            when (state.activity) {
                SyncActivity.IDLE -> "Idle"
                SyncActivity.SYNCING -> "Syncing"
                SyncActivity.BACKFILLING ->
                    if ((state.lastError?.retryAtMs ?: 0) > System.currentTimeMillis()) {
                        "Backfilling, waiting to retry"
                    } else {
                        "Backfilling"
                    }
            },
        )
        Fact("Last sync", Format.dateTime(state.lastSyncMs))
        Fact("Waiting to upload", state.backlog.toString())
        Fact("Full backfill", Format.backfill(state.backfill))
        val total = state.backfill.totalUnits
        if (state.backfill.phase == BackfillPhase.RUNNING && total != null && total > 0) {
            LinearProgressIndicator(
                progress = { state.backfill.doneUnits.toFloat() / total },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        state.lastError?.let {
            Text(
                ErrorMessages.describe(it.errorCode),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                "${it.errorCode}, ${Format.dateTime(it.atMs)}" +
                    if (it.consecutiveFailures > 1) " (${it.consecutiveFailures} syncs in a row)" else "",
                style = MaterialTheme.typography.bodySmall,
            )
            Format.retryLine(it.errorCode, it.retryAtMs, System.currentTimeMillis())?.let { line ->
                Text(line, style = MaterialTheme.typography.bodyMedium)
            }
        }
        state.skipReason?.let {
            Text(
                "Background syncs are being skipped: ${ErrorMessages.describe(it.errorCode)}",
                style = MaterialTheme.typography.bodyMedium,
            )
            Text("${it.errorCode}, ${Format.dateTime(it.atMs)}", style = MaterialTheme.typography.bodySmall)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = controller::syncNow, enabled = paired && idle) { Text("Sync now") }
            // Always available: after a complete backfill it runs the whole thing again, which
            // is how the owner recovers when the server is missing something. That is hours of
            // re-uploading, so it is confirmed first.
            OutlinedButton(
                onClick = { if (backfillDone) confirmAgain = true else controller.startBackfill() },
                enabled = paired && idle,
            ) { Text(if (backfillDone) "Run full backfill again" else "Full backfill") }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Upload on Wi-Fi only")
            Switch(checked = state.wifiOnly, onCheckedChange = controller::setWifiOnly)
        }
    }
    if (confirmAgain) {
        ConfirmBackfillAgain(
            onConfirm = {
                confirmAgain = false
                controller.startBackfill()
            },
            onDismiss = { confirmAgain = false },
        )
    }
}

@Composable
private fun ConfirmBackfillAgain(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Run the full backfill again?") },
        text = {
            Text(
                "The whole history is read from Health Connect and uploaded again, newest month " +
                    "first. Nothing is duplicated on the server: each record replaces its earlier " +
                    "copy. It can take hours and uses data and battery, so it is best done on " +
                    "Wi-Fi and while charging.",
            )
        },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Run again") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun PermissionsCard(access: HealthAccess, onGrantAll: () -> Unit, onManage: () -> Unit) {
    Section("Health Connect permissions") {
        when (access.status) {
            HealthConnectStatus.UNAVAILABLE -> Text("Health Connect is not available on this phone.")
            HealthConnectStatus.UPDATE_REQUIRED -> Text("Health Connect needs an update before it can be read.")
            HealthConnectStatus.AVAILABLE -> {
                Fact("Record types", "${access.grantedTypes} of ${access.types.size} granted")
                Fact("Read in the background", Format.grant(access.backgroundRead))
                Fact("Read history older than 30 days", Format.grant(access.historyRead))
                Fact("Exercise routes", Format.grant(access.exerciseRoutes))
                Text(
                    "A type that is not granted is reported to the server as not permitted; " +
                        "it is never silently missing.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onGrantAll, enabled = access.anythingToGrant) { Text("Grant all") }
                    OutlinedButton(onClick = onManage) { Text("Open Health Connect") }
                }
            }
        }
    }
}

@Composable
private fun BackgroundCard(
    notificationsGranted: Boolean,
    batteryExempt: Boolean,
    hibernationExempt: Boolean,
    onExemptHibernation: () -> Unit,
    onAllowNotifications: () -> Unit,
    onExemptBattery: () -> Unit,
) {
    Section("Running in the background") {
        if (!batteryExempt) {
            Text(
                "Battery optimisation can delay or skip background syncs. Exempt this app so " +
                    "syncs run on schedule.",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = onExemptBattery) { Text("Exempt from battery optimisation") }
        }
        if (!hibernationExempt) {
            Text(
                "Android removes the permissions of an app that has not been opened for a few " +
                    "months, which would stop syncing without a word. Turn that off for this app.",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = onExemptHibernation) { Text("Keep permissions when unused") }
        }
        if (!notificationsGranted) {
            Text(
                "Notifications are how the app tells you that syncing keeps failing, and how " +
                    "it shows backfill progress.",
                style = MaterialTheme.typography.bodyMedium,
            )
            OutlinedButton(onClick = onAllowNotifications) { Text("Allow notifications") }
        }
    }
}

@Composable
private fun CoverageHeader() {
    Column {
        Text("Coverage by record type", style = MaterialTheme.typography.titleMedium)
        Row(modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            HeaderCell("Type", TYPE_WEIGHT)
            HeaderCell("First", DATE_WEIGHT)
            HeaderCell("Last", DATE_WEIGHT)
            HeaderCell("Uploaded", COUNT_WEIGHT, TextAlign.End)
        }
        HorizontalDivider()
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.HeaderCell(
    text: String,
    weight: Float,
    align: TextAlign = TextAlign.Start,
) {
    Text(
        text,
        modifier = Modifier.weight(weight),
        style = MaterialTheme.typography.labelMedium,
        textAlign = align,
    )
}

@Composable
private fun CoverageRow(row: TypeRow) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(modifier = Modifier.weight(TYPE_WEIGHT)) {
            Text(row.type, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // Records that did not arrive as themselves. Shown only when there are any, and
            // then for good: this is the lasting trace of them.
            Format.shortfall(row)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
            }
            Text(
                Format.grant(row.permission),
                style = MaterialTheme.typography.labelSmall,
                color = when (row.permission) {
                    Grant.GRANTED -> MaterialTheme.colorScheme.primary
                    Grant.DENIED -> MaterialTheme.colorScheme.error
                    Grant.UNAVAILABLE -> MaterialTheme.colorScheme.outline
                },
            )
        }
        Text(Format.date(row.firstMs), modifier = Modifier.weight(DATE_WEIGHT), style = MaterialTheme.typography.bodySmall)
        Text(Format.date(row.lastMs), modifier = Modifier.weight(DATE_WEIGHT), style = MaterialTheme.typography.bodySmall)
        Text(
            row.uploaded.toString(),
            modifier = Modifier.weight(COUNT_WEIGHT),
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun Footer(onPrivacy: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Version ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = onPrivacy) { Text("What this app does with your data") }
    }
}

private const val TYPE_WEIGHT = 2.2f
private const val DATE_WEIGHT = 1.3f
private const val COUNT_WEIGHT = 1f

private fun hasNotificationPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

/** This app's own page in Health Connect, falling back to Health Connect's front page. */
private fun openHealthPermissions(context: Context) {
    val own = Intent(HealthConnectManager.ACTION_MANAGE_HEALTH_PERMISSIONS)
        .putExtra(Intent.EXTRA_PACKAGE_NAME, context.packageName)
    try {
        context.startActivity(own)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            // No Health Connect settings on this phone; the card already says it is unavailable.
        }
    }
}

// BatteryLife: the direct exemption dialog is what a background sync app that is not
// distributed through Play is expected to use; the owner is asked, never forced.
@SuppressLint("BatteryLife")
private fun requestBatteryExemption(context: Context) {
    val direct = Intent(
        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
        Uri.fromParts("package", context.packageName, null),
    )
    try {
        context.startActivity(direct)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            // No battery settings screen on this phone; there is nothing to open.
        }
    }
}

/** The system screen where "remove permissions if app is unused" is switched off for this app. */
private fun requestHibernationExemption(context: Context) {
    val own = Intent(Intent.ACTION_AUTO_REVOKE_PERMISSIONS, Uri.fromParts("package", context.packageName, null))
    try {
        context.startActivity(own)
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
            )
        } catch (_: ActivityNotFoundException) {
            // No app settings screen on this phone; there is nothing to open.
        }
    }
}
