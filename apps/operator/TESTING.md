# TESTING — apps/operator

## What this project's tests cover

- `test/db.integration.test.ts` — smoke test for the shared
  `@papercusp/test-config` Postgres harness (boots testcontainers,
  per-file schema, round-trip insert).

## What they don't cover (yet)

- Harness-orchestrator API routes (planned in Phase 3 rollout).
- Zero-cache sync flow — covered upstream in `libs/zero-harness`.
- Browser flows — verified ad-hoc via the `verdict` skill; no
  checked-in regression suite (see root TESTING strategy doc, §1.4).

## Run after editing

| Edit touches                                | Run                                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| `app/**`, `lib/**` (pure logic / UI)        | `npm test --workspace apps/operator`                      |
| Anything that talks to Postgres or Drizzle  | `npm run test:integration --workspace apps/operator`      |
| Migrations under `libs/papercusp/libs/db/`  | `npm run test:integration` across **all** workspaces       |

## Local dev

- `npm test --workspace apps/operator -- --watch` — fast unit iteration.
- `npm run test:integration --workspace apps/operator -- --ui` — debug a
  failing integration test in the Vitest UI.
- Browser checks: use the `verdict` CLI skill, not Playwright.

## Requirements

- **Docker** must be running locally for integration tests
  (testcontainers boots `postgres:16-alpine`). On macOS install
  Docker Desktop or Colima; on Linux the host daemon is enough.
  Run `node scripts/test-doctor.mjs` from the repo root to verify.
