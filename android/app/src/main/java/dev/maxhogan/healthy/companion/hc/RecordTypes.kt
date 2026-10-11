package dev.maxhogan.healthy.companion.hc

import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SexualActivityRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsCadenceRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.WheelchairPushesRecord
import kotlin.reflect.KClass

/**
 * Every concrete Health Connect record type the client library knows.
 *
 * This list is the single registry the manifest, the permission request, the status screen and
 * the sync engine all read. It is not hand-picked: `RecordTypesTest` scans the library's own jar
 * and fails when a class implementing [Record] is missing here, and a second test fails when the
 * manifest's `READ_*` permissions differ from the ones this list maps to. Bumping the library
 * therefore breaks the build until a new type is added in both places.
 */
object RecordTypes {
    val ALL: List<KClass<out Record>> = listOf(
        ActiveCaloriesBurnedRecord::class,
        BasalBodyTemperatureRecord::class,
        BasalMetabolicRateRecord::class,
        BloodGlucoseRecord::class,
        BloodPressureRecord::class,
        BodyFatRecord::class,
        BodyTemperatureRecord::class,
        BodyWaterMassRecord::class,
        BoneMassRecord::class,
        CervicalMucusRecord::class,
        CyclingPedalingCadenceRecord::class,
        DistanceRecord::class,
        ElevationGainedRecord::class,
        ExerciseSessionRecord::class,
        FloorsClimbedRecord::class,
        HeartRateRecord::class,
        HeartRateVariabilityRmssdRecord::class,
        HeightRecord::class,
        HydrationRecord::class,
        IntermenstrualBleedingRecord::class,
        LeanBodyMassRecord::class,
        MenstruationFlowRecord::class,
        MenstruationPeriodRecord::class,
        MindfulnessSessionRecord::class,
        NutritionRecord::class,
        OvulationTestRecord::class,
        OxygenSaturationRecord::class,
        PlannedExerciseSessionRecord::class,
        PowerRecord::class,
        RespiratoryRateRecord::class,
        RestingHeartRateRecord::class,
        SexualActivityRecord::class,
        SkinTemperatureRecord::class,
        SleepSessionRecord::class,
        SpeedRecord::class,
        StepsCadenceRecord::class,
        StepsRecord::class,
        TotalCaloriesBurnedRecord::class,
        Vo2MaxRecord::class,
        WeightRecord::class,
        WheelchairPushesRecord::class,
    )

    /** The wire name of a record type: the class's simple name without the `Record` suffix. */
    fun typeName(type: KClass<out Record>): String = type.java.simpleName.removeSuffix("Record")

    /** The `android.permission.health.READ_*` permission that gates [type]. Several types share one. */
    fun readPermission(type: KClass<out Record>): String = HealthPermission.getReadPermission(type)

    /** The distinct read permissions of every type in [ALL]. */
    val READ_PERMISSIONS: Set<String> by lazy { ALL.mapTo(LinkedHashSet()) { readPermission(it) } }

    /**
     * Lets the app read exercise routes written by other apps without a per-route consent
     * dialog. A platform permission the client library has no constant for; without it a route
     * comes back as "consent required" and the upload would silently lack it.
     */
    const val READ_EXERCISE_ROUTES = "android.permission.health.READ_EXERCISE_ROUTES"

    /**
     * The Health Connect feature a type depends on, or null when every Health Connect version
     * has it. A type whose feature is unavailable is reported as "unavailable", never as denied.
     */
    fun requiredFeature(type: KClass<out Record>): Int? = when (type) {
        SkinTemperatureRecord::class -> HealthConnectFeatures.FEATURE_SKIN_TEMPERATURE
        PlannedExerciseSessionRecord::class -> HealthConnectFeatures.FEATURE_PLANNED_EXERCISE
        MindfulnessSessionRecord::class -> HealthConnectFeatures.FEATURE_MINDFULNESS_SESSION
        else -> null
    }
}
