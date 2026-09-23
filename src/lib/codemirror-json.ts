// Shared CodeMirror 6 setup for the two JSON widgets in the sandboxed "Try a
// tool" page (src/sandbox/SandboxApp.vue): the read-only viewer
// (src/components/JsonViewer.vue) and the editable argument editor
// (src/components/JsonEditor.vue). One theme and one highlight style, so the
// two ever look like the same product.
//
// Every colour is one of this app's own CSS custom properties (src/style.css),
// given to CodeMirror as a literal CSS string. CodeMirror's `EditorView.theme`
// and `HighlightStyle.define` both hand their values straight to a stylesheet,
// so `var(--accent)` is resolved by the browser at paint time -- the same
// light/dark switch the rest of the SPA gets from `prefers-color-scheme`, with
// no JavaScript here to keep in sync with it.

import { json } from "@codemirror/lang-json";
import { HighlightStyle, foldGutter, syntaxHighlighting } from "@codemirror/language";
import { search } from "@codemirror/search";
import { EditorView, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import type { Extension } from "@codemirror/state";

const jsonHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--accent)" },
  { tag: tags.string, color: "var(--ok)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warn)" },
  {
    tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace],
    color: "var(--text-dim)",
  },
]);

// CodeMirror's built-in styles for these elements are hard-coded to light-mode
// colours (a white search panel, grey gutters), which this app's dark theme
// would otherwise show through untouched. Everything the base theme colours is
// overridden here, by CSS var, so both themes stay in sync automatically.
const jsonTheme = EditorView.theme({
  "&": {
    color: "var(--text)",
    backgroundColor: "var(--bg-input)",
    borderRadius: "8px",
    border: "1px solid var(--border)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: "0.85rem",
    caretColor: "var(--text)",
  },
  ".cm-scroller": { maxHeight: "220px", overflow: "auto" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-input)",
    color: "var(--text-dim)",
    border: "none",
  },
  ".cm-foldGutter": { width: "1.1em" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--bg-raised)",
    borderColor: "var(--border)",
    color: "var(--text-dim)",
    borderRadius: "4px",
    padding: "0 4px",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent) !important",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--warn) 30%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--warn) 60%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--warn) 55%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--bg-raised)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { display: "flex", flexWrap: "wrap", gap: "6px", padding: "6px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
    color: "var(--text)",
    backgroundColor: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
  },
});

/**
 * Everything a read-only viewer and an editable editor agree on: line numbers,
 * the fold gutter, JSON syntax, the highlight style and the search panel, and
 * this theme. A caller adds editability (or its opposite) and a keymap of its
 * own on top.
 */
export function jsonBaseExtensions(): Extension[] {
  return [
    lineNumbers(),
    foldGutter(),
    EditorView.lineWrapping,
    json(),
    syntaxHighlighting(jsonHighlightStyle, { fallback: true }),
    search({ top: true }),
    jsonTheme,
  ];
}
