import { codeText, codeTextSources, dedupeStrings, period, pickDate } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedCoding,
  NormalizedCondition,
  NormalizedConditionCode,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  // `code.text` is `codeText` of the concept: its text, or its first coding's
  // display or code.
  { normalized: ["code", "text"], raw: codeTextSources("code"), rendered: true },
  { normalized: ["code", "code"], raw: [["code", "coding", "[]", "code"]], rendered: true },
  { normalized: ["code", "system"], raw: [["code", "coding", "[]", "system"]], rendered: true },
  // Every coding's system and code, the same structure renamed. The per-leaf
  // entries tie with `code.code` / `code.system` above, so a rule on either
  // (in either vocabulary) reaches every coding as well as the first one --
  // the alias engine keeps only the longest match, and ties are what widen it.
  { normalized: ["code", "codings"], raw: [["code", "coding"]] },
  {
    normalized: ["code", "codings", "[]", "code"],
    raw: [["code", "coding", "[]", "code"]],
  },
  {
    normalized: ["code", "codings", "[]", "system"],
    raw: [["code", "coding", "[]", "system"]],
  },
  // The id part of `encounter.reference`.
  { normalized: ["encounterId"], raw: [["encounter", "reference"]], rendered: true },
  {
    normalized: ["onset"],
    raw: [["onsetDateTime"], ["onsetPeriod", "start"], ["onsetString"]],
    rendered: true,
  },
  { normalized: ["recorded"], raw: [["recordedDate"]], rendered: true },
  {
    normalized: ["abatement"],
    raw: [["abatementDateTime"], ["abatementPeriod", "start"], ["abatementString"]],
    rendered: true,
  },
];

/** Every coding with a system or a code, in the order sent, each (system, code) pair once. */
function normalizedCodings(cc?: fhir4.CodeableConcept): NormalizedCoding[] {
  const seen = new Set<string>();
  const out: NormalizedCoding[] = [];
  const codings = cc?.coding ?? [];
  for (const coding of codings) {
    if (!coding.system && !coding.code) continue;
    const key = JSON.stringify([coding.system ?? "", coding.code ?? ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(coding.system && { system: coding.system }),
      ...(coding.code && { code: coding.code }),
    });
  }
  return out;
}

function normalizedCode(cc?: fhir4.CodeableConcept): NormalizedConditionCode | undefined {
  const text = codeText(cc);
  const coding = cc?.coding?.[0];
  if (!text && !coding?.system && !coding?.code) {
    return undefined;
  }
  const codings = normalizedCodings(cc);
  return {
    ...(text && { text }),
    ...(coding?.system && { system: coding.system }),
    ...(coding?.code && { code: coding.code }),
    ...(codings.length > 0 && { codings }),
  };
}

/** The logical id of a reference to an Encounter (`Encounter/123`, absolute or relative). */
function encounterIdOf(ref?: fhir4.Reference): string | undefined {
  const reference = ref?.reference;
  if (!reference) return undefined;
  const bare = reference.split(/[?#]/u, 1)[0] ?? "";
  const withoutHistory = bare.split("/_history/", 1)[0] ?? bare;
  const segments = withoutHistory.split("/").filter((segment) => segment.length > 0);
  return segments.length < 2 || segments.at(-2) !== "Encounter" ? undefined : segments.at(-1);
}

export function normalizeCondition(
  resource: fhir4.Condition,
  ctx: NormalizeCtx,
): NormalizedCondition {
  const code = normalizedCode(resource.code);
  const clinicalStatus = codeText(resource.clinicalStatus);
  const verificationStatus = codeText(resource.verificationStatus);
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const encounterId = encounterIdOf(resource.encounter);
  const onset = pickDate(
    resource.onsetDateTime,
    period(resource.onsetPeriod)?.start,
    resource.onsetString,
  );
  const abatement = pickDate(
    resource.abatementDateTime,
    period(resource.abatementPeriod)?.start,
    resource.abatementString,
  );

  return {
    resourceType: "Condition",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    category,
    ...(encounterId && { encounterId }),
    ...(clinicalStatus && { clinicalStatus }),
    ...(verificationStatus && { verificationStatus }),
    ...(onset && { onset }),
    ...(resource.recordedDate && { recorded: resource.recordedDate }),
    ...(abatement && { abatement }),
  };
}
