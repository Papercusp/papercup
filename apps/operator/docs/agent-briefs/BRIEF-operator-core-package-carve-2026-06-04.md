# BRIEF — Carve `packages/operator-core` (SP1 C4 / Decision A)

**Plan:** `operator-core-headless-serve-2026-06-04` (SP1) — read it + **Decision A** + the "Risks" section first (`plans:get { slug, harness:'all' }`).
**This is SP1, not the TUI plan.** Separate owner/agent.

## ⛔ HARD GATE — do not start yet
This carve **collides with the in-flight `finish-next-removal-2026-06-01`** refactor of the same `app/`↔`lib/` `next/*`-shim seam. Starting concurrently = a multi-hour break of the live `:3070` host the **whole fleet** uses. **Do NOT begin until `finish-next-removal-2026-06-01` has landed** (check its `## Now`/status). Then run under a **held multi-file lock**, in a **supervised window**, coordinating in `coord:*`.

## Goal
Extract a clean **`packages/operator-core`** with **zero UI dependency** in the headless path; demote `apps/operator` to the UI package. End-state, not a permanent facade. The *functional* decoupling (C1–C3, `bin/serve.ts` + the `PAPERCUSP_SERVE_UI` gate) is already DONE — this is the physical package move.

## Verified scope (audit 2026-06-04)
- ~**1,564** `@/`-alias import sites across ~**780** files; ~**454** files reference `apps/operator`.
- First **cut ~19 `lib/`→`app/` back-edges**: move shared types out of `app/` to a neutral location (e.g. `app/harness/issues/types`, imported by `lib/endpoint-route/routes/harness/{issues,prs}.ts`); relocate the runtime coupler `lib/chat-cards/AskChoiceCardEntry.tsx`; handle the `.tsx` files living under `lib/` (`PluginReactTab.tsx`, `flag-hooks.tsx`, `router-compat/*.tsx`).
- Then codemod the alias/imports + move files.

## Method
Codemod-driven (not hand edits at that scale). Hold a lock over the moved set across the whole operation + the commit window. Keep the live `:3070` host green throughout (or do it during a coordinated quiet window).

## Testing
`npm run test:all:integration` (schema/graph-wide — the affected-walker won't catch a move this broad) + the `fresh-migrate` gate + a live `:3070` health check after. `npm run lint:knip` for orphaned exports.

## Done when
`packages/operator-core` builds + tests green with no `app/`/UI import; `apps/operator` consumes it; the live host + desktop still boot; full integration suite green.

## Do NOT
- …run concurrently with `finish-next-removal-2026-06-01`.
- …break the live host for the fleet — supervised + lock-held only.
- …turn it into a permanent facade; the goal is a real no-UI-dep package.

*(C5 — the desktop embedder refactor — is a separate, later, live-Tauri-verified job; not this brief.)*
