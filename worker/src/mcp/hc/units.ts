/**
Units, declared once per answer.

The companion app normalises every value before it uploads (pressure mmHg,
heart rate bpm, lengths metres, energy kcal, mass kg, temperature celsius,
volume litres, speed m/s, power watts, percentages 0-100, glucose mmol/L),
so a unit belongs to a field, not to a row. A tool puts the map for the
fields it returns in the envelope's `units` and leaves it off every item.

A field not listed here has no unit to declare (a name, an enum, a count of
nothing in particular) or belongs to a record type this Worker has no table
for; either way it is absent from the map rather than guessed at.
*/

/** Units of `data` fields, by record type. Nested sample fields by their own key. */
const DATA_UNITS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Steps: { count: "steps" },
  Distance: { distance: "m" },
  ActiveCaloriesBurned: { energy: "kcal" },
  TotalCaloriesBurned: { energy: "kcal" },
  FloorsClimbed: { floors: "floors" },
  ElevationGained: { elevation: "m" },
  WheelchairPushes: { count: "pushes" },
  HeartRate: { bpm: "bpm" },
  RestingHeartRate: { bpm: "bpm" },
  HeartRateVariabilityRmssd: { rmssd: "ms" },
  RespiratoryRate: { rate: "breaths/min" },
  OxygenSaturation: { percentage: "%" },
  BloodPressure: { systolic: "mmHg", diastolic: "mmHg" },
  BloodGlucose: { level: "mmol/L" },
  BodyTemperature: { temperature: "celsius" },
  BasalBodyTemperature: { temperature: "celsius" },
  SkinTemperature: { baseline: "celsius", delta: "celsius" },
  Weight: { weight: "kg" },
  Height: { height: "m" },
  BodyFat: { percentage: "%" },
  LeanBodyMass: { mass: "kg" },
  BoneMass: { mass: "kg" },
  BodyWaterMass: { mass: "kg" },
  BasalMetabolicRate: { bmr: "kcal/day" },
  Vo2Max: { vo2: "mL/kg/min" },
  Speed: { speed: "m/s" },
  Power: { power: "W" },
  StepsCadence: { rate: "steps/min" },
  CyclingPedalingCadence: { rate: "rpm" },
  Hydration: { volume: "L" },
  Nutrition: { energy: "kcal", energyFromFat: "kcal", "*": "g" },
  ExerciseSession: { length: "m" },
};

const UNITS_BY_TYPE: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map(
  Object.entries(DATA_UNITS),
);

/** The platform aggregates carry their unit in the record; these are the fixed ones. */
const AGG_UNITS: ReadonlyMap<string, string> = new Map([
  ["Steps", "steps"],
  ["Distance", "m"],
  ["ActiveCalories", "kcal"],
  ["Floors", "floors"],
  ["Elevation", "m"],
  ["WheelchairPushes", "pushes"],
  ["ExerciseDuration", "ms"],
  ["SleepDuration", "ms"],
  ["Hydration", "L"],
]);

const AGG_PREFIX = "Agg.";

/** The `units` map for one record type's `data` fields. Empty for an unknown type. */
export function unitsFor(type: string): Record<string, string> {
  if (type.startsWith(AGG_PREFIX)) {
    const unit = AGG_UNITS.get(type.slice(AGG_PREFIX.length));
    return unit === undefined ? {} : { value: unit };
  }
  return { ...UNITS_BY_TYPE.get(type) };
}
