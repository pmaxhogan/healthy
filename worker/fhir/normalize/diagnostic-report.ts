import { codeText, dedupeStrings, pickDate } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedDiagnosticReport } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  {
    normalized: ["effective"],
    raw: [["effectiveDateTime"], ["effectivePeriod", "start"]],
  },
  { normalized: ["resultRefs"], raw: [["result", "[]", "reference"]] },
  { normalized: ["presentedFormRefs"], raw: [["presentedForm", "[]", "url"]] },
];

export function normalizeDiagnosticReport(
  resource: fhir4.DiagnosticReport,
  ctx: NormalizeCtx,
): NormalizedDiagnosticReport {
  const code = codeText(resource.code);
  const category = dedupeStrings((resource.category ?? []).map((cc) => codeText(cc)));
  const effective = pickDate(resource.effectiveDateTime, resource.effectivePeriod?.start);
  const resultRefs = dedupeStrings((resource.result ?? []).map((ref) => ref.reference));
  const presentedFormRefs = dedupeStrings(
    (resource.presentedForm ?? []).map((attachment) => attachment.url),
  );

  return {
    resourceType: "DiagnosticReport",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    category,
    ...(effective && { effective }),
    ...(resource.issued && { issued: resource.issued }),
    status: resource.status,
    ...(resource.conclusion && { conclusion: resource.conclusion }),
    resultRefs,
    presentedFormRefs,
  };
}
