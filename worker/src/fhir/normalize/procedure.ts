import { codeText, codeTextSources, dedupeStrings, pickDate } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedProcedure,
  NormalizedProcedurePerformer,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  {
    normalized: ["performed"],
    raw: [["performedDateTime"], ["performedPeriod", "start"]],
    rendered: true,
  },
  { normalized: ["performers"], raw: [["performer"]] },
  {
    normalized: ["performers", "[]", "name"],
    raw: [["performer", "[]", "actor", "display"]],
    rendered: true,
  },
  {
    normalized: ["performers", "[]", "function"],
    raw: codeTextSources("function").map((source) => ["performer", "[]", ...source]),
    rendered: true,
  },
  { normalized: ["reasons"], raw: [["reasonCode"]] },
  { normalized: ["reasons"], raw: codeTextSources("reasonCode"), rendered: true },
];

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
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(code && { code }),
    ...(performed && { performed }),
    status: resource.status,
    performers,
    reasons,
  };
}
