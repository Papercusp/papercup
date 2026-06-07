# BRIEF — SU scenario suite (run when OAuth headroom returns) + the gated docs/memory prompt-rewrite watch

**Type / mission.** Two single-item, both-currently-gated items bundled as a single watch-and-run mission. (1) `su-scenario-suite`: the mechanics are validated (real direct-to-Anthropic SUT call, tool loop, asserts + judge all fired) — behavioral calibration is BLOCKED on shared Claude-Max OAuth saturation (429s fleet-wide); **run when headroom returns.** (2) `docs-and-memory-as-projections P-007`: the P4 persona/playbook prompt rewrites are BLOCKED behind the prompt-rewrite gate — **do not execute autonomously.** Plans `su-scenario-suite-2026-05-31` (Phase 3) + `docs-and-memory-as-projections-2026-06-05` (Phase 2).

## The items (verbatim)

- **su-scenario-suite-2026-05-31 P-005** — Run locally (`ANTHROPIC_API_KEY` + the in-process target → (mechanics validated 1st run: real direct-to-Anthropic SUT call, tool loop, asserts+judge all fired; behavioral calibration BLOCKED on shared Claude-Max OAuth saturation every call 429s fleet-wide. Retry when headroom returns.)

- **docs-and-memory-as-projections-2026-06-05 P-007** — P4 prompt rewrites (BLOCKED — gated by [[prompt-updates-pending]]) — the persona/playbook rewrites that teach the rationale projection (`rationale:feed`) + the settled memory layering. Held by plan design behind the prompt-rewrite gate; do not execute autonomously. The home-CLAUDE.md PLUR-instruction removal and the auto-memory index reconcile (over-limit → self-maintaining compaction) are already DONE via the shipped fix-claude-code-memory-2026-06-05 (su-84595). Remaining global/destructive cleanup — deleting the PLUR binary + the 406 stranded engrams — needs explicit owner confirmation (D-005 risk: it's the user's env, not the repo). (PLUR-cleanup half DONE 2026-06-05 moved to ~/_retired/plur-2026-06-05, see D-010; remaining = the gated prompt rewrites only)

## Gating posture (read before doing anything)
- **su-scenario-suite P-005** — not a code blocker; it needs OAuth headroom. Register a watch; when fleet-wide 429s clear, run the suite locally (`ANTHROPIC_API_KEY` + the in-process target) and capture the behavioral-calibration results. No source rewrite required to run it.
- **docs-and-memory P-007** — **HELD BY PLAN DESIGN behind the prompt-rewrite gate; do not execute autonomously.** The home-CLAUDE.md PLUR-instruction removal + the auto-memory index reconcile are already DONE (shipped fix-claude-code-memory-2026-06-05); the PLUR-cleanup is half-done (moved to `~/_retired/plur-2026-06-05`, D-010). The *remaining* destructive global cleanup (deleting the PLUR binary + the 406 stranded engrams) needs **explicit owner confirmation** (D-005 — it's the user's env, not the repo). The only remaining work here is the **gated prompt rewrites**, which are gated. Treat this item as **surface-and-wait**, not executable.

## Primary file surface (collision contract)
- `su-scenario-suite`: the SU playbook scenario files (`apps/operator/lib/llm-testing/scenarios/` SU role) — run-and-record, no new source
- `docs-and-memory`: the persona/playbook prompt files that teach `rationale:feed` + memory layering — **gated, do not edit until the gate lifts**

**Coordination:** the docs/memory prompt files overlap conceptually with Brief 5 (voice persona) but are gated and not to be edited — so no real collision. If you run su scenarios, mind shared OAuth — don't re-saturate the fleet.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- su-scenario-suite: when run with headroom, the behavioral calibration completes and results are recorded; until then a watch is registered (not a failure — it's gated on infra).
- docs-and-memory P-007: surfaced as gated/owner-confirmation-needed; **nothing destructive run.** No autonomous prompt rewrite.
