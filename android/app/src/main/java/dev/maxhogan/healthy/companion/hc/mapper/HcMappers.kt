@file:OptIn(ExperimentalMindfulnessSessionApi::class)

package dev.maxhogan.healthy.companion.hc.mapper

import androidx.health.connect.client.feature.ExperimentalMindfulnessSessionApi
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
import androidx.health.connect.client.records.ExerciseCompletionGoal
import androidx.health.connect.client.records.ExercisePerformanceTarget
import androidx.health.connect.client.records.ExerciseRouteResult
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
import androidx.health.connect.client.records.PlannedExerciseBlock
import androidx.health.connect.client.records.PlannedExerciseSessionRecord
import androidx.health.connect.client.records.PlannedExerciseStep
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
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** A hand-written mapper: the wire `type` name, the library class, and the mapping function. */
internal class RecordMapper<T : Record>(
    val type: String,
    val recordClass: Class<T>,
    private val map: (T) -> Mapped,
) {
    fun apply(record: T): Mapped = map(record)
}

internal class Mapped(val timing: Timing, val data: JsonObject)

private inline fun <reified T : Record> reg(type: String, noinline f: (T) -> Mapped) =
    RecordMapper(type, T::class.java, f)

private fun interval(
    start: Instant,
    startOffset: ZoneOffset?,
    end: Instant,
    endOffset: ZoneOffset?,
    data: JsonObjectBuilder.() -> Unit = {},
) = Mapped(IntervalTiming(start, startOffset, end, endOffset), buildJsonObject(data))

private fun instant(
    time: Instant,
    offset: ZoneOffset?,
    data: JsonObjectBuilder.() -> Unit = {},
) = Mapped(InstantTiming(time, offset), buildJsonObject(data))

private fun name(table: Map<Int, String>, v: Int): JsonElement =
    JsonPrimitive(EnumTables.name(table, v))

private fun JsonObjectBuilder.putEnum(key: String, table: Map<Int, String>, v: Int) {
    put(key, name(table, v))
}

private fun JsonObjectBuilder.putGrams(key: String, m: androidx.health.connect.client.units.Mass?) {
    if (m != null) put(key, num(m.grams()))
}

private fun array(items: List<JsonElement>) = JsonArray(items)

/** `samples[{ t, <field> }]` for the four series records. */
private fun <S> samples(list: List<S>, time: (S) -> Instant, field: String, value: (S) -> JsonElement) =
    array(
        list.map { s ->
            buildJsonObject {
                put("t", epochMs(time(s)))
                put(field, value(s))
            }
        }
    )

private fun routeJson(result: ExerciseRouteResult, b: JsonObjectBuilder) {
    when (result) {
        is ExerciseRouteResult.Data ->
            b.put(
                "route",
                array(
                    result.exerciseRoute.route.map { p ->
                        buildJsonObject {
                            put("t", epochMs(p.time))
                            put("lat", num(p.latitude))
                            put("lon", num(p.longitude))
                            putNum("alt", p.altitude?.metres())
                            putNum("hAcc", p.horizontalAccuracy?.metres())
                            putNum("vAcc", p.verticalAccuracy?.metres())
                        }
                    }
                ),
            )
        is ExerciseRouteResult.ConsentRequired -> b.put("routeState", JsonPrimitive("CONSENT_REQUIRED"))
        is ExerciseRouteResult.NoData -> b.put("routeState", JsonPrimitive("NO_DATA"))
        // A newer library may add a result case; say so instead of dropping the route silently.
        // One key, like every other enum: the unknown case is named after its class.
        else -> b.put("routeState", JsonPrimitive(unknownRouteState(result)))
    }
}

/** `UNKNOWN_<CLASS_NAME>` for a route result this version has no name for. */
internal fun unknownRouteState(result: Any): String {
    val name = result.javaClass.simpleName
        .replace(Regex("([a-z0-9])([A-Z])"), "$1_$2")
        .uppercase()
        .replace(Regex("[^A-Z0-9_]"), "")
    return if (name.isEmpty()) "UNKNOWN" else "UNKNOWN_$name"
}

private fun goalJson(goal: ExerciseCompletionGoal): JsonObject = buildJsonObject {
    when (goal) {
        is ExerciseCompletionGoal.DistanceGoal -> {
            put("type", JsonPrimitive("DISTANCE"))
            put("distance", num(goal.distance.metres()))
        }
        is ExerciseCompletionGoal.DistanceAndDurationGoal -> {
            put("type", JsonPrimitive("DISTANCE_AND_DURATION"))
            put("distance", num(goal.distance.metres()))
            put("duration", durationMs(goal.duration))
        }
        is ExerciseCompletionGoal.StepsGoal -> {
            put("type", JsonPrimitive("STEPS"))
            put("steps", num(goal.steps))
        }
        is ExerciseCompletionGoal.DurationGoal -> {
            put("type", JsonPrimitive("DURATION"))
            put("duration", durationMs(goal.duration))
        }
        is ExerciseCompletionGoal.RepetitionsGoal -> {
            put("type", JsonPrimitive("REPETITIONS"))
            put("repetitions", num(goal.repetitions))
        }
        is ExerciseCompletionGoal.TotalCaloriesBurnedGoal -> {
            put("type", JsonPrimitive("TOTAL_CALORIES_BURNED"))
            put("energy", num(goal.totalCalories.kcal()))
        }
        is ExerciseCompletionGoal.ActiveCaloriesBurnedGoal -> {
            put("type", JsonPrimitive("ACTIVE_CALORIES_BURNED"))
            put("energy", num(goal.activeCalories.kcal()))
        }
        is ExerciseCompletionGoal.UnknownGoal -> put("type", JsonPrimitive("UNKNOWN"))
        is ExerciseCompletionGoal.ManualCompletion -> put("type", JsonPrimitive("MANUAL_COMPLETION"))
        else -> {
            put("type", JsonPrimitive("UNKNOWN"))
            put("_raw", JsonPrimitive(goal.toString()))
        }
    }
}

private fun targetJson(target: ExercisePerformanceTarget): JsonObject = buildJsonObject {
    when (target) {
        is ExercisePerformanceTarget.PowerTarget -> {
            put("type", JsonPrimitive("POWER"))
            put("minPower", num(target.minPower.watts()))
            put("maxPower", num(target.maxPower.watts()))
        }
        is ExercisePerformanceTarget.SpeedTarget -> {
            put("type", JsonPrimitive("SPEED"))
            put("minSpeed", num(target.minSpeed.mps()))
            put("maxSpeed", num(target.maxSpeed.mps()))
        }
        is ExercisePerformanceTarget.CadenceTarget -> {
            put("type", JsonPrimitive("CADENCE"))
            put("minCadence", num(target.minCadence))
            put("maxCadence", num(target.maxCadence))
        }
        is ExercisePerformanceTarget.HeartRateTarget -> {
            put("type", JsonPrimitive("HEART_RATE"))
            put("minHeartRate", num(target.minHeartRate))
            put("maxHeartRate", num(target.maxHeartRate))
        }
        is ExercisePerformanceTarget.WeightTarget -> {
            put("type", JsonPrimitive("WEIGHT"))
            put("mass", num(target.mass.kg()))
        }
        is ExercisePerformanceTarget.RateOfPerceivedExertionTarget -> {
            put("type", JsonPrimitive("RATE_OF_PERCEIVED_EXERTION"))
            put("rpe", num(target.rpe))
        }
        is ExercisePerformanceTarget.AmrapTarget -> put("type", JsonPrimitive("AMRAP"))
        is ExercisePerformanceTarget.UnknownTarget -> put("type", JsonPrimitive("UNKNOWN"))
        else -> {
            put("type", JsonPrimitive("UNKNOWN"))
            put("_raw", JsonPrimitive(target.toString()))
        }
    }
}

private fun stepJson(s: PlannedExerciseStep): JsonObject = buildJsonObject {
    putEnum("exerciseType", EnumTables.segmentType, s.exerciseType)
    putEnum("exercisePhase", EnumTables.exercisePhase, s.exercisePhase)
    putStr("description", s.description)
    put("completionGoal", goalJson(s.completionGoal))
    put("performanceTargets", array(s.performanceTargets.map(::targetJson)))
}

private fun blockJson(b: PlannedExerciseBlock): JsonObject = buildJsonObject {
    put("repetitions", num(b.repetitions))
    putStr("description", b.description)
    put("steps", array(b.steps.map(::stepJson)))
}

/** Every hand-written mapper. The coverage test cross-checks this list against the library. */
internal object HcMappers {
    val all: List<RecordMapper<*>> =
        listOf(
            reg<StepsRecord>("Steps") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("count", num(r.count))
                }
            },
            reg<DistanceRecord>("Distance") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("distance", num(r.distance.metres()))
                }
            },
            reg<ActiveCaloriesBurnedRecord>("ActiveCaloriesBurned") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("energy", num(r.energy.kcal()))
                }
            },
            reg<TotalCaloriesBurnedRecord>("TotalCaloriesBurned") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("energy", num(r.energy.kcal()))
                }
            },
            reg<FloorsClimbedRecord>("FloorsClimbed") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("floors", num(r.floors))
                }
            },
            reg<ElevationGainedRecord>("ElevationGained") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("elevation", num(r.elevation.metres()))
                }
            },
            reg<WheelchairPushesRecord>("WheelchairPushes") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("count", num(r.count))
                }
            },
            reg<HydrationRecord>("Hydration") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("volume", num(r.volume.litres()))
                }
            },
            reg<HeartRateRecord>("HeartRate") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("samples", samples(r.samples, { it.time }, "bpm") { num(it.beatsPerMinute) })
                }
            },
            reg<SpeedRecord>("Speed") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("samples", samples(r.samples, { it.time }, "speed") { num(it.speed.mps()) })
                }
            },
            reg<PowerRecord>("Power") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("samples", samples(r.samples, { it.time }, "power") { num(it.power.watts()) })
                }
            },
            reg<StepsCadenceRecord>("StepsCadence") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("samples", samples(r.samples, { it.time }, "rate") { num(it.rate) })
                }
            },
            reg<CyclingPedalingCadenceRecord>("CyclingPedalingCadence") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put(
                        "samples",
                        samples(r.samples, { it.time }, "rate") { num(it.revolutionsPerMinute) },
                    )
                }
            },
            reg<RestingHeartRateRecord>("RestingHeartRate") { r ->
                instant(r.time, r.zoneOffset) { put("bpm", num(r.beatsPerMinute)) }
            },
            reg<HeartRateVariabilityRmssdRecord>("HeartRateVariabilityRmssd") { r ->
                instant(r.time, r.zoneOffset) { put("rmssd", num(r.heartRateVariabilityMillis)) }
            },
            reg<RespiratoryRateRecord>("RespiratoryRate") { r ->
                instant(r.time, r.zoneOffset) { put("rate", num(r.rate)) }
            },
            reg<OxygenSaturationRecord>("OxygenSaturation") { r ->
                instant(r.time, r.zoneOffset) { put("percentage", num(r.percentage.pct())) }
            },
            reg<BloodPressureRecord>("BloodPressure") { r ->
                instant(r.time, r.zoneOffset) {
                    put("systolic", num(r.systolic.mmHg()))
                    put("diastolic", num(r.diastolic.mmHg()))
                    putEnum("bodyPosition", EnumTables.bodyPosition, r.bodyPosition)
                    putEnum("measurementLocation", EnumTables.bpLocation, r.measurementLocation)
                }
            },
            reg<BloodGlucoseRecord>("BloodGlucose") { r ->
                instant(r.time, r.zoneOffset) {
                    put("level", num(r.level.mmolPerL()))
                    putEnum("specimenSource", EnumTables.specimenSource, r.specimenSource)
                    putEnum("mealType", EnumTables.mealType, r.mealType)
                    putEnum("relationToMeal", EnumTables.relationToMeal, r.relationToMeal)
                }
            },
            reg<BodyTemperatureRecord>("BodyTemperature") { r ->
                instant(r.time, r.zoneOffset) {
                    put("temperature", num(r.temperature.celsius()))
                    putEnum(
                        "measurementLocation",
                        EnumTables.bodyTemperatureLocation,
                        r.measurementLocation,
                    )
                }
            },
            reg<BasalBodyTemperatureRecord>("BasalBodyTemperature") { r ->
                instant(r.time, r.zoneOffset) {
                    put("temperature", num(r.temperature.celsius()))
                    putEnum(
                        "measurementLocation",
                        EnumTables.bodyTemperatureLocation,
                        r.measurementLocation,
                    )
                }
            },
            reg<SkinTemperatureRecord>("SkinTemperature") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    putNum("baseline", r.baseline?.celsius())
                    putEnum("measurementLocation", EnumTables.skinLocation, r.measurementLocation)
                    put("deltas", samples(r.deltas, { it.time }, "delta") { num(it.delta.celsius()) })
                }
            },
            reg<WeightRecord>("Weight") { r ->
                instant(r.time, r.zoneOffset) { put("weight", num(r.weight.kg())) }
            },
            reg<HeightRecord>("Height") { r ->
                instant(r.time, r.zoneOffset) { put("height", num(r.height.metres())) }
            },
            reg<BodyFatRecord>("BodyFat") { r ->
                instant(r.time, r.zoneOffset) { put("percentage", num(r.percentage.pct())) }
            },
            reg<LeanBodyMassRecord>("LeanBodyMass") { r ->
                instant(r.time, r.zoneOffset) { put("mass", num(r.mass.kg())) }
            },
            reg<BoneMassRecord>("BoneMass") { r ->
                instant(r.time, r.zoneOffset) { put("mass", num(r.mass.kg())) }
            },
            reg<BodyWaterMassRecord>("BodyWaterMass") { r ->
                instant(r.time, r.zoneOffset) { put("mass", num(r.mass.kg())) }
            },
            reg<BasalMetabolicRateRecord>("BasalMetabolicRate") { r ->
                instant(r.time, r.zoneOffset) {
                    put("bmr", num(r.basalMetabolicRate.kcalPerDay()))
                }
            },
            reg<Vo2MaxRecord>("Vo2Max") { r ->
                instant(r.time, r.zoneOffset) {
                    put("vo2", num(r.vo2MillilitersPerMinuteKilogram))
                    putEnum("measurementMethod", EnumTables.vo2Method, r.measurementMethod)
                }
            },
            reg<NutritionRecord>("Nutrition") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    putNum("energy", r.energy?.kcal())
                    putNum("energyFromFat", r.energyFromFat?.kcal())
                    putStr("name", r.name)
                    putEnum("mealType", EnumTables.mealType, r.mealType)
                    putGrams("biotin", r.biotin)
                    putGrams("caffeine", r.caffeine)
                    putGrams("calcium", r.calcium)
                    putGrams("chloride", r.chloride)
                    putGrams("cholesterol", r.cholesterol)
                    putGrams("chromium", r.chromium)
                    putGrams("copper", r.copper)
                    putGrams("dietaryFiber", r.dietaryFiber)
                    putGrams("folate", r.folate)
                    putGrams("folicAcid", r.folicAcid)
                    putGrams("iodine", r.iodine)
                    putGrams("iron", r.iron)
                    putGrams("magnesium", r.magnesium)
                    putGrams("manganese", r.manganese)
                    putGrams("molybdenum", r.molybdenum)
                    putGrams("monounsaturatedFat", r.monounsaturatedFat)
                    putGrams("niacin", r.niacin)
                    putGrams("pantothenicAcid", r.pantothenicAcid)
                    putGrams("phosphorus", r.phosphorus)
                    putGrams("polyunsaturatedFat", r.polyunsaturatedFat)
                    putGrams("potassium", r.potassium)
                    putGrams("protein", r.protein)
                    putGrams("riboflavin", r.riboflavin)
                    putGrams("saturatedFat", r.saturatedFat)
                    putGrams("selenium", r.selenium)
                    putGrams("sodium", r.sodium)
                    putGrams("sugar", r.sugar)
                    putGrams("thiamin", r.thiamin)
                    putGrams("totalCarbohydrate", r.totalCarbohydrate)
                    putGrams("totalFat", r.totalFat)
                    putGrams("transFat", r.transFat)
                    putGrams("unsaturatedFat", r.unsaturatedFat)
                    putGrams("vitaminA", r.vitaminA)
                    putGrams("vitaminB12", r.vitaminB12)
                    putGrams("vitaminB6", r.vitaminB6)
                    putGrams("vitaminC", r.vitaminC)
                    putGrams("vitaminD", r.vitaminD)
                    putGrams("vitaminE", r.vitaminE)
                    putGrams("vitaminK", r.vitaminK)
                    putGrams("zinc", r.zinc)
                }
            },
            reg<SleepSessionRecord>("SleepSession") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    putStr("title", r.title)
                    putStr("notes", r.notes)
                    put(
                        "stages",
                        array(
                            r.stages.map { s ->
                                buildJsonObject {
                                    put("start", epochMs(s.startTime))
                                    put("end", epochMs(s.endTime))
                                    putEnum("stage", EnumTables.sleepStage, s.stage)
                                }
                            }
                        ),
                    )
                }
            },
            reg<ExerciseSessionRecord>("ExerciseSession") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    putEnum("exerciseType", EnumTables.exerciseType, r.exerciseType)
                    putStr("title", r.title)
                    putStr("notes", r.notes)
                    put(
                        "segments",
                        array(
                            r.segments.map { s ->
                                buildJsonObject {
                                    put("start", epochMs(s.startTime))
                                    put("end", epochMs(s.endTime))
                                    putEnum("segmentType", EnumTables.segmentType, s.segmentType)
                                    put("repetitions", num(s.repetitions))
                                }
                            }
                        ),
                    )
                    put(
                        "laps",
                        array(
                            r.laps.map { l ->
                                buildJsonObject {
                                    put("start", epochMs(l.startTime))
                                    put("end", epochMs(l.endTime))
                                    putNum("length", l.length?.metres())
                                }
                            }
                        ),
                    )
                    routeJson(r.exerciseRouteResult, this)
                    putStr("plannedExerciseSessionId", r.plannedExerciseSessionId)
                }
            },
            reg<PlannedExerciseSessionRecord>("PlannedExerciseSession") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    put("hasExplicitTime", JsonPrimitive(r.hasExplicitTime))
                    putEnum("exerciseType", EnumTables.exerciseType, r.exerciseType)
                    putStr("title", r.title)
                    putStr("notes", r.notes)
                    put("blocks", array(r.blocks.map(::blockJson)))
                    putStr("completedExerciseSessionId", r.completedExerciseSessionId)
                }
            },
            reg<MindfulnessSessionRecord>("MindfulnessSession") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset) {
                    putEnum(
                        "mindfulnessSessionType",
                        EnumTables.mindfulnessType,
                        r.mindfulnessSessionType,
                    )
                    putStr("title", r.title)
                    putStr("notes", r.notes)
                }
            },
            reg<MenstruationFlowRecord>("MenstruationFlow") { r ->
                instant(r.time, r.zoneOffset) { putEnum("flow", EnumTables.flow, r.flow) }
            },
            reg<MenstruationPeriodRecord>("MenstruationPeriod") { r ->
                interval(r.startTime, r.startZoneOffset, r.endTime, r.endZoneOffset)
            },
            reg<CervicalMucusRecord>("CervicalMucus") { r ->
                instant(r.time, r.zoneOffset) {
                    putEnum("appearance", EnumTables.appearance, r.appearance)
                    putEnum("sensation", EnumTables.sensation, r.sensation)
                }
            },
            reg<OvulationTestRecord>("OvulationTest") { r ->
                instant(r.time, r.zoneOffset) {
                    putEnum("result", EnumTables.ovulationResult, r.result)
                }
            },
            reg<IntermenstrualBleedingRecord>("IntermenstrualBleeding") { r ->
                instant(r.time, r.zoneOffset)
            },
            reg<SexualActivityRecord>("SexualActivity") { r ->
                instant(r.time, r.zoneOffset) {
                    putEnum("protectionUsed", EnumTables.protectionUsed, r.protectionUsed)
                }
            },
        )
}
