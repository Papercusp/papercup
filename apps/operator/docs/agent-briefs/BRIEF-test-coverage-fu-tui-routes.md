# BRIEF — Follow-up test coverage: tui-workbench `/api/tui/*` routes + auth-posture

**Parent:** BRIEF-test-coverage-2026-06-04 (lead: su-5cf8c). **Readiness: READY NOW** (su-a6146 reported "SP-TUI autonomously-completable scope DONE" — the P12a/P12b route surface is settled). **Coord-check `coord:presence` for su-a6146 before editing apps/tui or routes/tui; if they're still active, ping them first.**

## Why this exists
The test-coverage audit found the tui-workbench domain's **store layer** well covered (7 integration tests, real PG) but a **clean hole at the HTTP-route layer**: none of the `/api/tui/*` handlers' input-validation, 404, or response-envelope logic is tested, and the routes fall **outside** the `auth-posture.test.ts` registry-walk's rule families — so even their `auth:'public'` posture is unguarded. This was deferred from the parent brief because su-a6146 owned the surface while building it.

## Scope (NEW test files only; do not edit the route source)
Source under test: `packages/operator-core/lib/endpoint-route/routes/tui/index.ts` (layout/crew/view-state GET/PUT/DELETE) + `intent-result.ts` + `intents-stream.ts`.

1. **`packages/operator-core/lib/endpoint-route/__tests__/tui-routes.test.ts`** — invoke the `defineTool` route handlers directly with crafted `Request`s (precedent: `endpoint-route/__tests__/destructive-public-routes.test.ts` imports route modules directly + mocks `workspace-registry`). Cover:
   - `layoutPut`/`crewPut`/`viewStatePut`: `owner`/`name` required → 400; `kdl_required` / kdl-must-be-nonempty-string → 400; malformed-JSON body → `{}` fallback; `members` non-array → `[]` coercion.
   - `layoutGet`/`crewGet`: 404 on absent.
   - `layoutDelete`/`crewDelete`: the `{ ok, deleted: boolean }` envelope + 404 wiring.
   - `intent-result` + `intents-stream`: NOTE they gate via `isLoopbackRequest` (from `superuser-token`), a **different** helper than the `requireLoopbackOr403`/`isLoopbackHost` that `loopback-guard.test.ts` covers — so their loopback gating is **not** transitively covered. Add a direct assertion that a non-loopback request is rejected.

2. **Auth-posture gap** — `endpoint-route/__tests__/auth-posture.test.ts` walks `ALL_ROUTES` but its `RULES`/`MUST_BE_PUBLIC` cover **no** `/tui/` prefix. Decide with the route owner whether `/tui/*` should be in `MUST_BE_PUBLIC` (they're `auth:'public'` like the sibling coord routes) and add the assertion in a NEW file or (if the owner agrees) extend the posture rules. Don't silently leave the posture unguarded.

## Rules
- Canonical home = Vitest (`packages/operator-core/lib/endpoint-route/__tests__/*.test.ts`, or `.integration.test.ts` if hitting real PG via `@papercusp/test-config`). Read `destructive-public-routes.test.ts` first for the route-handler invocation pattern.
- Live-pui e2e (palette save→restore, real zellij, the dispatch→pui→result loop) is OUT OF SCOPE here and must use an **own Xvfb-driven pui instance** per `/internal/docs/testing/agent-e2e` (never the user's live `:0`). These route-handler tests don't need a live pui.
- Verify green: `cd packages/operator-core && npx vitest run [--config vitest.integration.config.ts] lib/endpoint-route/__tests__/tui-routes.test.ts`. Confirm `cd apps/operator && npm run lint:tests` still passes (registry-discovered).
