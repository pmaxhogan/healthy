// A client-side mirror of the title-template renderer, for the live preview in
// the health system editor.
//
// This is a PREVIEW ONLY. The Worker owns the real rendering at sync time; this
// exists so the owner can see the shape of a title while typing one, without a
// round trip per keystroke. The two agree on the placeholder names (below) and
// on the empty-value rule; if they ever disagree about anything subtler, the
// Worker is right.

/** Every placeholder a title template may contain, in the order the UI lists them. */
export const PLACEHOLDERS = [
  "visitType",
  "practitioner",
  "specialty",
  "orgShort",
  "org",
  "department",
  "apptTime",
] as const;

type Placeholder = (typeof PLACEHOLDERS)[number];

/** The values a title is rendered from. Any of them may be missing in real data. */
export type TemplateView = Partial<Record<Placeholder, string>>;

/**
 * A synthetic appointment used for the preview. Entirely invented -- no real
 * organisation, practitioner or department appears anywhere in this repository.
 */
export const SAMPLE_VIEW: Readonly<Required<TemplateView>> = Object.freeze({
  visitType: "Annual physical",
  practitioner: "Dr. A. Reyes",
  specialty: "Family medicine",
  orgShort: "Example",
  org: "Example Health",
  department: "Primary Care West",
  apptTime: "11:30",
});

/** The template used when a health system has not been given one of its own. */
export const DEFAULT_TITLE_TEMPLATE = "{visitType} · {practitioner}";

const TOKEN = /\{(?<name>[A-Za-z]+)\}/gu;

/**
 * Characters that only earn their place between two values.
 *
 * The tidy-up below is token based rather than a regex: a pattern that matched
 * "a separator with optional space on both sides, followed by another" needs
 * nested quantifiers and backtracks badly on adversarial input, and a template
 * is user-typed.
 */
const SEPARATORS = new Set(["·", "|", ",", "-", "–", "—", "/"]);
const WHITESPACE = /\s+/u;

export interface RenderResult {
  /** The rendered title, with empty placeholders and their separators removed. */
  text: string;
  /** Placeholder names in the template that this renderer does not know. */
  unknown: string[];
  /** Known placeholders in the template that the sample view has no value for. */
  empty: Placeholder[];
}

function isPlaceholder(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

/**
 * Substitutes `{placeholder}` tokens from `view`.
 *
 * An unknown token is left verbatim so a typo is visible in the preview rather
 * than silently swallowed. A known token with no value renders as nothing, and
 * the separator that would have been left stranded next to it is removed -- so
 * `{visitType} · {practitioner}` with no practitioner gives `Annual physical`,
 * not `Annual physical ·`.
 */
export function renderTitleTemplate(template: string, view: TemplateView): RenderResult {
  const unknown: string[] = [];
  const empty: Placeholder[] = [];
  // A Map lookup rather than `view[name]`: the key comes from user-typed text,
  // and indexing an object with it is exactly what security/detect-object-injection
  // is there to catch.
  const values = new Map<string, string>(
    Object.entries(view).flatMap(([key, value]) => (value ? [[key, value] as const] : [])),
  );

  // Walked by hand rather than with a `replaceAll` callback: the callback's
  // argument list shifts with the number of capture groups, and reading the
  // named groups out of it needs a cast that this loop does not.
  let substituted = "";
  let cursor = 0;
  for (const match of template.matchAll(TOKEN)) {
    const name = match.groups?.name ?? "";
    substituted += template.slice(cursor, match.index);
    cursor = match.index + match[0].length;

    if (isPlaceholder(name)) {
      const value = values.get(name);
      if (value === undefined) {
        if (!empty.includes(name)) empty.push(name);
      } else {
        substituted += value;
      }
    } else {
      if (!unknown.includes(name)) unknown.push(name);
      substituted += match[0];
    }
  }
  substituted += template.slice(cursor);

  return { text: tidy(substituted), unknown, empty };
}

/**
 * Drops separators that no longer sit between two values, and normalises runs of
 * whitespace to one space.
 *
 * Whitespace-delimited, so a separator written without spaces around it
 * (`{visitType}·{practitioner}`) is part of a token and survives even when one
 * side is empty. That is a preview limitation, not a rule: the Worker's own
 * renderer is what the calendar sees.
 */
function tidy(rendered: string): string {
  const kept: string[] = [];
  // Named `word`, not `token`: security/detect-possible-timing-attacks reads any
  // equality test against something called `token` as a secret comparison.
  for (const word of rendered.split(WHITESPACE)) {
    if (word === "") continue;
    if (SEPARATORS.has(word)) {
      const previous = kept.at(-1);
      // Nothing before it, or another separator before it: it joins nothing.
      if (previous === undefined || SEPARATORS.has(previous)) continue;
    }
    kept.push(word);
  }
  while (kept.length > 0 && SEPARATORS.has(kept.at(-1) ?? "")) kept.pop();
  return kept.join(" ");
}

/** The preview the editor shows: the sample appointment through the template. */
export function previewTitle(template: string): RenderResult {
  return renderTitleTemplate(template, SAMPLE_VIEW);
}
