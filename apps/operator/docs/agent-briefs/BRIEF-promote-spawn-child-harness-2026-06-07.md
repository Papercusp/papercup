# BRIEF — Let a promote wave spawn a child harness (scaffold -> synth-plan -> import -> start)

**Type / mission.** Implementation. Teach `plans:promote` to spawn a child harness when a wave carries `spawn_child` + `apply:true`: scaffold the child, synthesize its seed plan, import the wave's features into the child, and start it — with anti-over-spawn guidance authored across the tool/template/policy surfaces, a preview path on `apply:false`, parent write-back, and end-to-end Vitest+integration coverage. Plan `promote-spawn-child-harness-2026-05-31` (Phases 2-3). **P-003 is the keystone — do it first; it unblocks P-004 + P-006 in this same brief.**

## The items (verbatim, plan `promote-spawn-child-harness-2026-05-31`)

- **promote-spawn-child-harness-2026-05-31 P-003** *(blocked-by P-001)* — In `apps/operator/lib/agent-tools/coordination/tools/promote.ts`, when the resolved wave carries `spawn_child` and `apply:true`: (1) call `scaffold_harness` for `spawn_child.slug` via the existing execute-action path — parent **sealed from the promote caller's identity, NOT from YAML**; reuse `detectCycleOrTooDeep`; (2) synthesize the child seed plan per D-002 (goal + items + acceptance→VAL-*) and write it to the child's plans scope; (3) `postFeaturesImport()` the wave's features into the **child** slug with `source_plan_slug = <child-seed-slug>`; (4) `plans:start` the child seed plan. On `apply:false` (preview): report what *would* be created (child slug, seed plan, feature count) with **no** side effects. All failures → `warnings[]`, never throw (D-004).
- **promote-spawn-child-harness-2026-05-31 P-005** — Author the anti-over-spawn guidance (D-001) in: (a) the `plans:promote` tool `guidance` field, (b) the plan-template `## Promote` block comments (the surface the agent reads when authoring a plan — locate it; this is the "we recently added promote instructions" surface), and (c) the promote-policy module doc-comment. Rule: *spawn_child only for cross-repo or own-lifecycle work; same-repo sub-work stays as features in the current harness.*
- **promote-spawn-child-harness-2026-05-31 P-004** *(blocked-by P-003)* — Parent write-back: in the parent plan's `## Promoted` block, annotate the wave's rows with `→ spawned child <slug> (plan <seed-slug>)`; mark parent `from_items` done as today. Verify the `afterDone` builtin hook posts a `Completion` message back to the parent when the child finishes (so the parent agent learns sub-work is done); wire it if missing.
- **promote-spawn-child-harness-2026-05-31 P-006** *(blocked-by P-003)* — End-to-end verification per the testing docs — Vitest for the parse/promote unit + an integration test that promotes a spawn_child wave against a scratch workspace and asserts: child schema exists, child seed plan started, child features carry the seed slug, dispatcher would pick them up. No new `.mjs`/tsx scripts — Vitest homes only.

## Primary file surface (collision contract)
- `apps/operator/lib/agent-tools/coordination/tools/promote.ts` (the spawn_child branch: scaffold/synth/import/start + preview)
- the promote-policy module + its doc-comment (anti-over-spawn guidance D-001)
- the plan-template `## Promote` block comments + the `plans:promote` tool `guidance` field
- the parent-plan `## Promoted` write-back + the `afterDone` completion-message hook
- new Vitest parse/promote unit + an integration test promoting a spawn_child wave against a scratch workspace

**Coordination:** owns `coordination/tools/promote.ts` and promote-policy — **disjoint** from the coord-channels FS->PG cleanup (Brief 8, which owns `coordination/tools/.../paths.ts` + the `coord/` dirs). Don't touch `paths.ts`/coord channel dirs. Internal sequence: **P-003 -> (P-005 in parallel) -> P-004 + P-006.**

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- `apply:true` spawn_child wave: child schema exists, child seed plan started, child features carry the seed slug, the dispatcher would pick them up; `apply:false` is a pure preview (no side effects).
- Parent write-back annotates the wave rows + the `afterDone` hook posts a `Completion` back to the parent.
- Anti-over-spawn guidance present in all three surfaces (tool guidance, template comments, policy doc-comment).
- Vitest unit + the scratch-workspace integration test green; `npm run test:affected` green. No new `.mjs`/tsx scripts.
