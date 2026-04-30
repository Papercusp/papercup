# TESTING — @papercusp/plugin-loader

## What this project's tests cover

- `src/api-factory.test.ts` — capability-gated API surface; missing-cap
  errors, unknown-method errors, slot enumeration (11 tests).
- `src/capabilities.test.ts` — capability checks, scoped emit/listen
  guards (15 tests).
- `src/loader.test.ts` — plugin discovery from disk, role collection,
  conflict detection (8 tests).

## What they don't cover

- Live plugin execution against a real harness — covered by
  `apps/operator` integration tests.
- Plugin hot-reload — manual smoke only.

## Run after editing

| Edit touches             | Run                                                    |
| ------------------------ | ------------------------------------------------------ |
| `src/**`                 | `npm test --workspace @papercusp/plugin-loader`        |
| Anything that imports it | `npm run test:affected` from repo root                  |

See repo-root `CLAUDE.md` for the full testing strategy.
