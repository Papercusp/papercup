# BRIEF — SPEC.md UI deprecation cleanup: harness-home welcome empty-state + stale spec redirects

**Type / mission.** Implementation (a rebuild, not a string-swap) + a small stale-route cleanup. Build the chosen onboarding empty-state on the live harness home (the old empty-SPEC bootstrap toast/CTA surface was deleted), and clean the stale `/harness/<slug>/spec` redirect routes that still target a removed tab. Plan `spec-md-ui-deprecation-cleanup-2026-05-30` (Phases 2 + 4).

## The items (verbatim, plan `spec-md-ui-deprecation-cleanup-2026-05-30`)

- **spec-md-ui-deprecation-cleanup-2026-05-30 P-005** *(blocked-by P-004)* — Implement the chosen empty-state in HarnessDashboard — replace the empty-SPEC bootstrap toast/CTA at lines 2744/2772 with the D-002 direction.  (Unblocked P-004 done. NB: a REBUILD not a string-swap — HarnessDashboard.tsx the referenced 2744/2772 surface was deleted ad5897d58. Build the welcome empty-state on the live harness home HarnessDockShell / InsightsFirstVisitGate; confirm target surface with avi; verify in the Tauri shell.)
- **spec-md-ui-deprecation-cleanup-2026-05-30 P-009** — The friendly `/harness/<slug>/spec` redirect routes (`app/harness/[slug]/spec/page.tsx` + `apps/operator-vite/src/routes/harness/$slug/spec.tsx`) still target the removed `specTab=spec` (coerces to the AGENTS.md default — stale but harmless). Default: let `adv-harness-tab-migration-2026-05-30` delete them when it removes the `/harness` route; only act here if that migration stalls.

## Primary file surface (collision contract)
- `apps/operator/app/harness/[slug]/HarnessDockShell.tsx` + `apps/operator/app/harness/insights/InsightsFirstVisitGate.tsx` (build the D-002 welcome empty-state — confirm the exact target surface with avi; verify in the Tauri shell)
- the spec redirect routes: `apps/operator/app/harness/[slug]/spec/page.tsx` + `apps/operator-vite/src/routes/harness/$slug/spec.tsx`

**HOT-FILE SEQUENCING (critical):** `HarnessDockShell.tsx` is **shared with Brief 9 (desktop-workbench-verify-close)**, which goes FIRST on that file. **Sequence behind Brief 9** — `coord:*` before editing `HarnessDockShell.tsx`. Also note **P-009's default is deferral**: the spec redirects should be deleted by `adv-harness-tab-migration-2026-05-30` when it removes the `/harness` route — **only act on P-009 here if that migration stalls.** P-005 (empty-state) needs a UX call with avi on the chosen direction — confirm before building.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- The welcome empty-state renders on the live harness home in the Tauri shell (not a string-swap — the new surface, verified visually).
- Spec redirects either deleted-by-the-migration (preferred) or, if that stalls, repointed off the removed `specTab=spec`.
- `npm run test:affected` green; verify in the Tauri dev shell per the testing docs.
