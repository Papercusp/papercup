# Papercup — agent guide

## Tests after editing

After completing any file edit, run the affected tests **before** declaring
the task done:

```bash
npm run test:affected                  # unit only — fast, default
npm run test:affected:integration      # also runs *.integration.test.ts
```

The walker (`scripts/affected-tests.mjs`) diffs against `origin/main`,
maps changed files to npm workspaces, computes the reverse-dependency
closure, and runs every affected workspace's `test` (and optionally
`test:integration`) script.

If your edit touches:

- `libs/papercusp/libs/db/**` (Drizzle schema / migrations) → run
  `npm run test:all:integration` — schema changes affect every
  workspace and the dependency graph won't catch them.
- `libs/papercup-shared/**` → already covered by the walker.
- `infra/**` or `Procfile*` → no automated coverage; manually verify.

Do **not** run `npm run test:all` for routine edits — it's slow and
produces noise. Use it only for pre-merge sanity checks or schema
changes.

## Browser checks — use `verdict`

For any browser verification (clicks, fills, screenshots, CSS
inspection, accessibility), use the `verdict` skill, **not** Playwright
MCP tools and **not** ad-hoc Puppeteer scripts. We do not maintain a
checked-in Playwright suite in v1; verdict is the entire browser
testing surface. See per-project `TESTING.md` for what's covered.

## Per-project TESTING.md

Each app and lib ships a `TESTING.md` at its root listing what its
tests cover, what they don't, and what to run after editing. Read
the relevant project's `TESTING.md` before adding tests so you match
the existing pattern.

## Test infrastructure

- Test runner: **Vitest 4** (all layers).
- Shared config: `@papercusp/test-config` exports `defineVitestConfig`,
  `getTestPg` / `withTestSchema` (testcontainers-node Postgres), and
  `setupMsw` / `msw`.
- Integration tests get a per-file Postgres schema (`t_<hex>`) on a
  reused `postgres:16-alpine` testcontainer.
- **Docker must be running locally** for integration tests. Run
  `npm run test:doctor` to verify your environment.

## CI

- Per-PR: `.github/workflows/test.yml` runs the affected unit +
  integration suites; results posted as a PR comment via JUnit.
- Nightly: `.github/workflows/test-nightly.yml` runs everything.

## Property-based tests

Use `fast-check` for invariant-style tests where examples undercount —
encoders/decoders, slug rewrites, hash canonicalisation, validator
predicates. Pattern: `<source>.property.test.ts` colocated with source.
See `libs/papercup-shared/src/_admin-paths.property.test.ts` for a
worked example.

## Dead-code / unused-export checks (knip)

```bash
npm run lint:knip       # report
npm run lint:knip:fix   # auto-remove obvious unused imports
```

Knip runs in CI **informationally** — its output never gates a merge.
Treat its findings as a discussion input. False positives (Next.js
dynamic chunks, fonts, CSS-only consumed packages) live in
`knip.json`'s `ignoreDependencies` allow-list.

## Flaky-test quarantine

Tests known to flake live in `quarantine.txt` at the repo root, one
entry per line as `<workspace-name>::<file>`. Quarantined workspaces
still run in CI but their failures don't gate the merge — the walker
prints a `[QUARANTINED]` marker and a non-gating warning.

A PR that touches a quarantined test's source must either de-quarantine
the test (remove the line) or document why it stays. Do not silently
skip flakes.

## Test secrets

API keys for tests use the `TEST_<SERVICE>_KEY` naming convention,
stored in GH Actions repository secrets and surfaced as env vars in
the workflows. Do **not** check live keys into fixtures.
