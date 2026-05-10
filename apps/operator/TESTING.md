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

## Known issues

- **`lib/operator-card-reconstruction.test.ts`** fails with two
  tests under "PG-unavailable fallback". The file header (and test
  setup) implies `readLastScan` reads `<papercuspRoot>/system/operator/last-scan.json`
  when PG is unavailable, but the implementation in
  `lib/operator-last-scan.ts` was migrated to read from
  `harness_shared.operator_last_scan` exclusively (see the
  "Was previously file-based" comment at the top of that file).
  When the PG layer throws, the read propagates the throw rather
  than falling back to the file the test sets up. Either:
  - **Restore file fallback** in `operator-last-scan.ts` /
    `operator-state-pg.ts` — wrap the `getOrgPg()` call in
    try/catch and read from `<papercuspRoot>/system/operator/last-scan.json`
    on throw. The on-disk format the test expects is already
    canonical (matches `writeLastScan` output).
  - **OR rewrite the test** to mock `readLastScan` directly,
    bypassing the PG/file question — but that loses the original
    intent (verifying the fallback exists).
  Recommend the first fix; preserves the spec the test encodes.

## Resolved (2026-05-06)

- `lib/pty-ws.test.ts` round-trips binary input + `lib/pty-bridge.test.ts`
  geometry-correct-after-resize — both fixed by making
  `getScreenSerialization()` async and flushing the xterm-headless
  write queue (`headless.write('', cb)`) before calling
  `serializer.serialize()`. The xterm-headless `Terminal.write()` is
  queued asynchronously; the test's fast reconnect was racing the
  mirror-write. Single caller updated (`lib/pty-ws.ts:attachWsToPty`).

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
