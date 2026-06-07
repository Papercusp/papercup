# BRIEF — Per-window workspace context (packaged shared-operator path) + apply the context-compaction migration

**Type / mission.** Two small, related operator-state items bundled because they share the operator/workspace-resolution surface and neither is large. (1) Per-window workspace context: the background-reader threading folds into the packaged shared-operator+PG-with-RLS path (Phase E) and the standalone migration-apply for context-compaction. (2) Apply the already-built context-compaction migration to the dev DB. Plans `per-window-workspace-context-2026-05-31` (Phases B/E) + `operator-context-compaction-2026-06-05` (Phase 1 close-out).

## The items (verbatim)

- **per-window-workspace-context-2026-05-31 P-020** — For each background reader (P-001 class b), thread an explicit (Audit done D-009: scanner scopes via global activeWorkspaceId correct in single-active-workspace model; orchestrator pinned via PAPERCUSP_WORKSPACE_ID. Runtime per-workspace threading folds into Phase E gated on the shared-operator packaging + is surfaced by P-021's diagnostic. Not a standalone dev change.)
- **per-window-workspace-context-2026-05-31 P-050** — Packaged uses **one** shared embedded-PG with RLS; stop the

- **operator-context-compaction-2026-06-05 P-008** — Apply migration to the dev DB (psql, manual on native :5432),

## Primary file surface (collision contract)
- `per-window-workspace-context`: the background-reader workspace threading + the packaged shared-embedded-PG-with-RLS path (Phase E) + the per-spawn `HOME` model — **note P-020 is a folded-into-Phase-E item gated on the shared-operator packaging (audit done D-009); it is NOT a standalone dev change.** P-050's text is truncated ("stop the …") — read the plan for the full Phase-E direction before acting.
- `operator-context-compaction`: **apply the migration manually** to native `:5432` (`psql "$DATABASE_URL" -f <NNN>-*.sql`) — the migration is built (P-001..P-007 done); P-008 is the live apply only.

**Coordination:** the migration apply touches the live dev DB only (no source rewrite). Per-window-workspace Phase E is packaging-gated — if it cannot proceed without the shared-operator packaging landing, surface that and do the migration apply + record the Phase-E dependency rather than half-building it. Disjoint from other briefs' source surfaces.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- The context-compaction migration applies cleanly to `:5432` (`db:check-drift` clean after); the compaction path works against the applied schema.
- Per-window Phase-E work either lands (with RLS + per-spawn HOME) or its packaging dependency is surfaced explicitly — **do not silently defer** (ask the owner per repo policy).
- `npm run test:affected` (+ `:integration` for schema) green.
