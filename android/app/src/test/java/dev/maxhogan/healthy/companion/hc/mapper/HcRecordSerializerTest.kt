@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
import androidx.health.connect.client.records.BasalMetabolicRateRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BodyTemperatureMeasurementLocation
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseCompletionGoal
import androidx.health.connect.client.records.ExercisePerformanceTarget
import androidx.health.connect.client.records.ExerciseRoute
import androidx.health.connect.client.records.ExerciseSegment
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.PlannedExerciseBlock
import androidx.health.connect.client.records.PlannedExerciseStep
import androidx.health.connect.client.records.PowerRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SkinTemperatureRecord
import androidx.health.connect.client.records.SpeedRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.records.metadata.Device
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.BloodGlucose
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Length
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Power
import androidx.health.connect.client.units.Temperature
import androidx.health.connect.client.units.TemperatureDelta
import androidx.health.connect.client.units.Velocity
import androidx.health.connect.client.units.Volume
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T0
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T1
import dev.maxhogan.healthy.companion.hc.mapper.Fx.T2
import dev.maxhogan.healthy.companion.hc.mapper.Fx.ms
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HcRecordSerializerTest {
    private val serializer = HcRecordSerializer()

    private fun recSerializer(f: (androidx.health.connect.client.records.Record) -> JsonObject) =
        object : RecordSerializer {
            override fun serialize(record: androidx.health.connect.client.records.Record) = f(record)
        }

    private fun envelope(case: Case): String {
        val timing =
            if (case.interval) {
                """"start": $T0, "end": ${if (case.type in SERIES_LIKE) T2 else T1},
                   "startOffsetMin": -300, "endOffsetMin": -240"""
            } else {
                """"time": $T0, "offsetMin": -300"""
            }
        return """{"id": "rec-1", "type": "${case.type}", "origin": "com.example.wearable",
            "device": {"type": "WATCH", "manufacturer": "Example Co", "model": "Model 1"},
            "recordingMethod": "AUTOMATICALLY_RECORDED", "lastModified": ${Fx.MODIFIED},
            "clientRecordId": "client-1", "clientRecordVersion": 3,
            $timing, "data": ${case.dataJson}}"""
    }

    @Test
    fun everyTypeSerializesToExactlyTheExpectedJson() {
        for (case in RecordFixtures.all) {
            val actual = serializer.serialize(case.record)
            Fx.assertJson(Fx.json(envelope(case)), actual, case.type)
        }
    }

    @Test
    fun typeNameIsTheClassNameWithoutTheRecordSuffixAndFixturesCoverEveryMapper() {
        for (case in RecordFixtures.all) {
            assertEquals(case.record.javaClass.simpleName.removeSuffix("Record"), case.type)
            assertEquals(case.type, serializer.serialize(case.record)["type"]?.let { (it as JsonPrimitive).content })
        }
        assertEquals(
            HcRecordSerializer.mappedTypeNames().sorted(),
            RecordFixtures.all.map { it.type }.sorted(),
        )
    }

    @Test
    fun noRecordFallsThroughToTheReflectionFallbackWhenAMapperExists() {
        val failing = HcRecordSerializer(fallback = recSerializer { error("fallback used") })
        for (case in RecordFixtures.all) failing.serialize(case.record)
    }

    // --- design section 7: every named field is emitted ---------------------------------------

    private val sectionSeven: Map<String, Set<String>> =
        mapOf(
            "Steps" to setOf("count"),
            "Distance" to setOf("distance"),
            "ActiveCaloriesBurned" to setOf("energy"),
            "TotalCaloriesBurned" to setOf("energy"),
            "FloorsClimbed" to setOf("floors"),
            "ElevationGained" to setOf("elevation"),
            "HeartRate" to setOf("samples"),
            "RestingHeartRate" to setOf("bpm"),
            "HeartRateVariabilityRmssd" to setOf("rmssd"),
            "RespiratoryRate" to setOf("rate"),
            "OxygenSaturation" to setOf("percentage"),
            "BloodPressure" to setOf("systolic", "diastolic", "bodyPosition", "measurementLocation"),
            "Weight" to setOf("weight"),
            "Height" to setOf("height"),
            "BasalMetabolicRate" to setOf("bmr"),
            "SkinTemperature" to setOf("baseline", "measurementLocation", "deltas"),
            "Speed" to setOf("samples"),
            "Power" to setOf("samples"),
            "StepsCadence" to setOf("samples"),
            "CyclingPedalingCadence" to setOf("samples"),
            "Hydration" to setOf("volume"),
            "Nutrition" to
                setOf("energy", "name", "mealType", "protein", "totalFat", "totalCarbohydrate", "caffeine"),
            "BodyFat" to setOf("percentage"),
            "BodyTemperature" to setOf("temperature", "measurementLocation"),
            "BasalBodyTemperature" to setOf("temperature", "measurementLocation"),
            "BloodGlucose" to setOf("level", "specimenSource", "mealType", "relationToMeal"),
            "Vo2Max" to setOf("vo2", "measurementMethod"),
            "LeanBodyMass" to setOf("mass"),
            "BoneMass" to setOf("mass"),
            "BodyWaterMass" to setOf("mass"),
            "WheelchairPushes" to setOf("count"),
            "SleepSession" to setOf("title", "notes", "stages"),
            "ExerciseSession" to
                setOf(
                    "exerciseType", "title", "notes", "segments", "laps", "route",
                    "plannedExerciseSessionId",
                ),
            "MenstruationFlow" to setOf("flow"),
            "MenstruationPeriod" to emptySet(),
            "CervicalMucus" to setOf("appearance", "sensation"),
            "OvulationTest" to setOf("result"),
            "IntermenstrualBleeding" to emptySet(),
            "SexualActivity" to setOf("protectionUsed"),
            "MindfulnessSession" to setOf("mindfulnessSessionType", "title", "notes"),
            "PlannedExerciseSession" to
                setOf("exerciseType", "title", "notes", "blocks", "completedExerciseSessionId"),
        )

    /** Nested element field names from section 7 / section 2. */
    private val nested: List<Triple<String, String, Set<String>>> =
        listOf(
            Triple("HeartRate", "samples", setOf("t", "bpm")),
            Triple("Speed", "samples", setOf("t", "speed")),
            Triple("Power", "samples", setOf("t", "power")),
            Triple("StepsCadence", "samples", setOf("t", "rate")),
            Triple("CyclingPedalingCadence", "samples", setOf("t", "rate")),
            Triple("SkinTemperature", "deltas", setOf("t", "delta")),
            Triple("SleepSession", "stages", setOf("start", "end", "stage")),
            Triple("ExerciseSession", "segments", setOf("start", "end", "segmentType", "repetitions")),
            Triple("ExerciseSession", "laps", setOf("start", "end", "length")),
            Triple("ExerciseSession", "route", setOf("t", "lat", "lon", "alt", "hAcc", "vAcc")),
        )

    @Test
    fun everyFieldNameInDesignSectionSevenIsEmittedForItsType() {
        val byType = RecordFixtures.all.associateBy { it.type }
        for ((type, fields) in sectionSeven) {
            val case = byType[type] ?: error("no fixture for $type")
            val data = serializer.serialize(case.record)["data"]!!.jsonObject
            for (f in fields) assertTrue("$type.data.$f missing; has ${data.keys}", f in data)
        }
        // The section-7 table must itself name every type that has a mapper.
        assertEquals(byType.keys, sectionSeven.keys)
        for ((type, field, keys) in nested) {
            val data = serializer.serialize(byType.getValue(type).record)["data"]!!.jsonObject
            val first = data.getValue(field).jsonArray.first().jsonObject
            assertTrue("$type.$field[0] has ${first.keys}", first.keys.containsAll(keys))
        }
    }

    // --- units --------------------------------------------------------------------------------

    private fun data(record: androidx.health.connect.client.records.Record): JsonObject =
        serializer.serialize(record)["data"]!!.jsonObject

    private fun JsonObject.d(k: String): Double = (getValue(k) as JsonPrimitive).doubleOrNull!!

    private val s0 = ms(T0)
    private val s1 = ms(T1)
    private val o = Fx.minus5h
    private val m get() = Fx.meta()

    @Test
    fun unitsAreNormalisedToTheWireUnits() {
        // Mass in pounds, length in feet, energy in kJ, temperature in Fahrenheit, mg/dL.
        assertEquals(100.0 * 0.45359237, data(WeightRecord(s0, o, Mass.pounds(100.0), m)).d("weight"), 1e-6)
        assertEquals(6.0 * 0.3048, data(HeightRecord(s0, o, Length.feet(6.0), m)).d("height"), 1e-6)
        assertEquals(
            5.0 * 1609.34, data(DistanceRecord(s0, o, s1, o, Length.miles(5.0), m)).d("distance"), 1e-6, // the library's own miles factor
        )
        assertEquals(
            100.0,
            data(androidx.health.connect.client.records.ActiveCaloriesBurnedRecord(s0, o, s1, o, Energy.kilojoules(418.4), m)).d("energy"),
            1e-6,
        )
        assertEquals(
            98.6.let { (it - 32) * 5 / 9 },
            data(BodyTemperatureRecord(s0, o, m, Temperature.fahrenheit(98.6),
                BodyTemperatureMeasurementLocation.MEASUREMENT_LOCATION_MOUTH)).d("temperature"),
            1e-6,
        )
        assertEquals(
            99.0 / 18.0,
            data(BloodGlucoseRecord(s0, o, m, BloodGlucose.milligramsPerDeciliter(99.0),
                BloodGlucoseRecord.SPECIMEN_SOURCE_PLASMA, 0, 0)).d("level"),
            1e-3,
        )
        assertEquals(
            0.355, data(HydrationRecord(s0, o, s1, o, Volume.milliliters(355.0), m)).d("volume"), 1e-6,
        )
        assertEquals(
            1700.0,
            data(BasalMetabolicRateRecord(s0, o, Power.kilocaloriesPerDay(1700.0), m)).d("bmr"), 1e-6,
        )
        val speed = data(SpeedRecord(s0, o, s1, o, listOf(SpeedRecord.Sample(s0, Velocity.kilometersPerHour(36.0))), m))
        assertEquals(10.0, speed.getValue("samples").jsonArray[0].jsonObject.d("speed"), 1e-6)
        val delta = data(SkinTemperatureRecord(s0, o, s1, o, m,
            listOf(SkinTemperatureRecord.Delta(s0, TemperatureDelta.fahrenheit(1.8))),
            Temperature.fahrenheit(95.0), SkinTemperatureRecord.MEASUREMENT_LOCATION_WRIST))
        assertEquals(1.0, delta.getValue("deltas").jsonArray[0].jsonObject.d("delta"), 1e-6)
        assertEquals(35.0, delta.d("baseline"), 1e-6)
        val food = data(NutritionRecord(s0, o, s1, o, m, caffeine = Mass.milligrams(95.0),
            sodium = Mass.ounces(1.0), vitaminD = Mass.micrograms(15.0)))
        assertEquals(0.095, food.d("caffeine"), 1e-12)
        assertEquals(28.34952, food.d("sodium"), 1e-5) // the library's own ounce factor
        assertEquals(0.000015, food.d("vitaminD"), 1e-15)
        assertFalse("absent nutrients are omitted", "protein" in food)
        assertFalse("absent energy is omitted", "energy" in food)
    }

    @Test
    fun numbersAreJsonNumbersNeverStrings() {
        val d = data(StepsRecord(s0, o, s1, o, 7, m))
        assertFalse((d.getValue("count") as JsonPrimitive).isString)
        val env = serializer.serialize(StepsRecord(s0, o, s1, o, 7, m))
        assertFalse((env.getValue("start") as JsonPrimitive).isString)
        assertFalse((env.getValue("lastModified") as JsonPrimitive).isString)
    }

    // --- envelope edge cases ----------------------------------------------------------------

    @Test
    fun nullOffsetsBecomeJsonNull() {
        val interval = serializer.serialize(StepsRecord(s0, null, s1, null, 5, m))
        assertEquals(JsonNull, interval["startOffsetMin"])
        assertEquals(JsonNull, interval["endOffsetMin"])
        assertTrue("startOffsetMin" in interval)
        val point = serializer.serialize(RestingHeartRateRecord(s0, null, 50, m))
        assertEquals(JsonNull, point["offsetMin"])
        assertTrue("offsetMin" in point)
        // Half-hour and negative offsets are whole minutes.
        val odd = serializer.serialize(RestingHeartRateRecord(s0, java.time.ZoneOffset.ofHoursMinutes(5, 30), 50, m))
        assertEquals(330, (odd.getValue("offsetMin") as JsonPrimitive).content.toInt())
    }

    @Test
    fun missingDeviceAndClientIdAreOmitted() {
        val md = Fx.meta(device = null, clientId = null, clientVersion = 0)
        val out = serializer.serialize(StepsRecord(s0, o, s1, o, 5, md))
        assertFalse("device" in out)
        assertFalse("clientRecordId" in out)
        assertFalse("clientRecordVersion" in out)
        assertEquals("AUTOMATICALLY_RECORDED", (out["recordingMethod"] as JsonPrimitive).content)
    }

    @Test
    fun deviceWithOnlyATypeEmitsOnlyTheType() {
        val md = Fx.meta(device = Device(Device.TYPE_SCALE))
        val dev = serializer.serialize(StepsRecord(s0, o, s1, o, 5, md))["device"]!!.jsonObject
        assertEquals(setOf("type"), dev.keys)
        assertEquals("SCALE", (dev.getValue("type") as JsonPrimitive).content)
    }

    @Test
    fun recordingMethodsRenderAsNames() {
        val expected =
            mapOf(
                Metadata.RECORDING_METHOD_UNKNOWN to "UNKNOWN",
                Metadata.RECORDING_METHOD_ACTIVELY_RECORDED to "ACTIVELY_RECORDED",
                Metadata.RECORDING_METHOD_AUTOMATICALLY_RECORDED to "AUTOMATICALLY_RECORDED",
                Metadata.RECORDING_METHOD_MANUAL_ENTRY to "MANUAL_ENTRY",
            )
        for ((n, name) in expected) {
            val out = serializer.serialize(StepsRecord(s0, o, s1, o, 5, Fx.meta(method = n)))
            assertEquals(name, (out["recordingMethod"] as JsonPrimitive).content)
        }
    }

    @Test
    fun unknownEnumIntsRenderAsUnknownUnderscoreNAndNeverThrow() {
        val bp = data(androidx.health.connect.client.records.BloodPressureRecord(
            s0, o, m,
            androidx.health.connect.client.units.Pressure.millimetersOfMercury(120.0),
            androidx.health.connect.client.units.Pressure.millimetersOfMercury(80.0), 99, 77))
        assertEquals("UNKNOWN_99", (bp.getValue("bodyPosition") as JsonPrimitive).content)
        assertEquals("UNKNOWN_77", (bp.getValue("measurementLocation") as JsonPrimitive).content)
        val dev = serializer.serialize(StepsRecord(s0, o, s1, o, 5, Fx.meta(device = Device(42, "x", "y"))))
        assertEquals("UNKNOWN_42", (dev["device"]!!.jsonObject.getValue("type") as JsonPrimitive).content)
        val rec = serializer.serialize(StepsRecord(s0, o, s1, o, 5, Fx.meta(method = 77)))
        assertEquals("UNKNOWN_77", (rec["recordingMethod"] as JsonPrimitive).content)
        assertEquals("UNKNOWN_123", EnumTables.name(EnumTables.exerciseType, 123))
        assertEquals("UNKNOWN", EnumTables.name(EnumTables.mealType, 0))
        assertEquals("OTHER_WORKOUT", EnumTables.name(EnumTables.exerciseType, ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT))
    }

    @Test
    fun everyEnumTableCoversEveryDistinctConstantItWasBuiltFrom() {
        // Spot-check the large tables against the constants they came from.
        assertEquals("WALKING", EnumTables.name(EnumTables.exerciseType, ExerciseSessionRecord.EXERCISE_TYPE_WALKING))
        assertEquals("DEEP", EnumTables.name(EnumTables.sleepStage, androidx.health.connect.client.records.SleepSessionRecord.STAGE_TYPE_DEEP))
        assertEquals("BIKING", EnumTables.name(EnumTables.segmentType, ExerciseSegment.EXERCISE_SEGMENT_TYPE_BIKING))
        for ((table, size) in listOf(EnumTables.exerciseType to 61, EnumTables.segmentType to 68)) {
            assertEquals(size, table.size)
            assertEquals("names are unique", table.size, table.values.toSet().size)
        }
    }

    // --- exercise route and planned sessions ----------------------------------------------------

    private fun session(result: ExerciseRoute?): ExerciseSessionRecord =
        ExerciseSessionRecord(
            s0, o, ms(T2), o, m, ExerciseSessionRecord.EXERCISE_TYPE_WALKING,
            exerciseRoute = result,
        )

    @Test
    fun noDataRouteEmitsRouteStateOnly() {
        val d = data(session(null))
        assertEquals("NO_DATA", (d.getValue("routeState") as JsonPrimitive).content)
        assertFalse("route" in d)
        assertEquals(JsonArray(emptyList()), d["segments"])
        assertEquals(JsonArray(emptyList()), d["laps"])
        assertFalse("title" in d)
        assertFalse("plannedExerciseSessionId" in d)
    }

    @Test
    fun consentRequiredRouteEmitsRouteState() {
        val ctor =
            ExerciseSessionRecord::class.java.declaredConstructors.first {
                it.parameterCount == 12 &&
                    it.parameterTypes[10] == androidx.health.connect.client.records.ExerciseRouteResult::class.java
            }
        ctor.isAccessible = true
        val rec =
            ctor.newInstance(
                s0, o, ms(T2), o, m, ExerciseSessionRecord.EXERCISE_TYPE_WALKING, null, null,
                emptyList<ExerciseSegment>(), emptyList<androidx.health.connect.client.records.ExerciseLap>(),
                androidx.health.connect.client.records.ExerciseRouteResult.ConsentRequired(), null,
            ) as ExerciseSessionRecord
        val d = data(rec)
        assertEquals("CONSENT_REQUIRED", (d.getValue("routeState") as JsonPrimitive).content)
        assertFalse("route" in d)
    }

    @Test
    fun dataRouteEmitsPointsWithOptionalAccuracies() {
        val d =
            data(
                session(
                    ExerciseRoute(listOf(ExerciseRoute.Location(time = s0, latitude = 1.0, longitude = 2.0)))
                )
            )
        assertFalse("routeState" in d)
        val p = d.getValue("route").jsonArray.single().jsonObject
        assertEquals(setOf("t", "lat", "lon"), p.keys)
    }

    @Test
    fun plannedSessionWithoutCompletedIdOmitsIt() {
        val d = data(RecordFixtures.plannedSession(RecordFixtures.plannedBlocks(), completedId = null))
        assertFalse("completedExerciseSessionId" in d)
    }

    @Test
    fun everyGoalAndTargetVariantSerializes() {
        val goals =
            listOf(
                ExerciseCompletionGoal.DistanceAndDurationGoal(Length.meters(100.0), java.time.Duration.ofSeconds(30)) to
                    """{"type":"DISTANCE_AND_DURATION","distance":100,"duration":30000}""",
                ExerciseCompletionGoal.StepsGoal(500) to """{"type":"STEPS","steps":500}""",
                ExerciseCompletionGoal.DurationGoal(java.time.Duration.ofMinutes(2)) to """{"type":"DURATION","duration":120000}""",
                ExerciseCompletionGoal.RepetitionsGoal(10) to """{"type":"REPETITIONS","repetitions":10}""",
                ExerciseCompletionGoal.TotalCaloriesBurnedGoal(Energy.kilocalories(300.0)) to """{"type":"TOTAL_CALORIES_BURNED","energy":300}""",
                ExerciseCompletionGoal.ActiveCaloriesBurnedGoal(Energy.kilocalories(200.0)) to """{"type":"ACTIVE_CALORIES_BURNED","energy":200}""",
                ExerciseCompletionGoal.UnknownGoal to """{"type":"UNKNOWN"}""",
                ExerciseCompletionGoal.ManualCompletion to """{"type":"MANUAL_COMPLETION"}""",
            )
        val targets =
            listOf(
                ExercisePerformanceTarget.SpeedTarget(Velocity.metersPerSecond(2.0), Velocity.metersPerSecond(3.0)) to
                    """{"type":"SPEED","minSpeed":2,"maxSpeed":3}""",
                ExercisePerformanceTarget.CadenceTarget(70.0, 90.0) to """{"type":"CADENCE","minCadence":70,"maxCadence":90}""",
                ExercisePerformanceTarget.WeightTarget(Mass.pounds(10.0)) to """{"type":"WEIGHT","mass":4.5359237}""",
                ExercisePerformanceTarget.RateOfPerceivedExertionTarget(7) to """{"type":"RATE_OF_PERCEIVED_EXERTION","rpe":7}""",
                ExercisePerformanceTarget.AmrapTarget to """{"type":"AMRAP"}""",
                ExercisePerformanceTarget.UnknownTarget to """{"type":"UNKNOWN"}""",
            )
        val steps =
            goals.map { (g, _) ->
                PlannedExerciseStep(
                    ExerciseSegment.EXERCISE_SEGMENT_TYPE_BIKING,
                    PlannedExerciseStep.EXERCISE_PHASE_WARMUP, g, emptyList(),
                )
            } + PlannedExerciseStep(
                ExerciseSegment.EXERCISE_SEGMENT_TYPE_BIKING,
                PlannedExerciseStep.EXERCISE_PHASE_COOLDOWN,
                ExerciseCompletionGoal.UnknownGoal, targets.map { it.first },
            )
        val d = data(RecordFixtures.plannedSession(listOf(PlannedExerciseBlock(1, steps))))
        val out = d.getValue("blocks").jsonArray.single().jsonObject.getValue("steps").jsonArray
        goals.forEachIndexed { i, (_, json) ->
            Fx.assertJson(Fx.json(json), out[i].jsonObject.getValue("completionGoal"))
        }
        val tgt = out.last().jsonObject.getValue("performanceTargets").jsonArray
        targets.forEachIndexed { i, (_, json) -> Fx.assertJson(Fx.json(json), tgt[i]) }
        assertEquals("WARMUP", (out[0].jsonObject.getValue("exercisePhase") as JsonPrimitive).content)
        assertEquals("COOLDOWN", (out.last().jsonObject.getValue("exercisePhase") as JsonPrimitive).content)
        assertFalse("absent description omitted", "description" in out[0].jsonObject)
    }

    @Test
    fun powerSeriesKeepsEverySample() {
        val samples = (0 until 50).map { PowerRecord.Sample(ms(T0 + it * 1000L), Power.watts(100.0 + it)) }
        val d = data(PowerRecord(s0, o, ms(T0 + 60_000), o, samples, m))
        assertEquals(50, d.getValue("samples").jsonArray.size)
    }

    private companion object {
        /** Records whose fixture spans T0..T2 rather than T0..T1. */
        val SERIES_LIKE =
            setOf(
                "HeartRate", "Speed", "Power", "StepsCadence", "CyclingPedalingCadence",
                "SkinTemperature", "SleepSession", "ExerciseSession",
            )
    }
}
