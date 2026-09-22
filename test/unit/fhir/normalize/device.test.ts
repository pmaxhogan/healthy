import { describe, expect, it } from "vitest";

import { normalizeDevice } from "../../../../worker/fhir/normalize/device.ts";

import { testCtx } from "./fixtures.ts";

import type * as fhir4 from "fhir/r4";

describe("normalizeDevice", () => {
  it("maps type, manufacturer, model name, status, and UDI", () => {
    const resource: fhir4.Device = {
      resourceType: "Device",
      id: "dev-1",
      type: { text: "Insulin pump" },
      manufacturer: "Example Devices Inc",
      deviceName: [{ name: "Example Pump X1", type: "model-name" }],
      status: "active",
      udiCarrier: [{ carrierHRF: "(01)00000000000000" }],
    };

    const result = normalizeDevice(resource, testCtx());

    expect(result).toMatchObject({
      resourceType: "Device",
      id: "dev-1",
      type: "Insulin pump",
      manufacturer: "Example Devices Inc",
      model: "Example Pump X1",
      status: "active",
      udi: "(01)00000000000000",
    });
  });

  it("omits optional fields when there is nothing to report", () => {
    const resource: fhir4.Device = { resourceType: "Device", id: "dev-2" };
    const result = normalizeDevice(resource, testCtx());

    expect(Object.hasOwn(result, "type")).toBe(false);
    expect(Object.hasOwn(result, "manufacturer")).toBe(false);
    expect(Object.hasOwn(result, "model")).toBe(false);
    expect(Object.hasOwn(result, "udi")).toBe(false);
  });
});
