# TESTING — @papercusp/test-config

This is the testing library itself — it has no `*.test.ts` files of its
own. Coverage is verified by every consumer in the monorepo running
its tests against this config.

## What this project provides

- `defineVitestConfig({ layer })` — shared Vitest baseline (per spec §1.5).
- `getTestPg() / withTestSchema()` — testcontainers-node Postgres helper.
- `setupMsw() / msw` — MSW shared registry.
- `setup-fail-on-console.ts` — auto-applied unless `allowConsoleNoise: true`.

## What it does NOT provide

- Project-specific helpers — those belong in the consuming project per
  the spec's three-export rule. Resist adding more.

## Verify after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `vitest-config.ts`                  | `npm run test:all` (every consumer must pass)         |
| `pg-container.ts`                   | `npm run test:all:integration` (testcontainers users) |
| `msw.ts`                            | `npm run test:affected` from repo root                |
| `setup-fail-on-console.ts`         | `npm run test:all`                                    |

A change to this lib touches every workspace transitively — always
verify with `test:all` before committing, not just `test:affected`.

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
