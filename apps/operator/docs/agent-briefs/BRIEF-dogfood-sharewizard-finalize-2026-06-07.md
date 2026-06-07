# BRIEF — Multi-engineer dogfood: wire ShareWizard finalize -> the shipped share/finalize route + substrate reboot

**Type / mission.** Frontend wiring closeout. The `POST /api/harness/:slug/share/finalize` route is shipped clean; the frontend is NOT done. Point `ShareWizard.tsx`'s finalize action at that route (passing `{github_remote, github_repository_id, privacy, discord_channel_url?}`), ensure the binding step supplies a real numeric `github_repository_id` (the swarm keys on it — 0/null leaves the swarm null), and trigger a substrate RE-BOOT on finalize (writing `shared.json` does not retroactively swarm-join an already-booted harness). Plan `papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26`.

## The items (verbatim, plan `papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26`)

- **papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26 P-003** — TODO (P-077 frontend, NOT done): point ShareWizard.tsx's finalize action at POST /api/harness/:slug/share/finalize (it currently no-ops / doesn't call the route), passing {github_remote, github_repository_id, privacy, discord_channel_url?}. NOTE: the github-facts/binding step must supply a real numeric github_repository_id (boot keys the swarm on it; 0/null → swarm stays null). Also needs a substrate RE-BOOT trigger: writing shared.json does not retroactively swarm-join an already-booted harness (bootHarnessSubstrate created it with swarm:null) — finalize should rebootHarness or it joins on next operator restart. Blocked this session: ShareWizard.tsx (649 lines) was unreadable via Read/grep/sed (tool-output unreliability) so I did not edit it blind.
- **papercusp-dogfood-phase11-multi-engineer-dogfood-2026-05-26 P-004** — CORRECTION to P-002: its commit hash was fabricated + first attempt was reverted (hallucinated API names). Finalize route NOW shipped clean (subject "ShareWizard finalize route — write .harness/shared.json (P-077)") against real APIs (buildFreshConfig/isHarnessSharedConfig/resolveHarnessPaths; writing shared.json IS the shared-flip — no registry state column; boot derives topic from github_repository_id). share-finalize 8/8, tsc clean. TODO frontend: ShareWizard already POSTs {state} but the binding step must supply a real numeric github_repository_id, and an already-booted harness needs a substrate reboot to swarm-join.

## Primary file surface (collision contract)
- `ShareWizard.tsx` (the finalize action + binding step — **note the prior-session blocker: this 649-line file was unreadable via the standard Read/grep at the time; do NOT edit it blind — read it fully first**)
- the finalize wiring to `POST /api/harness/:slug/share/finalize` (route already shipped: `buildFreshConfig`/`isHarnessSharedConfig`/`resolveHarnessPaths`)
- the substrate-reboot trigger on finalize (`rebootHarness` / next-restart swarm-join path)

**Coordination:** the share/finalize **route** is already shipped (P-004); this brief is the **frontend + reboot-trigger** side only. Disjoint from the federation/substrate-boot work — which is parked under EI-79 (see the index). Do not edit `lib/sync/hyperbee/**`; the reboot trigger calls the existing boot entry, it does not modify the hyperbee engine.

## Ground rules (identical for all 16 parallel briefs)

- **Work on the shared `staging` tree in place** (`/home/marsh-office/papercupai-workspace/papercup`). Do **not** `git worktree`, branch, or stash — one shared checkout, serialized by locks + coord.
- **Never `git commit` / `git push`** — the background **git-sync** routine owns commit + push (superproject + every submodule). Just leave your work in the tree; it lands on `origin/staging` within a few minutes, then green-checkpoint FFs it to `main`.
- **The per-edit file-lock hook is automatic.** If an edit is blocked because a peer holds the file, **coordinate via `coord:*` — do not force.** For a multi-file change you must hold atomically across several edits + a logical landing point, call `locks:acquire` by hand and `coord:declare-intent` first.
- **Convert the plan items you pick up to claimed state** (`plan_items:claim`, or open `work_items`) so the other 15 agents see them taken, and **update each item status when done** (`plan_items:status`).
- **Tests ship WITH the work**, in exactly one of the four canonical homes (Vitest `<pkg>/lib/**/<name>.test.ts`; Playwright `apps/operator/e2e/<name>.spec.ts`; Cargo `#[cfg(test)]`; LLM scenarios `apps/operator/lib/llm-testing/scenarios/<role>/`). **Never** add `.mjs` integration scripts or tsx smokes — CI lint fails the build.
- **`npm run test:affected` (+ `:integration` if you touched integration paths) / `cargo test` must be green before you claim an item done.** Schema/migration edits -> `npm run test:all:integration`.
- **A `needs-human` discovery is a HARD stop** — surface it (note it on the item / `coord:escalate`), never decide it yourself.

## Verification (what green looks like)
- ShareWizard finalize POSTs the full payload to the shipped route; the binding step supplies a real numeric `github_repository_id` (not 0/null).
- An already-booted harness swarm-joins after finalize (reboot triggered) — verified in the Tauri shell.
- share-finalize tests stay green (8/8); `tsc` clean; `npm run test:affected` green.
