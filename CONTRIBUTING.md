# Contributing

Thanks for looking. This is a single-user personal project, so the bar for
feature PRs is "does it help someone running their own instance" rather than
"is it generally useful".

## Before you open a PR

```sh
npm install        # installs the git hooks too
npm run check      # lint, typecheck, knip, test, build
```

`npm run check` is the whole contract. CI runs exactly it, the pre-push hook runs
exactly it, and Cloudflare runs it before deploying. If it passes locally it will
pass everywhere. `npm run fix` applies the mechanical half (eslint --fix and
Prettier).

You will also need [gitleaks](https://github.com/gitleaks/gitleaks) on your PATH
— the pre-commit hook scans staged changes with it.

## The one hard rule: no personal data

This repository is public and the application handles health information. **No
commit may contain personal data**, including:

- health-system, clinic, or provider names
- FHIR base URLs, organisation ids, or portal URLs
- email addresses, patient identifiers, or anything from a real record
- the Cloudflare Access team domain or application AUD
- locations, timezones, or board and list ids

Cloudflare _binding_ ids (D1 database id, KV namespace id, account id) are fine:
they are not credentials and they are useless without an API token.

All of the above belongs in a Worker secret or the D1 `settings` table, which is
also why the code has no defaults for any of it. `.local/` and `.dev.vars` are
gitignored and must stay that way.

## Style

- TypeScript strict, and the lint config is not advisory. If a rule is genuinely
  wrong for a case, disable it narrowly **with a comment saying why** — that
  convention is enforced by review, not by tooling.
- Tests: pure logic goes in `test/unit/` (fast, Node); anything touching D1, a
  Durable Object, or the Worker's request path goes in `test/integration/`,
  which runs in real workerd.
- No logging of tokens, patient data, or provider names. Structured JSON logs
  with explicit fields only.
- Commits are Conventional Commits (`feat:`, `fix:`, `chore:` …).

## Reporting a security issue

Please don't open a public issue — see [SECURITY.md](SECURITY.md).
