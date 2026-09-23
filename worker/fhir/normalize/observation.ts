// Epic vitals (e.g. blood pressure) report systolic/diastolic as
// `Observation.component[]` sharing one panel code, rather than as two
// separate Observations, so `components[]` is preserved on the normalized
// shape even though most labs only ever populate the top-level value.

import { codeText, dedupeStrings, pickDate, quantity } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedObservation,
  NormalizedObservationComponent,
  NormalizedObservationValue,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** The FHIR `value[x]` choice type this module collapses to `value`. */
const VALUE_CHOICE_RAW: readonly (readonly string[])[] = [
  ["valueQuantity"],
  ["valueString"],
  ["valueCodeableConcept"],
  ["valueInteger"],
  ["valueBoolean"],
];

/**
 * For the MCP policy's `field` rule engine (`worker/policy/aliases.ts`): every
 * rename this module performs between the raw resource and the normalized
 * item, so a rule written in either vocabulary strips both. The component
 * entry is separate from the top-level one because alias matching is
 * root-anchored -- `components[].value` is not "components" plus "value"
 * composed, it is its own prefix all the way down.
 */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["value"], raw: VALUE_CHOICE_RAW },
  { normalized: ["components"], raw: [["component"]] },
  {
    normalized: ["components", "[]", "value"],
    raw: VALUE_CHOICE_RAW.map((choice) => ["component", "[]", ...choice]),
  },
];

interface ValueCarrier {
  valueQuantity?: fhir4.Quantity | undefined;
  valueString?: string | undefined;
  valueCodeableConcept?: fhir4.CodeableConcept | undefined;
  valueBoolean?: boolean | undefined;
  valueInteger?: number | undefined;
}

function valueOf(carrier: ValueCarrier): NormalizedObservationValue | undefined {
  const asQuantity = quantity(carrier.valueQuantity);
  if (asQuantity) {
    return asQuantity;
  }
  if (carrier.valueString) {
    return { value: carrier.valueString };
  }
  const asCode = codeText(carrier.valueCodeableConcept);
  if (asCode) {
    return { value: asCode };
  }
  if (carrier.valueInteger !== undefined) {
    return { value: carrier.valueInteger };
  }
  if (carrier.valueBoolean !== undefined) {
    return { value: carrier.valueBoolean ? "true" : "false" };
  }
  return undefined;
}

function referenceRangeText(ranges?: fhir4.ObservationReferenceRange[]): string | undefined {
  const range = ranges?.[0];
  if (!range) {
    return undefined;
  }
  if (range.text) {
    return range.text;
  }
  const low = quantity(range.low);
  const high = quantity(range.high);
  const unit = low?.unit ?? high?.unit;
  const unitSuffix = unit ? ` ${unit}` : "";
  if (low && high) {
    return `${String(low.value)}-${String(high.value)}${unitSuffix}`;
  }
  if (low) {
    return `>= ${String(low.value)}${unitSuffix}`;
  }
  return high ? `<= ${String(high.value)}${unitSuffix}` : undefined;
}

function normalizedComponents(
  components?: fhir4.ObservationComponent[],
): NormalizedObservationComponent[] {
  const result: NormalizedObservationComponent[] = [];
  const rawComponents = components ?? [];
  for (const component of rawComponents) {
    const code = codeText(component.code);
    const value = valueOf(component);
    if (code || value) {
      result.push({ ...(code && { code }), ...(value && { value }) });
    }
  }
  return result;
}

export function normalizeObservation(
  resource: fhir4.Observation,
  ctx: NormalizeCtx,
): NormalizedObservation {
  const code = codeText(resource.code);
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const value = valueOf(resource);
  const interpretation = codeText(resource.interpretation?.[0]);
  const referenceRange = referenceRangeText(resource.referenceRange);
  const effective = pickDate(resource.effectiveDateTime, resource.effectivePeriod?.start);

  return {
    resourceType: "Observation",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    category,
    ...(value && { value }),
    ...(interpretation && { interpretation }),
    ...(referenceRange && { referenceRange }),
    ...(effective && { effective }),
    ...(resource.issued && { issued: resource.issued }),
    status: resource.status,
    components: normalizedComponents(resource.component),
  };
}
