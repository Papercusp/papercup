# TESTING — apps/operator

## What this project's tests cover

- `test/db.integration.test.ts` — smoke test for the shared
  `@papercusp/test-config` Postgres harness (boots testcontainers,
  per-file schema, round-trip insert).
- `e2e/home.spec.ts` — Playwright reference suite. Verifies the
  home page wordmark, header nav links, and basic Marketplace
  navigation. Doubles as the canonical example for adding more
  E2E coverage to other routes.

## What they don't cover (yet)

- Harness-orchestrator API routes (planned in Phase 3 rollout).
- Zero-cache sync flow — covered upstream in `libs/zero-harness`.
- The full agent-e2e checklist in `content/docs/testing/agent-e2e.mdx`
  is human-driven via verdict; only the home-page subset is automated
  in `e2e/`.

## Run after editing

| Edit touches                                | Run                                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| `app/**`, `lib/**` (pure logic / UI)        | `npm test --workspace apps/operator`                      |
| Anything that talks to Postgres or Drizzle  | `npm run test:integration --workspace apps/operator`      |
| Migrations under `libs/papercusp/libs/db/`  | `npm run test:integration` across **all** workspaces       |
| `app/page.tsx`, header, marketplace routes  | `npm run test:e2e --workspace apps/operator` (auto-starts dev server) |

## Local dev

- `npm test --workspace apps/operator -- --watch` — fast unit iteration.
- `npm run test:integration --workspace apps/operator -- --ui` — debug a
  failing integration test in the Vitest UI.
- `npm run test:e2e:ui --workspace apps/operator` — debug E2E with the
  Playwright trace viewer + UI mode.
- For ad-hoc browser checks (not regression coverage), the `verdict`
  CLI skill is faster than spinning up Playwright.

## Requirements

- **Docker** must be running locally for integration tests
  (testcontainers boots `postgres:16-alpine`). On macOS install
  Docker Desktop or Colima; on Linux the host daemon is enough.
  Run `node scripts/test-doctor.mjs` from the repo root to verify.
