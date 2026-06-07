# BRIEF — Promote policy + waves: the first real cross-repo dogfood (author the Restart universal-schema plan)

**Type / mission.** Dogfood authoring (cross-repo). The promote agent + staged/generative waves are built; this is the first real dogfood — author the `restart` `universal-schema-2026-05-30` plan's actual content so the promote pipeline has a genuine cross-repo wave to run. Plan `promote-policy-and-waves-2026-05-30` (Phase F). **The item text is truncated ("author the `restart` `universal-schema-2026-05-30` plan's actual …") — read the plan + the existing `universal-schema-2026-05-30` plan stub before authoring.**

## The items (verbatim, plan `promote-policy-and-waves-2026-05-30`)

- **promote-policy-and-waves-2026-05-30 P-015** — **First real dogfood:** author the `restart` `universal-schema-2026-05-30` plan's actual

## Primary file surface (collision contract)
- the **Restart repo** (`/home/marsh-office/Restart`) plan `universal-schema-2026-05-30` — authoring its actual items/acceptance (this is the cross-repo dogfood target, separate from the papercup tree)
- read-only against papercup's `promote-policy` module + the promote agent to understand the wave contract you are feeding

**Coordination:** this brief's *write* surface is the **Restart** repo plan, not papercup source — so it is collision-free against the other 15 papercup briefs. It does touch the Restart shared stack; follow Restart's own coordination/commit rules there (see the restart-stack skill). Do not edit papercup `promote.ts` (that's Brief 7).

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- The Restart `universal-schema-2026-05-30` plan carries real, promotable items with `[VAL-…]` acceptance bullets.
- A `plans:promote` dry-run / preview against it shows the wave would scaffold/import as intended (the dogfood round-trip).
- Capture the round-trip cost + duration as the dogfood evidence.
