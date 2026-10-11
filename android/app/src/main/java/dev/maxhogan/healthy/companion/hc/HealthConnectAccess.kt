package dev.maxhogan.healthy.companion.hc

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import kotlin.coroutines.cancellation.CancellationException

/** Whether one thing the app wants from Health Connect is allowed. Matches the wire's `permission`. */
enum class Grant {
    GRANTED,

    /** Health Connect offers it and the owner has not allowed it. */
    DENIED,

    /** This phone's Health Connect does not have it at all; nothing the owner can tap fixes that. */
    UNAVAILABLE,
}

enum class HealthConnectStatus { AVAILABLE, UPDATE_REQUIRED, UNAVAILABLE }

/**
 * What Health Connect currently lets the app read, by wire type name ([RecordTypes.typeName]).
 * [types] always holds every type in [RecordTypes.ALL], so a type that is not permitted is
 * reported as such instead of being absent.
 */
data class HealthAccess(
    val status: HealthConnectStatus,
    val types: Map<String, Grant>,
    val backgroundRead: Grant,
    val historyRead: Grant,
    val exerciseRoutes: Grant,
) {
    val grantedTypes: Int get() = types.values.count { it == Grant.GRANTED }

    /**
     * True when there is something left that the permission dialog could still grant. Exercise
     * routes are left out: the dialog does not offer them alongside "Allow all", so counting
     * them would leave the button enabled for ever. They are granted from Health Connect's
     * own page for this app.
     */
    val anythingToGrant: Boolean
        get() = status == HealthConnectStatus.AVAILABLE &&
            (types.values + backgroundRead + historyRead).any { it == Grant.DENIED }

    companion object {
        /** Before Health Connect has answered, and whenever it cannot: nothing is readable. */
        fun none(status: HealthConnectStatus): HealthAccess = derive(status, emptySet()) { false }

        /**
         * Pure mapping from the granted permission strings and feature availability to per-type
         * grants. Kept free of Android types so it is unit-tested on the JVM.
         */
        fun derive(
            status: HealthConnectStatus,
            granted: Set<String>,
            featureAvailable: (Int) -> Boolean,
        ): HealthAccess {
            fun grant(permission: String, feature: Int?): Grant = when {
                status != HealthConnectStatus.AVAILABLE -> Grant.UNAVAILABLE
                feature != null && !featureAvailable(feature) -> Grant.UNAVAILABLE
                permission in granted -> Grant.GRANTED
                else -> Grant.DENIED
            }
            return HealthAccess(
                status = status,
                types = RecordTypes.ALL.associate {
                    RecordTypes.typeName(it) to
                        grant(RecordTypes.readPermission(it), RecordTypes.requiredFeature(it))
                },
                backgroundRead = grant(
                    HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
                    HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
                ),
                historyRead = grant(
                    HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
                    HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY,
                ),
                exerciseRoutes = grant(RecordTypes.READ_EXERCISE_ROUTES, null),
            )
        }

        /**
         * Everything the "Grant all" button asks for: one read permission per available type,
         * plus background read, history read and exercise routes where the phone has them.
         */
        fun requestable(featureAvailable: (Int) -> Boolean): Set<String> = buildSet {
            for (type in RecordTypes.ALL) {
                val feature = RecordTypes.requiredFeature(type)
                if (feature == null || featureAvailable(feature)) add(RecordTypes.readPermission(type))
            }
            if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND)) {
                add(HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND)
            }
            if (featureAvailable(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY)) {
                add(HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY)
            }
            add(RecordTypes.READ_EXERCISE_ROUTES)
        }
    }
}

/**
 * The app's one doorway to Health Connect's client object and its permission state. The UI and
 * the sync engine share this instance, so they can never disagree about what is granted.
 */
class HealthConnectAccess(private val context: Context) {
    fun status(): HealthConnectStatus = when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> HealthConnectStatus.AVAILABLE
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> HealthConnectStatus.UPDATE_REQUIRED
        else -> HealthConnectStatus.UNAVAILABLE
    }

    /** The client, or null when Health Connect is not usable on this phone right now. */
    fun clientOrNull(): HealthConnectClient? =
        if (status() == HealthConnectStatus.AVAILABLE) HealthConnectClient.getOrCreate(context) else null

    /** The permission set to hand to the Health Connect permission contract. */
    fun requestablePermissions(): Set<String> {
        val client = clientOrNull() ?: return emptySet()
        return HealthAccess.requestable(client.features::isAvailable)
    }

    /** Reads the current grants. Never throws: a Health Connect failure reads as "unavailable". */
    suspend fun read(): HealthAccess = readOrNull() ?: HealthAccess.none(HealthConnectStatus.UNAVAILABLE)

    /**
     * Reads the current grants, or null when Health Connect is present but would not answer.
     *
     * The difference matters to the sync engine. "Not installed" is a fact worth reporting;
     * "did not answer" is not knowing, and a sync that went ahead on it would read nothing,
     * call that a success, and tell the server every type had become unavailable.
     */
    suspend fun readOrNull(): HealthAccess? {
        val status = status()
        val client = clientOrNull() ?: return HealthAccess.none(status)
        return try {
            val granted = client.permissionController.getGrantedPermissions()
            HealthAccess.derive(status, granted, client.features::isAvailable)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The platform service can be mid-update or briefly unbound; the next refresh retries.
            null
        }
    }
}

private fun HealthConnectFeatures.isAvailable(feature: Int): Boolean =
    getFeatureStatus(feature) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
