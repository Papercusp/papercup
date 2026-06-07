# BRIEF — Self-learning central: reflection-firing + change-feed test coverage

**Type / mission.** Test authoring for the self-learning loop's invariants. Land the Phase-7 verification: reflection fires at the turn boundary + on each friction marker (and NOT on a clean turn); the matcher dedups across rephrasings; recurrence-decay reopens a regressed item; type-routing sends product->place / process->gym-or-gate; the never-auto set blocks graduation of a safety-gate path; the Change Feed regenerates from completions without a parallel log. Plan `self-learning-central-2026-06-06` (Phase 7).

## The items (verbatim, plan `self-learning-central-2026-06-06`)

- **self-learning-central-2026-06-06 P-060** — Reflection fires at boundary + on each friction marker (and NOT on a clean turn); the matcher dedups across rephrasings; recurrence-decay reopens a regressed item; type-route sends product→place / process→gym-or-gate; the never-auto set blocks graduation of a safety-gate path; the Change Feed regenerates from completions without a parallel log.

## Primary file surface (collision contract)
- new Vitest tests colocated with the self-learning / idea-queue / reflection modules (confirm the exact module paths via the plan — the reflection trigger, the dedup matcher, recurrence-decay, the type-router, the never-auto graduation gate, the Change Feed regeneration)
- **test files only** where the modules are already built; if a Phase-7 test reveals an unbuilt earlier-phase dependency, surface it (don't silently build ahead)

**Coordination:** additive test surface on the self-learning modules — disjoint from the other briefs. Stay off the spawn/fleet/coord surfaces other briefs own.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Each invariant in P-060 has a passing test: boundary + friction-marker firing (no clean-turn fire), cross-rephrasing dedup, recurrence-decay reopen, correct type-routing, the never-auto block, change-feed regeneration-from-completions.
- Tests discovered by the `/admin/testing` registry (`npm run lint:tests` clean) and green under `npm run test:affected`.
