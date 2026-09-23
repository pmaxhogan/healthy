import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import PolicyRuleForm from "../../src/components/PolicyRuleForm.vue";
import { RESOURCE_TYPES } from "../../src/lib/fhir-resources.ts";

import { healthSystem } from "./helpers.ts";

import type { McpToolInfoDto } from "@shared/types.ts";

const tools: McpToolInfoDto[] = [
  { name: "get_appointments", description: "Upcoming appointments", resourceTypes: ["Encounter"] },
  { name: "get_lab_results", description: "Laboratory results", resourceTypes: ["Observation"] },
];

function mountForm(): ReturnType<typeof mount> {
  return mount(PolicyRuleForm, { props: { tools, healthSystems: [healthSystem()] } });
}

async function fill(
  wrapper: ReturnType<typeof mount>,
  ruleType: string,
  target: string,
  note?: string,
): Promise<void> {
  await wrapper.find("select").setValue(ruleType);
  const inputs = wrapper.findAll("input");
  await inputs[0]?.setValue(target);
  if (note !== undefined) await inputs[1]?.setValue(note);
  await wrapper.find("form").trigger("submit");
}

describe("PolicyRuleForm", () => {
  it("emits a tool rule with the trimmed target", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "tool", "  get_lab_results  ");
    expect(wrapper.emitted("submit")).toEqual([[{ ruleType: "tool", target: "get_lab_results" }]]);
  });

  it("includes a note when one is given", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "resource", "DocumentReference", "too much text");
    expect(wrapper.emitted("submit")).toEqual([
      [{ ruleType: "resource", target: "DocumentReference", note: "too much text" }],
    ]);
  });

  it("leaves the note key out when it is blank", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "health_system", "prov-1", " ".repeat(3));
    const emitted = wrapper.emitted("submit")?.[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(emitted).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "ruleType",
      "target",
    ]);
  });

  it("carries the allow: prefix through untouched", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "field", "allow:Patient.telecom");
    expect(wrapper.emitted("submit")).toEqual([
      [{ ruleType: "field", target: "allow:Patient.telecom" }],
    ]);
  });

  it("does not emit for an empty target", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "tool", " ".repeat(3));
    expect(wrapper.emitted("submit")).toBeUndefined();
  });

  it("disables the submit button until there is a target", async () => {
    const wrapper = mountForm();
    const button = wrapper.find("button[type='submit']");
    expect(button.attributes("disabled")).toBeDefined();
    await wrapper.findAll("input")[0]?.setValue("get_vitals");
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeUndefined();
  });

  it("clears the fields after a successful submit", async () => {
    const wrapper = mountForm();
    await fill(wrapper, "tool", "get_vitals", "noisy");
    const inputs = wrapper.findAll("input");
    expect((inputs[0]?.element as HTMLInputElement).value).toBe("");
    expect((inputs[1]?.element as HTMLInputElement).value).toBe("");
  });

  it("suggests tool names for a tool rule", () => {
    const wrapper = mountForm();
    const options = wrapper.findAll("datalist option").map((o) => o.attributes("value"));
    expect(options).toEqual(["get_appointments", "get_lab_results"]);
  });

  it("suggests resource types for a resource rule", async () => {
    const wrapper = mountForm();
    await wrapper.find("select").setValue("resource");
    const options = wrapper.findAll("datalist option").map((o) => o.attributes("value"));
    expect(options).toEqual([...RESOURCE_TYPES]);
  });

  it("suggests health system ids for a health system rule", async () => {
    const wrapper = mountForm();
    await wrapper.find("select").setValue("health_system");
    const options = wrapper.findAll("datalist option").map((o) => o.attributes("value"));
    expect(options).toEqual(["prov-1"]);
  });

  it("explains the allow: prefix only for a field rule", async () => {
    const wrapper = mountForm();
    expect(wrapper.text()).not.toContain("allow:");
    await wrapper.find("select").setValue("field");
    expect(wrapper.text()).toContain("allow:");
  });

  it("disables submitting while a previous rule is in flight", async () => {
    const wrapper = mount(PolicyRuleForm, {
      props: { tools, healthSystems: [healthSystem()], busy: true },
    });
    await wrapper.findAll("input")[0]?.setValue("get_vitals");
    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeDefined();
  });
});
