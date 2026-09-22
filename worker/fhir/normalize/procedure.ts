import { codeText, dedupeStrings, pickDate } from "./helpers.ts";

import type { NormalizeCtx, NormalizedProcedure, NormalizedProcedurePerformer } from "./types.ts";
import type * as fhir4 from "fhir/r4";

function toPerformer(
  performer: fhir4.ProcedurePerformer,
  ctx: NormalizeCtx,
): NormalizedProcedurePerformer | undefined {
  const name = ctx.refs.display(performer.actor);
  const performerFunction = codeText(performer.function);
  return !name && !performerFunction
    ? undefined
    : { ...(name && { name }), ...(performerFunction && { function: performerFunction }) };
}

export function normalizeProcedure(
  resource: fhir4.Procedure,
  ctx: NormalizeCtx,
): NormalizedProcedure {
  const code = codeText(resource.code);
  const performed = pickDate(resource.performedDateTime, resource.performedPeriod?.start);
  const reasons = dedupeStrings((resource.reasonCode ?? []).map((reason) => codeText(reason)));
  const performers: NormalizedProcedurePerformer[] = [];
  const rawPerformers = resource.performer ?? [];
  for (const performer of rawPerformers) {
    const normalized = toPerformer(performer, ctx);
    if (normalized) {
      performers.push(normalized);
    }
  }

  return {
    resourceType: "Procedure",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    ...(performed && { performed }),
    status: resource.status,
    performers,
    reasons,
  };
}
