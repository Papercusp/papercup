# BRIEF — App-wide test coverage (Wave-1 stable high-value: agent-mcp read-side + operator-core pure logic + UI)

**Type / mission.** Test authoring. Map and close coverage gaps in the **stable, non-churned** registry domains first (agent-mcp read-side tools, operator-core pure-logic/security clusters), then the UI wave, deferring `libs/generic` until the generalize carve settles. Output gap lists, then land Vitest unit/integration (+ property tests where examples undercount) and Playwright e2e for UI. Plan `app-wide-test-coverage-2026-06-05` (Phases 1-2).

## The items (verbatim, plan `app-wide-test-coverage-2026-06-05`)

- **app-wide-test-coverage-2026-06-05 P-001** — Wave-1 coverage audit (read-only): map gaps across the STABLE registry domains — agent-mcp read-side tools, operator-core utility/logic clusters, papercup-shared, flags. Output per-area gap lists {file, untested-path, suggested-test, canonical-home}. Skip churned surfaces.
- **app-wide-test-coverage-2026-06-05 P-002** — packages/agent-mcp/src read-side MCP tools coverage (~29% today): the tool handlers agents depend on — docs/search/harness-readers + the projection/auth-gating. Vitest unit + integration. Avoid harness readers being reshaped by work_items.
- **app-wide-test-coverage-2026-06-05 P-003** — operator-core/lib stable utility/logic clusters coverage: untested pure-logic + error/security paths NOT in any active agent's churn path (e.g. identity/auth helpers, rate-limit, validation, encoders/decoders, state derivation). Vitest unit + integration; property tests where examples undercount.
- **app-wide-test-coverage-2026-06-05 P-004** — apps/operator/app UI coverage (~30%): pure component/hook/state-derivation logic via Vitest + Playwright e2e (Tauri shell). Largest gap but partly churn-adjacent (tui/design) — sequence after Wave 1 + once UI churn settles.
- **app-wide-test-coverage-2026-06-05 P-005** — libs/generic coverage (~44%) — DEFERRED until the generalize-libs-to-generic carve settles (each extracted lib is landing with its own tests; re-audit the residual gaps after).

## Primary file surface (collision contract)
- **NEW TEST FILES ONLY**, colocated next to source in the four canonical homes — this brief is additive (`.test.ts` / `.spec.ts`), so it rarely collides on source files.
- `packages/agent-mcp/src/**/*.test.ts` (read-side MCP tool handlers — docs/search/harness-readers + projection/auth-gating)
- `packages/operator-core/lib/**/*.test.ts` (stable pure-logic + error/security: identity/auth helpers, rate-limit, validation, encoders/decoders, state derivation) — **stay off files another brief is actively rewriting** (esp. `fleet/`, `sync/hyperbee/`, the spawn chokepoint); the item text says skip churned surfaces, which is also the collision-avoidance rule here.
- `apps/operator/e2e/*.spec.ts` + `apps/operator/app/**/*.test.tsx` (UI — pure component/hook/state-derivation; sequence after Wave 1)
- P-001's gap-list output is a doc artifact (per-area `{file, untested-path, suggested-test, canonical-home}`).

**Coordination:** because this brief writes tests across many packages, **check `coord:presence` before authoring tests in a package another brief owns** (it may be reshaping the source). Prefer the explicitly-stable clusters; defer churn-adjacent UI (tui/design) per P-004.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- P-001 gap lists exist per stable domain.
- New tests are discovered by the `/admin/testing` registry glob walk (run `npm run lint:tests` — fails if a canonical test matches no registry glob) and pass under `npm run test:affected` (+ `:integration`).
- libs/generic (P-005) is left DEFERRED with a one-line note — do not start it until the generalize-libs carve settles.
