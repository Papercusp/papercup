# TESTING — @papercusp/export-state

## What this project's tests cover

62 passing unit tests covering:

- Snapshot capture/restore round-trip (`staging.test.ts`)
- Slug-rewrite over structured contexts (`slug-rewrite.test.ts`) —
  front-matter fields, path components, DB schema references
- **Property-based tests** (`slug-rewrite.property.test.ts`) — per
  testing-spec §1.12. Verifies idempotence, A→B→A reversibility,
  substring safety (worksheet/spreadsheet not corrupted), and
  ambiguous-prose reporting. Also documents one known limitation
  (slugs ending in non-word chars miss `\b`-bounded prose detection).

## What they don't cover

- Full restore against a live Postgres harness — covered by the
  per-harness integration tests in `apps/operator`.
- Browser flows — verified ad-hoc via the `verdict` skill.

## Run after editing

| Edit touches                | Run                                                       |
| --------------------------- | --------------------------------------------------------- |
| `src/slug-rewrite.ts`       | `npx vitest run --workspace libs/papercusp-export-state src/slug-rewrite*` |
| Any `src/**` file           | `npm test --workspace @papercusp/export-state`            |
| Restore-format change       | also re-run `apps/operator` integration suite             |
| Code that other workspaces depend on | `npm run test:affected` from repo root           |

See repo-root `CLAUDE.md` for the full testing strategy.
