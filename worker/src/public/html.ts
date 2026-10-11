// The one HTML shell every server-rendered page shares: the login wall and the
// three public pages.
//
// These pages are rendered by the Worker rather than by the SPA because they must
// work when the SPA cannot be reached -- /about, /privacy and /terms are the URLs
// a third party (an app-registration reviewer, say) fetches, and they sit in
// front of the gate; the login page by definition renders when nothing is
// authenticated yet.
//
// Styling is one inline <style> block carrying the CSP nonce. It duplicates a
// handful of the SPA's design tokens on purpose: reaching into the built
// stylesheet would couple these pages to a Vite build that may not exist yet,
// and a stylesheet request from the login page would be a second round trip
// before the owner sees anything.

/** Escapes text for interpolation into element content or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Design tokens, light and dark, matching the SPA's palette so the login wall
 * does not flash a different theme than the app behind it.
 */
const STYLES = `
:root {
  --bg: #ffffff;
  --bg-raised: #f6f7f9;
  --bg-input: #eef0f3;
  --text: #17202a;
  --text-dim: #5b6572;
  --border: #dde2e8;
  --accent: #2563eb;
  --accent-text: #ffffff;
  --danger: #dc2626;
  --radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101418;
    --bg-raised: #1a2027;
    --bg-input: #232b34;
    --text: #e8ecf1;
    --text-dim: #93a0ae;
    --border: #2c353f;
    --accent: #3b82f6;
    --danger: #f87171;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 20px 64px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
main { max-width: 42rem; margin: 0 auto; }
h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 0.75rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.5rem; }
p, li { color: var(--text-dim); }
li { margin-bottom: 0.35rem; }
a { color: var(--accent); }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  background: var(--bg-input);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
  color: var(--text-dim);
}
.login {
  min-height: 70vh;
  display: grid;
  place-items: center;
}
.login form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(20rem, 85vw);
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
}
.login h1 { margin: 0; }
.login p { margin: 0; font-size: 0.9rem; }
input {
  font: inherit;
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  font: inherit;
  font-weight: 600;
  border: none;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
  background: var(--accent);
  color: var(--accent-text);
}
.error { color: var(--danger); }
`.trim();

export interface HtmlPageOptions {
  /** Document title. Kept generic -- these pages describe software, not a person. */
  title: string;
  /** CSP nonce from the securityHeaders middleware. */
  nonce: string;
  /** Body markup. Already escaped by the caller. */
  body: string;
  /** Extra class on <body>. */
  bodyClass?: string | undefined;
}

/** Renders the shell. */
export function htmlPage(options: HtmlPageOptions): string {
  const bodyClass =
    options.bodyClass === undefined ? "" : ` class="${escapeHtml(options.bodyClass)}"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(options.title)}</title>
<style nonce="${escapeHtml(options.nonce)}">${STYLES}</style>
</head>
<body${bodyClass}>
${options.body}
</body>
</html>
`;
}

/** An HTML response that no cache -- browser, CDN or service worker -- may keep. */
export function htmlResponse(
  html: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
