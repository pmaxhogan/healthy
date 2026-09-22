import { describe, expect, it } from "vitest";

import {
  DEFAULT_TITLE_TEMPLATE,
  PLACEHOLDERS,
  previewTitle,
  renderTitleTemplate,
  SAMPLE_VIEW,
} from "../../src/lib/template.ts";

describe("renderTitleTemplate", () => {
  it("substitutes every known placeholder", () => {
    const template = PLACEHOLDERS.map((name) => `{${name}}`).join(" ");
    const { text, unknown, empty } = renderTitleTemplate(template, SAMPLE_VIEW);
    for (const value of Object.values(SAMPLE_VIEW)) expect(text).toContain(value);
    expect(unknown).toEqual([]);
    expect(empty).toEqual([]);
  });

  it("renders the default template from the sample appointment", () => {
    expect(previewTitle(DEFAULT_TITLE_TEMPLATE).text).toBe("Annual physical · Dr. A. Reyes");
  });

  it("drops a separator left stranded by an empty placeholder", () => {
    const result = renderTitleTemplate("{visitType} · {practitioner}", {
      visitType: "Annual physical",
    });
    expect(result.text).toBe("Annual physical");
    expect(result.empty).toEqual(["practitioner"]);
  });

  it("drops a leading separator when the first placeholder is empty", () => {
    expect(renderTitleTemplate("{orgShort} · {visitType}", { visitType: "Lab draw" }).text).toBe(
      "Lab draw",
    );
  });

  it("collapses a run of separators between two empty placeholders", () => {
    const result = renderTitleTemplate("{orgShort} · {practitioner} · {visitType}", {
      visitType: "Lab draw",
    });
    expect(result.text).toBe("Lab draw");
    expect(result.empty).toEqual(["orgShort", "practitioner"]);
  });

  it("keeps literal text around the placeholders", () => {
    expect(
      renderTitleTemplate("{visitType} (appt {apptTime})", {
        visitType: "Follow-up",
        apptTime: "11:30",
      }).text,
    ).toBe("Follow-up (appt 11:30)");
  });

  it("leaves an unknown placeholder visible and reports it", () => {
    const result = renderTitleTemplate("{visitType} · {doctorName}", SAMPLE_VIEW);
    expect(result.text).toBe("Annual physical · {doctorName}");
    expect(result.unknown).toEqual(["doctorName"]);
  });

  it("reports each unknown placeholder once", () => {
    expect(renderTitleTemplate("{nope} {nope}", SAMPLE_VIEW).unknown).toEqual(["nope"]);
  });

  it("treats an empty-string value as absent", () => {
    expect(
      renderTitleTemplate("{visitType} · {practitioner}", {
        visitType: "Annual physical",
        practitioner: "",
      }).text,
    ).toBe("Annual physical");
  });

  it("returns an empty string for a template that resolves to nothing", () => {
    expect(renderTitleTemplate("{practitioner}", {}).text).toBe("");
    expect(renderTitleTemplate(" ".repeat(3), {}).text).toBe("");
  });

  it("normalises whitespace runs", () => {
    expect(renderTitleTemplate("{visitType}    {apptTime}", SAMPLE_VIEW).text).toBe(
      "Annual physical 11:30",
    );
  });

  it("is not tripped up by braces that are not placeholders", () => {
    expect(renderTitleTemplate("{ visitType }", SAMPLE_VIEW).text).toBe("{ visitType }");
  });

  it("carries no personal data in the sample view", () => {
    // The preview fixture ships in the bundle, so it is held to the same rule as
    // any other tracked file: invented names only.
    expect(SAMPLE_VIEW.org).toBe("Example Health");
    expect(Object.values(SAMPLE_VIEW).every((value) => value.length > 0)).toBe(true);
  });
});
