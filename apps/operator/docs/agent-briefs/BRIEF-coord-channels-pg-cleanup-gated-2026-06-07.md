# BRIEF — Coord channels FS->PG: the gated cleanup tail (remove dead FS path helpers + coord dirs + docs)

**Type / mission.** Cleanup + docs, **GATED**. The coord channels are ported to PG; this is Phase-5's destructive cleanup — remove the dead FS path helpers, delete the now-unused `coord/` channel dirs, amend the v2 plan's three FS-substrate rulings, and update the `@papercusp/coordination` README/example. Plan `coord-channels-pg-port-2026-05-30` (Phase 5). **All four items are blocked**, and the destructive step is gated behind an owner sign-off (P-014, `needs-human`) — so this brief is **mostly an after-blockers-clear watch** with a small ready-when-unblocked surface.

## The items (verbatim, plan `coord-channels-pg-port-2026-05-30`)

- **coord-channels-pg-port-2026-05-30 P-015** *(blocked-by P-012, P-013, P-014)* — Remove dead FS path helpers from `paths.ts` (`messagesDir`/`escalationFile`/`handoffFile`/`outboxFile`/`subscriptionsDir`/`watermarkFile` as applicable) and the `FsCoordLog` import.
- **coord-channels-pg-port-2026-05-30 P-016** *(blocked-by P-015)* — Delete the now-unused `coord/` channel dirs (messages, plan-events, escalations, handoffs, subscriptions, watermarks); leave the legacy rust-port flat `coord/*.jsonl` untouched.
- **coord-channels-pg-port-2026-05-30 P-017** *(blocked-by P-014)* — Amend the v2 plan's three filesystem-for-L3 rulings (the FS-substrate, per-writer-file, and detached-mode-first-class decisions) to record the reversal; link this plan as the successor.
- **coord-channels-pg-port-2026-05-30 P-018** *(blocked-by P-016)* — Update the `@papercusp/coordination` README + `examples/detached-mode.ts` note (the detached event-log path is no longer the product path).

## After blockers clear (the gating chain — do NOT execute prematurely)
- **P-015** is blocked by **P-012, P-013, P-014** (not in this briefable set — P-014 is the `needs-human` owner sign-off "confirm PG-only is final before deleting `coord/`"; P-012/P-013 are upstream porting items). Until P-014 is ratified by the owner and P-012/P-013 land, **do nothing destructive.**
- **P-017** is blocked by **P-014** (the same sign-off).
- **P-016** is blocked by **P-015**; **P-018** is blocked by **P-016** — an internal chain that becomes runnable in order once P-015 unblocks.
- **Suggested posture:** register a watch / `coord:declare-intent` on this plan; when the owner ratifies P-014 and P-012-P-014 are done, execute P-015 -> P-016 -> P-018 and P-017 in dependency order. **The `coord/` dir deletion is destructive and owner-gated — surface, do not decide.**

## Primary file surface (collision contract)
- `packages/operator-core/lib/agent-tools/coordination/.../paths.ts` (the dead FS helpers: `messagesDir`/`escalationFile`/`handoffFile`/`outboxFile`/`subscriptionsDir`/`watermarkFile` + the `FsCoordLog` import)
- the `coord/` channel dirs (messages, plan-events, escalations, handoffs, subscriptions, watermarks) — leave the legacy rust-port flat `coord/*.jsonl` untouched
- `@papercusp/coordination` README + `examples/detached-mode.ts`
- the v2 plan's three FS-for-L3 decision records (amend to record the reversal)

**Coordination:** owns `coordination/.../paths.ts` + coord dirs — **disjoint** from Brief 7 (promote.ts). Do not touch `promote.ts`.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Until unblocked: a watch is registered, intent declared, and nothing destructive has run.
- Once unblocked + owner-ratified: dead FS helpers removed, coord dirs deleted (rust-port flat log intact), README/example updated, the v2 decisions amended with the successor link; `npm run test:affected` green; coord round-trips still pass against PG.
