import { codeText } from "./helpers.ts";

import type { FieldAlias, NormalizeCtx, NormalizedDevice } from "./types.ts";
import type * as fhir4 from "fhir/r4";

/** For the MCP policy's `field` rule engine, see `observation.ts`'s comment. */
export const FIELD_ALIASES: readonly FieldAlias[] = [
  { normalized: ["model"], raw: [["deviceName"]] },
  {
    normalized: ["udi"],
    raw: [
      ["udiCarrier", "[]", "carrierHRF"],
      ["udiCarrier", "[]", "deviceIdentifier"],
    ],
  },
];

function deviceModel(deviceName?: fhir4.DeviceDeviceName[]): string | undefined {
  const modelName = deviceName?.find((name) => name.type === "model-name");
  return modelName?.name ?? deviceName?.[0]?.name;
}

export function normalizeDevice(resource: fhir4.Device, ctx: NormalizeCtx): NormalizedDevice {
  const type = codeText(resource.type);
  const model = deviceModel(resource.deviceName);
  const udi = resource.udiCarrier?.[0]?.carrierHRF ?? resource.udiCarrier?.[0]?.deviceIdentifier;

  return {
    resourceType: "Device",
    id: resource.id ?? "",
    provider: ctx.provider,
    ...(resource.meta?.lastUpdated && { lastUpdated: resource.meta.lastUpdated }),
    ...(type && { type }),
    ...(resource.manufacturer && { manufacturer: resource.manufacturer }),
    ...(model && { model }),
    ...(resource.status && { status: resource.status }),
    ...(udi && { udi }),
  };
}
