import { codeText } from "./helpers.ts";

import type {
  FieldAlias,
  NormalizeCtx,
  NormalizedCareTeam,
  NormalizedCareTeamParticipant,
} from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["participants"], raw: [["participant"]] },
];

function toParticipant(
  participant: fhir4.CareTeamParticipant,
  ctx: NormalizeCtx,
): NormalizedCareTeamParticipant | undefined {
  const name = ctx.refs.display(participant.member);
  const role = codeText(participant.role?.[0]);
  return !name && !role ? undefined : { ...(name && { name }), ...(role && { role }) };
}

export function normalizeCareTeam(resource: fhir4.CareTeam, ctx: NormalizeCtx): NormalizedCareTeam {
  const participants: NormalizedCareTeamParticipant[] = [];
  const rawParticipants = resource.participant ?? [];
  for (const participant of rawParticipants) {
    const normalized = toParticipant(participant, ctx);
    if (normalized) {
      participants.push(normalized);
    }
  }

  return {
    resourceType: "CareTeam",
    id: resource.id ?? "",
    healthSystem: ctx.healthSystem,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(resource.name && { name: resource.name }),
    ...(resource.status && { status: resource.status }),
    participants,
  };
}
