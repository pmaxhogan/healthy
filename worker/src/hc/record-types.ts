/**
 * Every Health Connect record type the companion app maps, by its wire name
 * (the SDK class without `Record`), and the keys of each one's `data`.
 *
 * The store itself keeps no such list: it takes whatever type the phone
 * sends, so a type a newer SDK adds is never dropped. This list exists for the
 * exposure policy, which has to be able to OFFER a type before any record of
 * it has arrived -- the owner must be able to deny `SexualActivity` on the day
 * the phone is paired, not on the day the first record shows it exists -- and
 * to tell a field a type really has from a typo.
 *
 * Deliberately not derived from the rollup field table
 * (`./rollup/hour.ts`): that one lists the types with something numeric to
 * summarise, and the types it leaves out are the ones most worth hiding.
 *
 * A unit test holds this list to the checked-in contract fixture
 * (`worker/test/fixtures/hc/phone-batches.json`), whose `changes` batch
 * carries one record of every mapped type: a type or a field the phone gains
 * fails that test until it is added here.
 *
 * Pure: plain data, no imports.
 */

/** `data` keys by record type. An empty list is a type that carries nothing but its times. */
export const HC_RECORD_FIELDS = {
  ActiveCaloriesBurned: ["energy"],
  BasalBodyTemperature: ["temperature", "measurementLocation"],
  BasalMetabolicRate: ["bmr"],
  BloodGlucose: ["level", "specimenSource", "mealType", "relationToMeal"],
  BloodPressure: ["systolic", "diastolic", "bodyPosition", "measurementLocation"],
  BodyFat: ["percentage"],
  BodyTemperature: ["temperature", "measurementLocation"],
  BodyWaterMass: ["mass"],
  BoneMass: ["mass"],
  CervicalMucus: ["appearance", "sensation"],
  CyclingPedalingCadence: ["samples"],
  Distance: ["distance"],
  ElevationGained: ["elevation"],
  ExerciseSession: [
    "exerciseType",
    "title",
    "notes",
    "segments",
    "laps",
    "route",
    "routeState",
    "plannedExerciseSessionId",
  ],
  FloorsClimbed: ["floors"],
  HeartRate: ["samples"],
  HeartRateVariabilityRmssd: ["rmssd"],
  Height: ["height"],
  Hydration: ["volume"],
  IntermenstrualBleeding: [],
  LeanBodyMass: ["mass"],
  MenstruationFlow: ["flow"],
  MenstruationPeriod: [],
  MindfulnessSession: ["mindfulnessSessionType", "title", "notes"],
  Nutrition: [
    "name",
    "mealType",
    "energy",
    "energyFromFat",
    "protein",
    "totalCarbohydrate",
    "totalFat",
    "dietaryFiber",
    "sugar",
    "saturatedFat",
    "unsaturatedFat",
    "monounsaturatedFat",
    "polyunsaturatedFat",
    "transFat",
    "cholesterol",
    "sodium",
    "potassium",
    "calcium",
    "iron",
    "magnesium",
    "phosphorus",
    "zinc",
    "copper",
    "manganese",
    "selenium",
    "chromium",
    "molybdenum",
    "iodine",
    "chloride",
    "caffeine",
    "biotin",
    "folate",
    "folicAcid",
    "niacin",
    "pantothenicAcid",
    "riboflavin",
    "thiamin",
    "vitaminA",
    "vitaminB12",
    "vitaminB6",
    "vitaminC",
    "vitaminD",
    "vitaminE",
    "vitaminK",
  ],
  OvulationTest: ["result"],
  OxygenSaturation: ["percentage"],
  PlannedExerciseSession: [
    "exerciseType",
    "title",
    "notes",
    "blocks",
    "hasExplicitTime",
    "completedExerciseSessionId",
  ],
  Power: ["samples"],
  RespiratoryRate: ["rate"],
  RestingHeartRate: ["bpm"],
  SexualActivity: ["protectionUsed"],
  SkinTemperature: ["baseline", "measurementLocation", "deltas"],
  SleepSession: ["title", "notes", "stages"],
  Speed: ["samples"],
  Steps: ["count"],
  StepsCadence: ["samples"],
  TotalCaloriesBurned: ["energy"],
  Vo2Max: ["vo2", "measurementMethod"],
  Weight: ["weight"],
  WheelchairPushes: ["count"],
} as const satisfies Record<string, readonly string[]>;

/** Every mapped record type's wire name, in alphabetical order. */
export const HC_RECORD_TYPES: readonly string[] = Object.keys(HC_RECORD_FIELDS);

const FIELDS_BY_TYPE: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(HC_RECORD_FIELDS),
);

/** The `data` keys of a mapped type, or null for a type this list does not know. */
export function recordFieldsOf(type: string): readonly string[] | null {
  return FIELDS_BY_TYPE.get(type) ?? null;
}
