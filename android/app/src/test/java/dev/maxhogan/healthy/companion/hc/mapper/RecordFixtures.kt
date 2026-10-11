@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BasalBodyTemperatureRecord
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.BodyTemperatureMeasurementLocation
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.BodyWaterMassRecord
import androidx.health.connect.client.records.BoneMassRecord
import androidx.health.connect.client.records.CervicalMucusRecord
import androidx.health.connect.client.records.CyclingPedalingCadenceRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ElevationGainedRecord
import androidx.health.connect.client.records.ExerciseLap
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseSegment
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.IntermenstrualBleedingRecord
import androidx.health.connect.client.records.LeanBodyMassRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.MenstruationFlowRecord
import androidx.health.connect.client.records.MenstruationPeriodRecord
import androidx.health.connect.client.records.MindfulnessSessionRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.OvulationTestRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.PlannedExerciseBlock
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PlannedExerciseStep
import androidx.health.connect.client.records.ExerciseCompletionGoal
import androidx.health.connect.client.records.ExercisePerformanceTarget
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
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Percentage
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Pressure
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import androidx.health.connect.client.units.Velocity
import androidx.health.connect.client.units.Volume
import dev.maxhogan.healthy.companion.hc.mapper.Fx.ms
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T0
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T1
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T2
import java.time.Duration
import kotlinx.serialization.json.JsonObject

/** One record with every field populated and the exact `data` object it must produce. */
internal class Case(
    val type: String,
    val record: Record,
    val interval: Boolean,
    val dataJson: String,
) {
    val data: JsonObject get() = Fx.json(dataJson)
}

internal object RecordFixtures {
    private val m get() = Fx.meta()
    private val s0 = ms(T0)
    private val s1 = ms(T1)
    private val s2 = ms(T2)
    private val o1 = Fx.minus5h
    private val o2 = Fx.minus4h

    /** The 40 nutrient names and the gram value each is given (index + 1, in grams). */
    val nutrientNames =
        listOf(
            "biotin", "caffeine", "calcium", "chloride", "cholesterol", "chromium", "copper",
            "dietaryFiber", "folate", "folicAcid", "iodine", "iron", "magnesium", "manganese",
            "molybdenum", "monounsaturatedFat", "niacin", "pantothenicAcid", "phosphorus",
            "polyunsaturatedFat", "potassium", "protein", "riboflavin", "saturatedFat", "selenium",
            "sodium", "sugar", "thiamin", "totalCarbohydrate", "totalFat", "transFat",
            "unsaturatedFat", "vitaminA", "vitaminB12", "vitaminB6", "vitaminC", "vitaminD",
            "vitaminE", "vitaminK", "zinc",
        )

    private fun g(i: Int) = Mass.grams(i.toDouble())

    private fun nutrition() =
        NutritionRecord(
            startTime = s0, startZoneOffset = o1, endTime = s1, endZoneOffset = o2, metadata = m,
            biotin = g(1), caffeine = g(2), calcium = g(3), energy = Energy.kilojoules(418.4),
            energyFromFat = Energy.kilocalories(90.0), chloride = g(4), cholesterol = g(5),
            chromium = g(6), copper = g(7), dietaryFiber = g(8), folate = g(9), folicAcid = g(10),
            iodine = g(11), iron = g(12), magnesium = g(13), manganese = g(14), molybdenum = g(15),
            monounsaturatedFat = g(16), niacin = g(17), pantothenicAcid = g(18), phosphorus = g(19),
            polyunsaturatedFat = g(20), potassium = g(21), protein = g(22), riboflavin = g(23),
            saturatedFat = g(24), selenium = g(25), sodium = g(26), sugar = g(27), thiamin = g(28),
            totalCarbohydrate = g(29), totalFat = g(30), transFat = g(31), unsaturatedFat = g(32),
            vitaminA = g(33), vitaminB12 = g(34), vitaminB6 = g(35), vitaminC = g(36),
            vitaminD = g(37), vitaminE = g(38), vitaminK = g(39), zinc = g(40),
            name = "Example meal", mealType = MealType.MEAL_TYPE_LUNCH,
        )

    private fun nutritionJson(): String {
        val nutrients =
            nutrientNames.mapIndexed { i, n -> "\"$n\": ${i + 1}" }.joinToString(",\n")
        return """{"energy": 100, "energyFromFat": 90, "name": "Example meal",
            "mealType": "LUNCH", $nutrients}"""
    }

    private fun exerciseSession() =
        ExerciseSessionRecord(
            startTime = s0, startZoneOffset = o1, endTime = s2, endZoneOffset = o2, metadata = m,
            exerciseType = ExerciseSessionRecord.EXERCISE_TYPE_BIKING,
            title = "Morning ride", notes = "Felt fine",
            segments =
                listOf(
                    ExerciseSegment(
                        startTime = s0, endTime = s1,
                        segmentType = ExerciseSegment.EXERCISE_SEGMENT_TYPE_BIKING, repetitions = 0,
                    )
                ),
            laps = listOf(ExerciseLap(startTime = s0, endTime = s1, length = Length.miles(1.0))),
            exerciseRoute =
                ExerciseRoute(
                    listOf(
                        ExerciseRoute.Location(
                            time = s0, latitude = 10.5, longitude = 20.25,
                            horizontalAccuracy = Length.meters(5.0),
                            verticalAccuracy = Length.meters(6.0), altitude = Length.feet(100.0),
                        ),
                        ExerciseRoute.Location(time = s1, latitude = 10.5, longitude = 20.5),
                    )
                ),
            plannedExerciseSessionId = "plan-1",
        )

    /** The planned-session primary constructor is internal; this is the only way to set the id. */
    fun plannedSession(
        blocks: List<PlannedExerciseBlock>,
        completedId: String? = "done-1",
        explicit: Boolean = true,
    ): PlannedExerciseSessionRecord {
        val ctor =
            PlannedExerciseSessionRecord::class.java.declaredConstructors.first {
                it.parameterCount == 11 && it.parameterTypes[5] == Boolean::class.javaPrimitiveType
            }
        ctor.isAccessible = true
        return ctor.newInstance(
            s0, o1, s1, o2, m, explicit, ExerciseSessionRecord.EXERCISE_TYPE_BIKING, completedId,
            blocks, "Plan title", "Plan notes",
        ) as PlannedExerciseSessionRecord
    }

    fun plannedBlocks(): List<PlannedExerciseBlock> =
        listOf(
            PlannedExerciseBlock(
                repetitions = 2,
                description = "Main set",
                steps =
                    listOf(
                        PlannedExerciseStep(
                            exerciseType = ExerciseSegment.EXERCISE_SEGMENT_TYPE_BIKING,
                            exercisePhase = PlannedExerciseStep.EXERCISE_PHASE_ACTIVE,
                            completionGoal = ExerciseCompletionGoal.DistanceGoal(Length.kilometers(5.0)),
                            performanceTargets =
                                listOf(
                                    ExercisePerformanceTarget.PowerTarget(
                                        Power.watts(100.0), Power.watts(200.0)
                                    ),
                                    ExercisePerformanceTarget.HeartRateTarget(120.0, 150.0),
                                ),
                            description = "Hard",
                        )
                    ),
            )
        )

    const val PLANNED_JSON =
        """{"hasExplicitTime": true, "exerciseType": "BIKING", "title": "Plan title",
          "notes": "Plan notes", "completedExerciseSessionId": "done-1",
          "blocks": [{"repetitions": 2, "description": "Main set", "steps": [
            {"exerciseType": "BIKING", "exercisePhase": "ACTIVE", "description": "Hard",
             "completionGoal": {"type": "DISTANCE", "distance": 5000},
             "performanceTargets": [
               {"type": "POWER", "minPower": 100, "maxPower": 200},
               {"type": "HEART_RATE", "minHeartRate": 120, "maxHeartRate": 150}]}]}]}"""

    /** One fully-populated record per library type, with the exact JSON `data` it must produce. */
    val all: List<Case> by lazy {
        listOf(
            Case("Steps", StepsRecord(s0, o1, s1, o2, 1234, m), true, """{"count": 1234}"""),
            Case(
                "Distance", DistanceRecord(s0, o1, s1, o2, Length.meters(1500.5), m), true,
                """{"distance": 1500.5}""",
            ),
            Case(
                "ActiveCaloriesBurned",
                ActiveCaloriesBurnedRecord(s0, o1, s1, o2, Energy.kilocalories(250.5), m), true,
                """{"energy": 250.5}""",
            ),
            Case(
                "TotalCaloriesBurned",
                TotalCaloriesBurnedRecord(s0, o1, s1, o2, Energy.kilocalories(2100.0), m), true,
                """{"energy": 2100}""",
            ),
            Case(
                "FloorsClimbed", FloorsClimbedRecord(s0, o1, s1, o2, 4.5, m), true,
                """{"floors": 4.5}""",
            ),
            Case(
                "ElevationGained", ElevationGainedRecord(s0, o1, s1, o2, Length.meters(12.5), m),
                true, """{"elevation": 12.5}""",
            ),
            Case(
                "WheelchairPushes", WheelchairPushesRecord(s0, o1, s1, o2, 80, m), true,
                """{"count": 80}""",
            ),
            Case(
                "Hydration", HydrationRecord(s0, o1, s1, o2, Volume.liters(0.5), m), true,
                """{"volume": 0.5}""",
            ),
            Case(
                "HeartRate",
                HeartRateRecord(
                    s0, o1, s2, o2,
                    listOf(HeartRateRecord.Sample(s0, 60), HeartRateRecord.Sample(s1, 64)), m,
                ),
                true,
                """{"samples": [{"t": $T0, "bpm": 60}, {"t": $T1, "bpm": 64}]}""",
            ),
            Case(
                "Speed",
                SpeedRecord(
                    s0, o1, s2, o2, listOf(SpeedRecord.Sample(s0, Velocity.metersPerSecond(2.5))), m
                ),
                true, """{"samples": [{"t": $T0, "speed": 2.5}]}""",
            ),
            Case(
                "Power",
                PowerRecord(s0, o1, s2, o2, listOf(PowerRecord.Sample(s0, Power.watts(200.0))), m),
                true, """{"samples": [{"t": $T0, "power": 200}]}""",
            ),
            Case(
                "StepsCadence",
                StepsCadenceRecord(s0, o1, s2, o2, listOf(StepsCadenceRecord.Sample(s0, 90.0)), m),
                true, """{"samples": [{"t": $T0, "rate": 90}]}""",
            ),
            Case(
                "CyclingPedalingCadence",
                CyclingPedalingCadenceRecord(
                    s0, o1, s2, o2, listOf(CyclingPedalingCadenceRecord.Sample(s0, 80.5)), m
                ),
                true, """{"samples": [{"t": $T0, "rate": 80.5}]}""",
            ),
            Case("RestingHeartRate", RestingHeartRateRecord(s0, o1, 52, m), false, """{"bpm": 52}"""),
            Case(
                "HeartRateVariabilityRmssd", HeartRateVariabilityRmssdRecord(s0, o1, 45.5, m),
                false, """{"rmssd": 45.5}""",
            ),
            Case("RespiratoryRate", RespiratoryRateRecord(s0, o1, 14.5, m), false, """{"rate": 14.5}"""),
            Case(
                "OxygenSaturation", OxygenSaturationRecord(s0, o1, Percentage(97.5), m), false,
                """{"percentage": 97.5}""",
            ),
            Case(
                "BloodPressure",
                BloodPressureRecord(
                    s0, o1, m, Pressure.millimetersOfMercury(120.0),
                    Pressure.millimetersOfMercury(80.0),
                    BloodPressureRecord.BODY_POSITION_SITTING_DOWN,
                    BloodPressureRecord.MEASUREMENT_LOCATION_LEFT_UPPER_ARM,
                ),
                false,
                """{"systolic": 120, "diastolic": 80, "bodyPosition": "SITTING_DOWN",
                    "measurementLocation": "LEFT_UPPER_ARM"}""",
            ),
            Case(
                "BloodGlucose",
                BloodGlucoseRecord(
                    s0, o1, m, BloodGlucose.millimolesPerLiter(5.5),
                    BloodGlucoseRecord.SPECIMEN_SOURCE_CAPILLARY_BLOOD, MealType.MEAL_TYPE_LUNCH,
                    BloodGlucoseRecord.RELATION_TO_MEAL_AFTER_MEAL,
                ),
                false,
                """{"level": 5.5, "specimenSource": "CAPILLARY_BLOOD", "mealType": "LUNCH",
                    "relationToMeal": "AFTER_MEAL"}""",
            ),
            Case(
                "BodyTemperature",
                BodyTemperatureRecord(
                    s0, o1, m, Temperature.celsius(36.6),
                    BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_MOUTH,
                ),
                false, """{"temperature": 36.6, "measurementLocation": "MOUTH"}""",
            ),
            Case(
                "BasalBodyTemperature",
                BasalBodyTemperatureRecord(
                    s0, o1, m, Temperature.celsius(36.4),
                    BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_FINGER,
                ),
                false, """{"temperature": 36.4, "measurementLocation": "FINGER"}""",
            ),
            Case(
                "SkinTemperature",
                SkinTemperatureRecord(
                    s0, o1, s2, o2, m,
                    listOf(
                        SkinTemperatureRecord.Delta(s0, TemperatureDelta.celsius(-0.5)),
                        SkinTemperatureRecord.Delta(s1, TemperatureDelta.celsius(0.25)),
                    ),
                    Temperature.celsius(33.0), SkinTemperatureRecord.MEASUREMENT_LOCATION_WRIST,
                ),
                true,
                """{"baseline": 33, "measurementLocation": "WRIST",
                    "deltas": [{"t": $T0, "delta": -0.5}, {"t": $T1, "delta": 0.25}]}""",
            ),
            Case("Weight", WeightRecord(s0, o1, Mass.kilograms(70.5), m), false, """{"weight": 70.5}"""),
            Case("Height", HeightRecord(s0, o1, Length.meters(1.8), m), false, """{"height": 1.8}"""),
            Case("BodyFat", BodyFatRecord(s0, o1, Percentage(20.5), m), false, """{"percentage": 20.5}"""),
            Case("LeanBodyMass", LeanBodyMassRecord(s0, o1, Mass.kilograms(55.0), m), false, """{"mass": 55}"""),
            Case("BoneMass", BoneMassRecord(s0, o1, Mass.kilograms(3.0), m), false, """{"mass": 3}"""),
            Case("BodyWaterMass", BodyWaterMassRecord(s0, o1, Mass.kilograms(40.0), m), false, """{"mass": 40}"""),
            Case(
                "BasalMetabolicRate",
                BasalMetabolicRateRecord(s0, o1, Power.kilocaloriesPerDay(1700.0), m), false,
                """{"bmr": 1700}""",
            ),
            Case(
                "Vo2Max",
                Vo2MaxRecord(s0, o1, m, 45.5, Vo2MaxRecord.MEASUREMENT_METHOD_COOPER_TEST), false,
                """{"vo2": 45.5, "measurementMethod": "COOPER_TEST"}""",
            ),
            Case("Nutrition", nutrition(), true, nutritionJson()),
            Case(
                "SleepSession",
                SleepSessionRecord(
                    s0, o1, s2, o2, m, "Night", "Slept ok",
                    listOf(
                        SleepSessionRecord.Stage(s0, s1, SleepSessionRecord.STAGE_TYPE_DEEP),
                        SleepSessionRecord.Stage(s1, s2, SleepSessionRecord.STAGE_TYPE_REM),
                    ),
                ),
                true,
                """{"title": "Night", "notes": "Slept ok", "stages": [
                    {"start": $T0, "end": $T1, "stage": "DEEP"},
                    {"start": $T1, "end": $T2, "stage": "REM"}]}""",
            ),
            Case(
                "ExerciseSession", exerciseSession(), true,
                """{"exerciseType": "BIKING", "title": "Morning ride", "notes": "Felt fine",
                  "segments": [{"start": $T0, "end": $T1, "segmentType": "BIKING", "repetitions": 0}],
                  "laps": [{"start": $T0, "end": $T1, "length": 1609.34}],
                  "route": [
                    {"t": $T0, "lat": 10.5, "lon": 20.25, "alt": 30.48, "hAcc": 5, "vAcc": 6},
                    {"t": $T1, "lat": 10.5, "lon": 20.5}],
                  "plannedExerciseSessionId": "plan-1"}""",
            ),
            Case("PlannedExerciseSession", plannedSession(plannedBlocks()), true, PLANNED_JSON),
            Case(
                "MindfulnessSession",
                MindfulnessSessionRecord(
                    s0, o1, s1, o2, m, MindfulnessSessionRecord.MINDFULNESS_SESSION_TYPE_MEDITATION,
                    "Sit", "Quiet",
                ),
                true,
                """{"mindfulnessSessionType": "MEDITATION", "title": "Sit", "notes": "Quiet"}""",
            ),
            Case(
                "MenstruationFlow",
                MenstruationFlowRecord(s0, o1, m, MenstruationFlowRecord.FLOW_MEDIUM), false,
                """{"flow": "MEDIUM"}""",
            ),
            Case("MenstruationPeriod", MenstruationPeriodRecord(s0, o1, s1, o2, m), true, "{}"),
            Case(
                "CervicalMucus",
                CervicalMucusRecord(
                    s0, o1, m, CervicalMucusRecord.APPEARANCE_EGG_WHITE,
                    CervicalMucusRecord.SENSATION_LIGHT,
                ),
                false, """{"appearance": "EGG_WHITE", "sensation": "LIGHT"}""",
            ),
            Case(
                "OvulationTest",
                OvulationTestRecord(s0, o1, OvulationTestRecord.RESULT_POSITIVE, m), false,
                """{"result": "POSITIVE"}""",
            ),
            Case("IntermenstrualBleeding", IntermenstrualBleedingRecord(s0, o1, m), false, "{}"),
            Case(
                "SexualActivity",
                SexualActivityRecord(s0, o1, m, SexualActivityRecord.PROTECTION_USED_PROTECTED),
                false, """{"protectionUsed": "PROTECTED"}""",
            ),
        )
    }

    /** Duration helper for tests that want one. */
    val oneMinute: Duration = Duration.ofMinutes(1)
}
