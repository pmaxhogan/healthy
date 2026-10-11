// The MCP page and a paired phone as a source of data: Health Connect rows are
// tagged `device:<id>` and `hc:<Type>`, and the phone tools (`hc_*`, `hr_series`,
// ...) answer from them. Everything here is synthetic -- "Test phone" and
// friends are invented.

import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PolicyRuleBuilder from "../../ui/components/PolicyRuleBuilder.vue";
import { buildArgsSkeleton } from "../../ui/lib/mcp-schema.ts";
import {
  buildTree,
  fieldSentence,
  groupTools,
  groupTypes,
  reachesNothing,
  ruleGroup,
  ruleSentence,
  sourceNamer,
  toolsAffected,
} from "../../ui/lib/policy.ts";
import McpView from "../../ui/views/McpView.vue";

import { fakeResponse, healthSystem, installFakeApi, settings, testRouter } from "./helpers.ts";
import { policyRule, testSchema } from "./policy-fixtures.ts";

import type { FakeFetch } from "./helpers.ts";
import type {
  DeviceDto,
  McpAuditDto,
  McpToolInfoDto,
  PolicyRuleDto,
  PolicySchemaDto,
} from "@shared/types.ts";

function device(overrides: Partial<DeviceDto> = {}): DeviceDto {
  return {
    id: "dev-1",
    name: "Test phone",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
    rotatedAt: null,
    revokedAt: null,
    lastSeenAt: null,
    lastUploadAt: null,
    appVersion: null,
    queue: { batches: 0, bytes: 0 },
    parked: { batches: 0, bytes: 0, errorCodes: [] },
    parkedMarks: 0,
    report: null,
    totals: { recordCount: 0, typesGranted: 0, typesDenied: 0 },
    ...overrides,
  };
}

/** The synthetic schema plus a phone's shapes: they carry no resource type, like the real ones. */
function phoneSchema(): PolicySchemaDto {
  const base = testSchema();
  return {
    ...base,
    shapes: [
      ...base.shapes,
      {
        id: "hc:record",
        label: "Health Connect record",
        resourceType: null,
        vocabulary: "normalized",
        fields: [{ name: "start" }, { name: "data", open: true }],
      },
      {
        id: "hc:hr_point",
        label: "Heart-rate series point",
        resourceType: null,
        vocabulary: "normalized",
        fields: [{ name: "t" }, { name: "mean" }],
      },
    ],
    resourceTypes: [...base.resourceTypes, "hc:Steps", "hc:HeartRate"],
    tools: [
      ...base.tools,
      { name: "hc_records", shapes: ["hc:record"] },
      { name: "hr_series", shapes: ["hc:hr_point"] },
    ],
  };
}

const catalog: McpToolInfoDto[] = [
  { name: "get_care_team", description: "The care team.", resourceTypes: ["CareTeam"] },
  {
    name: "hc_records",
    description: "Raw Health Connect records of one type.",
    resourceTypes: ["hc:Steps", "hc:HeartRate"],
  },
  { name: "hr_series", description: "Heart rate series.", resourceTypes: ["hc:HeartRate"] },
];

const phone = device();
const hs = healthSystem();

describe("source and type naming", () => {
  it("names a phone as a phone, and one that is gone as gone", () => {
    const name = sourceNamer([hs], [phone]);
    expect(name("prov-1")).toBe("Example Health");
    expect(name("device:dev-1")).toBe("Test phone (phone)");
    expect(name("device:wiped")).toBe("a phone that no longer exists");
    expect(name("unknown")).toBe("unknown");
    expect(sourceNamer([], [], "a health system that no longer exists")("x")).toBe(
      "a health system that no longer exists",
    );
  });

  it("splits resource types and tools into FHIR and phone groups", () => {
    const schema = phoneSchema();
    expect(groupTypes(schema.resourceTypes).map((group) => group.label)).toStrictEqual([
      "FHIR resource types",
      "Phone (Health Connect)",
    ]);
    expect(groupTypes(schema.resourceTypes).at(1)?.items).toStrictEqual([
      "hc:Steps",
      "hc:HeartRate",
    ]);
    expect(groupTools(schema).at(1)?.items).toStrictEqual(["hc_records", "hr_series"]);
    // No phone data in the schema: one group, and no phone header to confuse.
    expect(groupTypes(["CareTeam"])).toStrictEqual([
      { label: "FHIR resource types", items: ["CareTeam"] },
    ]);
  });

  it("reads rules about phone data as sentences naming the phone", () => {
    const name = sourceNamer([hs], [phone]);
    expect(
      ruleSentence(policyRule({ ruleType: "tool", target: "hc_records", field: null }), name),
    ).toBe("Block the tool hc_records");
    expect(
      ruleSentence(policyRule({ ruleType: "resource", target: "hc:Steps", field: null }), name),
    ).toBe("Hide every Health Connect Steps record (hc:Steps), in every tool");
    expect(
      ruleSentence(
        policyRule({ ruleType: "health_system", target: "device:dev-1", field: null }),
        name,
      ),
    ).toBe("Hide everything from Test phone (phone)");
    expect(
      fieldSentence(
        {
          effect: "hide",
          tool: null,
          resourceType: "hc:Steps",
          healthSystemId: "device:dev-1",
          paths: ["data"],
        },
        name,
      ),
    ).toBe("Hide data on hc:Steps items in every tool at Test phone (phone)");
    expect(
      fieldSentence(
        {
          effect: "hide",
          tool: null,
          resourceType: "hc:Steps",
          healthSystemId: null,
          paths: ["data"],
        },
        name,
      ),
    ).toBe("Hide data on hc:Steps items in every tool from every phone");
    expect(
      ruleGroup(policyRule({ ruleType: "health_system", target: "device:dev-1", field: null })),
    ).toBe("Hidden sources");
  });
});

describe("the field tree for a phone's types", () => {
  it("offers the phone's shapes for an hc: type, and never a FHIR type's", () => {
    const schema = phoneSchema();
    const groups = buildTree(schema, { tool: null, resourceType: "hc:Steps" });
    expect(groups.map((group) => group.id)).toStrictEqual(["hc:record", "hc:hr_point"]);
    expect(buildTree(schema, { tool: "hc_records", resourceType: "hc:Steps" })).toHaveLength(1);
    expect(
      buildTree(schema, { tool: null, resourceType: "CareTeam" }).map((group) => group.id),
    ).toStrictEqual(["normalized:CareTeam", "raw:CareTeam"]);
  });

  it("finds the tools an hc: type reaches through the catalogue, not the shapes", () => {
    const schema = phoneSchema();
    const rule = policyRule({ ruleType: "resource", target: "hc:Steps", field: null });
    expect(toolsAffected(rule, schema, catalog)).toStrictEqual(["hc_records"]);
    expect(toolsAffected(rule, schema)).toStrictEqual(["hc_records", "hr_series"]);
    expect(reachesNothing(rule, schema, catalog)).toBe("");
  });
});

describe("Try a tool's starting arguments for the phone tools", () => {
  const range = {
    type: "string",
    description: "Start of the range (inclusive). A calendar date (`2026-01-31`) is the start.",
  };
  const now = Date.parse("2026-09-21T12:00:00.000Z");

  it("fills a required type and start a call can actually run with", () => {
    expect(
      buildArgsSkeleton(
        {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Health Connect record type, as hc_coverage lists it",
            },
            start: range,
            end: range,
            limit: { type: "integer" },
          },
          required: ["type", "start"],
        },
        now,
      ),
    ).toStrictEqual({ type: "Steps", start: "2026-09-14" });
  });

  it("uses an enum's first member or a default instead of a blank", () => {
    expect(
      buildArgsSkeleton({
        type: "object",
        properties: {
          resolution: { type: "string", enum: ["raw", "1m"] },
          order: { type: "string", default: "asc" },
        },
        required: ["resolution", "order"],
      }),
    ).toStrictEqual({ resolution: "raw", order: "asc" });
  });

  it("sends nothing the phone tools do not take (no healthSystems, no raw)", () => {
    // The skeleton only ever holds what the tool's own schema requires.
    expect(
      buildArgsSkeleton(
        {
          type: "object",
          properties: { devices: { type: "array" }, start: range },
          required: ["start"],
        },
        now,
      ),
    ).toStrictEqual({ start: "2026-09-14" });
  });
});

// --- the builder ----------------------------------------------------------------

const world: { api: FakeFetch } = { api: undefined as unknown as FakeFetch };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  world.api = installFakeApi({
    "/api/mcp/policy/preview": () => fakeResponse({ body: { tools: [] } }),
    "/api/mcp/policy/structure": () =>
      fakeResponse({ status: 400, body: { error: "bad_request", message: "no sample" } }),
    "/api/mcp/policy": () => fakeResponse({ status: 201, body: policyRule() }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mountBuilder(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(PolicyRuleBuilder, {
    props: {
      schema: phoneSchema(),
      tools: catalog,
      healthSystems: [hs],
      devices: [phone],
      ...props,
    },
    attachTo: document.body,
  });
}

function posted(): unknown {
  const call = world.api.calls.find(
    (entry) => entry.method === "POST" && entry.url === "/api/mcp/policy",
  );
  return JSON.parse(call?.body ?? "{}");
}

async function pickKind(wrapper: ReturnType<typeof mount>, label: string): Promise<void> {
  const button = wrapper.findAll('button[role="radio"]').find((entry) => entry.text() === label);
  await button?.trigger("click");
}

describe("PolicyRuleBuilder with a phone", () => {
  it("blocks a phone tool, offered in its own group", async () => {
    const wrapper = mountBuilder();
    await pickKind(wrapper, "Block a tool");
    const groups = wrapper.findAll('[data-test="target"] optgroup');
    expect(groups.map((group) => group.attributes("label"))).toStrictEqual([
      "Health record",
      "Phone (Health Connect)",
    ]);
    await wrapper.find('[data-test="target"]').setValue("hc_records");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(posted()).toStrictEqual({ ruleType: "tool", target: "hc_records" });
  });

  it("hides an hc: resource type, offered apart from the FHIR types", async () => {
    const wrapper = mountBuilder();
    await pickKind(wrapper, "Hide a resource type");
    const phoneGroup = wrapper
      .findAll('[data-test="target"] optgroup')
      .find((group) => group.attributes("label") === "Phone (Health Connect)");
    expect(phoneGroup?.findAll("option").map((option) => option.text())).toStrictEqual([
      "hc:Steps",
      "hc:HeartRate",
    ]);
    await wrapper.find('[data-test="target"]').setValue("hc:Steps");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(posted()).toStrictEqual({ ruleType: "resource", target: "hc:Steps" });
  });

  it("hides a phone by its name, labelled a phone and not a health system", async () => {
    const wrapper = mountBuilder();
    await pickKind(wrapper, "Hide a source");
    const groups = wrapper.findAll('[data-test="target"] optgroup');
    expect(groups.map((group) => group.attributes("label"))).toStrictEqual([
      "Health systems",
      "Phones",
    ]);
    expect(
      groups
        .at(1)
        ?.findAll("option")
        .map((option) => option.text()),
    ).toStrictEqual(["Test phone"]);
    expect(wrapper.text()).toContain("Source (a health system or a phone)");
    await wrapper.find('[data-test="target"]').setValue("device:dev-1");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(posted()).toStrictEqual({ ruleType: "health_system", target: "device:dev-1" });
  });

  it("builds a field rule on an hc: type for one phone, from the phone's field tree", async () => {
    const wrapper = mountBuilder();
    await wrapper.find('input[type="radio"][value="tool"]').setValue(true);
    await wrapper.find('[data-test="scope-tool"]').setValue("hc_records");
    // The narrowing to one type comes from the catalogue: the phone's shapes carry none.
    const typeSelect = wrapper
      .findAll("select")
      .find((select) => select.text().includes("Every type it returns"));
    expect(typeSelect?.findAll("option").map((option) => option.text())).toStrictEqual([
      "Every type it returns",
      "hc:Steps",
      "hc:HeartRate",
    ]);
    await typeSelect?.setValue("hc:Steps");
    await wrapper.find('[data-test="scope-health-system"]').setValue("device:dev-1");
    await flushPromises();

    const source = wrapper.find('[data-test="scope-health-system"]');
    expect(source.findAll("option").at(0)?.text()).toBe("All sources");
    expect(source.findAll("optgroup").map((group) => group.attributes("label"))).toStrictEqual([
      "Health systems",
      "Phones",
    ]);

    const path = wrapper.find('input[type="checkbox"][data-path="start"]');
    expect(path.exists()).toBe(true);
    await path.setValue(true);
    expect(wrapper.find('[data-test="draft-sentence"]').text()).toBe(
      "Hide start on hc:Steps items in hc_records at Test phone (phone)",
    );
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(posted()).toStrictEqual({
      ruleType: "field",
      field: {
        effect: "hide",
        tool: "hc_records",
        resourceType: "hc:Steps",
        healthSystemId: "device:dev-1",
        paths: ["start"],
      },
    });
  });

  it("builds a field rule on an hc: type at every phone", async () => {
    const wrapper = mountBuilder();
    await wrapper.find('input[type="radio"][value="resource"]').setValue(true);
    await wrapper.find('[data-test="scope-resource"]').setValue("hc:HeartRate");
    await wrapper.find('[data-test="raw-path"]').setValue("mean");
    await wrapper.find('[data-test="raw-path"]').trigger("keydown", { key: "Enter" });
    expect(wrapper.find('[data-test="draft-sentence"]').text()).toBe(
      "Hide mean on hc:HeartRate items in every tool from every phone",
    );
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(posted()).toMatchObject({
      field: { resourceType: "hc:HeartRate", healthSystemId: null },
    });
  });

  it("shows the Worker's refusal of a rule that reaches nothing, beside the form", async () => {
    world.api = installFakeApi({
      "/api/mcp/policy": () =>
        fakeResponse({
          status: 400,
          body: {
            error: "bad_request",
            message:
              "hc_records never returns hc:Weight items. A rule that reaches nothing is refused.",
            details: { problems: ["hc_records never returns hc:Weight items."] },
          },
        }),
    });
    const wrapper = mountBuilder();
    await pickKind(wrapper, "Hide a resource type");
    await wrapper.find('[data-test="target"]').setValue("hc:Steps");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-test="problems"]').text()).toBe(
      "hc_records never returns hc:Weight items.",
    );
  });

  it("shows a message-only refusal too", async () => {
    world.api = installFakeApi({
      "/api/mcp/policy": () =>
        fakeResponse({ status: 400, body: { error: "bad_request", message: "no such phone" } }),
    });
    const wrapper = mountBuilder();
    await pickKind(wrapper, "Hide a source");
    await wrapper.find('[data-test="target"]').setValue("device:dev-1");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(wrapper.find('[data-test="problems"]').text()).toContain("no such phone");
  });

  it("keeps a rule's wiped phone selectable when editing it, named for what it is", () => {
    const wrapper = mountBuilder({
      devices: [],
      editing: policyRule({ ruleType: "health_system", target: "device:gone", field: null }),
    });
    const option = wrapper.find('[data-test="target"] option[value="device:gone"]');
    expect(option.text()).toBe("a phone that no longer exists");
    expect((wrapper.find('[data-test="target"]').element as HTMLSelectElement).value).toBe(
      "device:gone",
    );
  });
});

// --- the page --------------------------------------------------------------------

function audit(overrides: Partial<McpAuditDto> = {}): McpAuditDto {
  return {
    id: "a-1",
    ts: "2026-09-21T11:00:00.000Z",
    clientId: "admin-console",
    tool: "hc_records",
    healthSystemIds: ["device:dev-1"],
    resultCount: 12,
    ok: true,
    errorCode: null,
    durationMs: 30,
    jq: null,
    ...overrides,
  };
}

async function mountPage(
  rules: PolicyRuleDto[],
  options: { devices?: DeviceDto[] | null; audit?: McpAuditDto[] } = {},
): Promise<ReturnType<typeof mount>> {
  const devices = options.devices === undefined ? [phone] : options.devices;
  installFakeApi({
    "/api/settings": () => fakeResponse({ body: settings() }),
    "/api/mcp/policy": () => fakeResponse({ body: rules }),
    "/api/mcp/policy/schema": () => fakeResponse({ body: phoneSchema() }),
    "/api/mcp/grants": () => fakeResponse({ body: [] }),
    "/api/mcp/audit": () => fakeResponse({ body: options.audit ?? [] }),
    "/api/mcp/tools": () => fakeResponse({ body: catalog }),
    "/api/mcp/tools/schema": () => fakeResponse({ body: [] }),
    "/api/health-systems": () => fakeResponse({ body: [hs] }),
    "/api/phone/devices": () =>
      fakeResponse(
        devices === null
          ? { status: 500, body: { error: "internal", message: "down" } }
          : { body: devices },
      ),
  });
  const router = await testRouter("/connectors");
  const wrapper = mount(McpView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("McpView with a phone", () => {
  const phoneRules = [
    policyRule({ id: "r-1", ruleType: "tool", target: "hc_records", field: null }),
    policyRule({ id: "r-2", ruleType: "resource", target: "hc:Steps", field: null }),
    policyRule({ id: "r-3", ruleType: "health_system", target: "device:dev-1", field: null }),
    policyRule({ id: "r-4", ruleType: "health_system", target: "device:gone", field: null }),
  ];

  it("lists a stored rule's phone by name, and a wiped one as gone", async () => {
    const wrapper = await mountPage(phoneRules);
    const rows = wrapper.findAll('[data-test="rule"]').map((row) => row.text());
    expect(rows.join("\n")).toContain("Block the tool hc_records");
    expect(rows.join("\n")).toContain(
      "Hide every Health Connect Steps record (hc:Steps), in every tool",
    );
    expect(rows.join("\n")).toContain("Hide everything from Test phone (phone)");
    expect(rows.join("\n")).toContain("Hide everything from a phone that no longer exists");
    expect(wrapper.text()).toContain("Hidden sources");
    expect(wrapper.text()).not.toContain("device:dev-1");
    // An hc: type rule names the phone tools that carry it, not the health summary.
    const typeRow = rows.find((row) => row.includes("hc:Steps"));
    expect(typeRow).toContain("hc_records");
    expect(typeRow).not.toContain("get_health_summary");
  });

  it("falls back to a plain phone label when the device list cannot be read", async () => {
    const wrapper = await mountPage(phoneRules, { devices: null });
    expect(wrapper.text()).toContain("Hide everything from a phone that no longer exists");
    expect(wrapper.find('[data-test="rule"]').exists()).toBe(true);
  });

  it("names a phone in the audit log's Sources column", async () => {
    const wrapper = await mountPage([], {
      audit: [
        audit(),
        audit({ id: "a-2", tool: "hr_series", healthSystemIds: ["device:gone", "prov-1"] }),
      ],
    });
    const text = wrapper.text();
    expect(text).toContain("Sources");
    expect(text).toContain("hc_records");
    expect(text).toContain("Test phone (phone)");
    expect(text).toContain("a phone that no longer exists, Example Health");
  });
});
