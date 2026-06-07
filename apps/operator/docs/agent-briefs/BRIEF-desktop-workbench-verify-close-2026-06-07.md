# BRIEF — Desktop workbench shell: live visual E2E verify + docs + flip shipped

**Type / mission.** Verify + close. The 3-pane dock workbench is built (51 Vitest green); this brief does the live VISUAL isolated-Tauri E2E (own Xvfb+VirtualGL bridge, never the user's `:0`), then the docs touch-up + plan-lint-0 + flip-shipped — **only after** the live pass. Plan `desktop-workbench-shell-2026-06-05` (Phase 3). P-008 is blocked-with-cause (gated by the red release-gate deploy D-006 + a supervised pass) — confirm the gate has cleared before the live pass.

## The items (verbatim, plan `desktop-workbench-shell-2026-06-05`)

- **desktop-workbench-shell-2026-06-05 P-008** — Live VISUAL isolated-Tauri E2E (Xvfb + VirtualGL, own bridge — never the user's `:0`): the 3-pane workbench renders + persists layout; the wizard shows the live previews. **Blocked with cause (D-008):** the `dock-layouts` seed runs server-side, so a real webview needs the operator running these `main` edits — gated by the red release-gate deploy (D-006) + a supervised pass. Runbook recorded in D-008; automated coverage (51 Vitest) stands in meanwhile.
- **desktop-workbench-shell-2026-06-05 P-009** — Docs touch-up (a workbench page in operator-docs) + plan lint 0 + flip shipped — **after** the D-008 live pass (don't flip shipped on unverified-live UI).

## Primary file surface (collision contract)
- `apps/operator/app/harness/dock/**` (workbench panels, dock shell, layouts) + `apps/operator/app/harness/[slug]/HarnessDockShell.tsx`
- the `dock-layouts` server-side seed path
- a new workbench page in `apps/operator-docs/src/content/docs/`
- the isolated-Tauri E2E harness (own bridge under Xvfb+VirtualGL)

**HOT-FILE SEQUENCING (critical):** `apps/operator/app/harness/[slug]/HarnessDockShell.tsx` is **shared with Brief 10 (spec-md-ui empty-state)** — Brief 10 builds the SPEC welcome empty-state on `HarnessDockShell`/`InsightsFirstVisitGate`. **This brief (workbench) goes FIRST on `HarnessDockShell.tsx`; Brief 10 is sequenced behind it.** Brief 10 must `coord:*` with you before editing that file. Your workbench changes are largely verify-only (the dock is built), so hold the file only as long as needed.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- Live isolated-Tauri E2E: the 3-pane workbench renders + persists layout; the wizard shows live previews (runbook in D-008). Never the user's `:0`.
- Docs page added; `plans:lint` = 0; plan flipped `shipped` **only after** the D-008 live pass (don't flip shipped on unverified-live UI).
- `npm run test:affected` green (the 51 Vitest stay green).
