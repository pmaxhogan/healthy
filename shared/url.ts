// The one URL rule both sides must agree on.
//
// Lives here, not in worker/api/schemas.ts, because the SPA's manual
// "enter a FHIR base URL" field (src/components/AddHealthSystemForm.vue) needs to
// reject the same input the Worker will reject -- before it round-trips a
// request just to find out. worker/** must not import src/** and src/** must
// not import worker/**, so the shared predicate belongs here, and the Worker
// schema imports it rather than keeping its own copy.

/** An absolute https URL. Everything this app talks to is https, without exception. */
export function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}
