package dev.maxhogan.healthy.companion.hc.mapper

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
import java.math.BigDecimal
import java.math.MathContext
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import kotlin.math.abs
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive

/**
 * A JSON number. Doubles are rounded to 12 significant digits (removes unit-conversion noise such
 * as 36.99999999999999 for 98.6 F, keeps tiny nutrient masses) and integral values are emitted
 * without a fractional part. Non-finite values become JSON null: JSON has no NaN.
 */
internal fun num(v: Double): JsonElement {
    if (v.isNaN() || v.isInfinite()) return JsonNull
    val r = BigDecimal(v).round(MathContext(12)).toDouble()
    return if (r == Math.rint(r) && abs(r) < 1e15) JsonPrimitive(r.toLong()) else JsonPrimitive(r)
}

internal fun num(v: Long): JsonElement = JsonPrimitive(v)

internal fun num(v: Int): JsonElement = JsonPrimitive(v)

internal fun epochMs(t: Instant): JsonElement = JsonPrimitive(t.toEpochMilli())

internal fun durationMs(d: Duration): JsonElement = JsonPrimitive(d.toMillis())

/** Offset as whole minutes, or JSON null when the record carries none. */
internal fun offsetMin(o: ZoneOffset?): JsonElement =
    if (o == null) JsonNull else JsonPrimitive(o.totalSeconds / 60)

internal fun JsonObjectBuilder.putNum(key: String, v: Double?) {
    if (v != null) put(key, num(v))
}

internal fun JsonObjectBuilder.putStr(key: String, v: String?) {
    if (v != null) put(key, JsonPrimitive(v))
}

// Unit normalisation (design section 2). One function per unit type so a mapper cannot pick the
// wrong accessor.
internal fun Pressure.mmHg(): Double = inMillimetersOfMercury

internal fun Length.metres(): Double = inMeters

internal fun Energy.kcal(): Double = inKilocalories

internal fun Mass.kg(): Double = inKilograms

internal fun Mass.grams(): Double = inGrams

internal fun Temperature.celsius(): Double = inCelsius

internal fun TemperatureDelta.celsius(): Double = inCelsius

internal fun Power.watts(): Double = inWatts

internal fun Power.kcalPerDay(): Double = inKilocaloriesPerDay

internal fun Volume.litres(): Double = inLiters

internal fun Velocity.mps(): Double = inMetersPerSecond

internal fun Percentage.pct(): Double = value

internal fun BloodGlucose.mmolPerL(): Double = inMillimolesPerLiter
