---
title: Plan — Next.js removal from `apps/operator`
slug: next-removal-plan-2026-05-20
status: superseded
created: 2026-05-20
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-20 **Author:** Next-removal agent. **Status:** Draft for user review. **Do not start until approved.**

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Plan — Next.js removal from `apps/operator`

**Date:** 2026-05-20
**Author:** Next-removal agent.
**Status:** Draft for user review. **Do not start until approved.**

---

## Scope

Replace Next.js as the host runtime of `apps/operator`. Keep everything below the Next layer (`lib/`, `packages/agent-mcp`, `libs/sync`, Hono routers, endpoint-system, the IPC bridge, fumadocs MDX content, the design tokens, the Tauri sidecar build target) intact.

**In scope:**

- 240 `route.ts` files in `app/api/**`.
- 63 `page.tsx` files across `app/**`.
- ~804 files importing from `next/*`.
- `next.config.js`, `next-env.d.ts`, `middleware.ts`, the `instrumentation*.ts` pair.
- `fumadocs-mdx`/`fumadocs-ui` rendering for `/internal/docs/*` and `/docs/*`.
- The `next build` → `next/standalone` → `papercusp-desktop/src-tauri/sidecar/` bundle pipeline.
- The Hono catch-all wrapper in `app/api/[[...route]]/route.ts` (re-host its `app` directly).
- TanStack Router replacement for Next's app router.

**Out of scope:**

- Any file in `apps/operator/lib/endpoint-ipc/` or `apps/operator/lib/transport-adapters/` (host-architecture v2 Phase 1 owns these).
- Any file in `packages/agent-mcp/**`, `libs/sync/**`, `libs/papercusp/**`.
- `apps/operator/tsconfig.json` until cutover (host-architecture Phase 6a owns this).
- The IPC framing protocol, the Rust side of the bridge, or anything in `papercusp-desktop/src-tauri/src/`.
- Re-architecting handler logic. We're replacing the host, not refactoring code under it. A1-class routes (per host-arch Phase 4 audit) keep their handler bodies exactly.
- Mobile (`apps/papercup/`, `papercup-rust-mobile/`, `apps/papercusp-publish/`) — these are separate apps; out of scope here.

---

## Approach — parallel directory, cutover later

New directory `apps/operator-host/` (working name) holds the new app. `apps/operator/` keeps running unchanged throughout development. Cutover is one PR that flips the dev/build scripts.

**Why parallel and not in-place:** the host-architecture v2 plan is concurrently landing IPC polyfills (Phase 1), the platform adapter (Phase 2), the dispatcher middleware extraction (Phase 3a), and tsconfig project references (Phase 6a). Rewriting 240 route files in place while v2 is also editing the same tree means we collide on every PR. Parallel means we share exactly one file (the Hono catch-all) for the duration. The cost of parallel is the cutover work; the cost of in-place is constant friction for 16–20 weeks.

---

## Target shape

```
apps/operator-host/
├── package.json                 # vite + @hono/node-server + tanstack-router
├── vite.config.ts               # replaces next.config.js
├── tsconfig.json                # mirrors apps/operator/ Phase 6a refs after they land
├── server/
│   ├── index.ts                 # node http: hosts Hono app + serves dist/ static
│   ├── app.ts                   # re-exports the Hono app from apps/operator/app/api/_hono/app.ts
│   └── docs-sidecar.ts          # optional: thin proxy to a fumadocs sub-process (see docs section)
├── src/
│   ├── main.tsx                 # vite entry
│   ├── root.tsx                 # RootPlatformProvider + polyfill mount + RootSyncProvider equivalent
│   ├── routes/                  # tanstack-router file-based; mirrors app/ page tree
│   └── lib/                     # only if a piece of apps/operator/lib genuinely cannot be reused
└── README.md
```

**Imports:** everything in `src/` and `server/` can `import { … } from '../../operator/lib/…'` until cutover. After cutover, either re-root `apps/operator/lib/` to a shared location or leave it where it is and update import paths. Decision deferred — cheap either way.

---

## Phases

Each phase is a separable batch with its own acceptance test, PR list, and rollback. Phases land sequentially; each builds on the previous.

### Phase 0 — Catch-all Hono `app` extraction (the one in-place change)

The only PR I land inside `apps/operator/` for the first ~8 weeks.

- Extract the assembled Hono `app` instance from `apps/operator/app/api/[[...route]]/route.ts` into `apps/operator/app/api/_hono/app.ts`.
- New file exports the `app` instance + the side-effect bootstraps (`startAutoLoopOnce`, `ensureHarnessFsWatcher`, etc.) as a single `getApp()` function or top-level `app` const + lazy bootstrap.
- The route file shrinks to `import { app } from './app'; export const GET = handle(app); ...`.
- Behavior identical; existing Next dev + standalone bundle keep working.

**Acceptance:** `curl http://localhost:3055/api/harness/list` returns the same payload pre- and post-PR; existing integration tests pass; `app.fetch` is importable from outside the `app/api/` route file.

**Coordination:** post in `coord/frontend.jsonl` 24h ahead; `locks:acquire` on the route file before editing; ping the host-architecture agent in the PR description. They're not blocked by this — `dispatch-projected.ts` and IPC infrastructure don't touch this file.

**Rollback:** revert the PR. Single file moved; trivial.

### Phase 1 — Scaffold the new dir

- Create `apps/operator-host/` with `package.json`, `vite.config.ts`, `tsconfig.json`, empty `src/main.tsx`, empty `server/index.ts`.
- Add `@hono/node-server`, `vite`, `@vitejs/plugin-react`, `@tanstack/react-router`, `@tanstack/router-vite-plugin`.
- `server/index.ts`: bare-bones `http.createServer` that hosts the imported Hono `app` on `/api/**` and serves `dist/` for everything else with a SPA fallback. Default port 3055 (matches current operator). `PAPERCUSP_BIND_HOST` env-honored.
- Smoke test: `npm run dev` from the new dir, hit `http://localhost:3055/api/harness/list` — same payload as current operator. The static client side is still an empty React shell at this point.

**Acceptance:** API parity for one curl. Empty page renders. Dev server hot-reloads on edits to `src/`.

**Rollback:** delete `apps/operator-host/`. No external system references it yet.

### Phase 2 — Router shell + design tokens + global styles

- TanStack Router wired with file-based routing via `@tanstack/router-vite-plugin`.
- `src/routes/__root.tsx` = `RootPlatformProvider` + the polyfill mount slot (documented as the IPC polyfill's mount point) + `RootSyncProvider` import from `apps/operator/app/_components/RootSyncProvider.tsx` (re-used as-is — it's already `'use client'`-tagged, which Vite ignores, and the Zero provider underneath has no Next dependency).
- `src/globals.css` re-exports `apps/operator/app/globals.css` (or imports it directly). Same for `_brand-primitives.css`, `_semantic.css`.
- `apps/operator/papercusp-desktop` design tokens are read from the existing `design-tokens/` build output — no change.

**Acceptance:** the new dir's root route renders the chrome shell, sidebar, toaster, all the same providers as the current operator's `app/layout.tsx`, with no Next imports. `grep -r "from 'next/" src/ server/ | wc -l` = 0.

**Rollback:** the new dir is still isolated; nothing outside imports from it.

### Phase 3 — Page migration: the harness route as the proving ground

The harness route is the SSE-heavy connection-pool source (memory: `project_harness_sse_pool_exhaustion.md`). It's where the IPC polyfill's value is most visible and the routing complexity is highest. Doing it first surfaces every problem.

- Port `app/harness/page.tsx` + its `app/harness/**` component tree into `src/routes/harness.tsx` (TanStack route file) + `src/components/harness/*`.
- Replace `next/navigation` → TanStack equivalents (`useNavigate`, `useSearch`, `Link`).
- Replace `next/image` → plain `<img>` or a small wrapper if there's a real reason.
- Replace `next/link` → TanStack `Link`.
- Verify `nuqs` works — `nuqs/adapters/next/app` swaps for `nuqs/adapters/react-router` or the generic adapter. Memory says `nuqs` is the default for almost-all state, so this is load-bearing; I verify with the Design tab's heavy filter state.
- All API calls keep their existing `/api/**` URLs — no client code changes.
- SSE streams (Zero sync, log, popover, ui-intents) connect via the existing `createResilientEventSource` path; on desktop they go through the IPC polyfill installed at the root.

**Acceptance:** `npm run dev` in `apps/operator-host/`, navigate to `/harness`, the route loads with all panels, no console errors, SSE streams connect, `ss -tnp` shows ≤ 2 ESTAB connections at rest (matches the IPC polyfill's host-architecture acceptance bar). E2E test from `apps/operator/e2e/` ports cleanly to the new dir.

**Rollback:** delete the harness route from `src/routes/`; new dir reverts to empty shell.

### Phase 4 — Page migration: the rest of the 63 pages

Sequenced by traffic + complexity:

1. `/login`, `/signup`, `/setup` — auth surface, low complexity, exercises cookie-reading routes early.
2. `/settings/*` — moderate; flags + backups + credentials + design tabs.
3. `/admin/*` — admin tooling; some heavier UIs.
4. `/dev/*` — internal dev pages.
5. `/marketplace/*`, `/installed/*`, `/snapshots/*`, `/wiki/*`, `/pi/*`, etc. — the long tail.
6. `/(docs)/docs/*` and `/(docs)/internal/docs/*` — fumadocs (see Phase 7).
7. `/` (root page).

Each page is a batch PR; each PR has its own acceptance e2e port.

**Acceptance per PR:** the page renders, all interactions work, all of its referenced server endpoints answer correctly, e2e port passes.

**Estimate:** ~6 pages/week sustained → ~10 weeks for 63 pages once Phase 3 settles the patterns.

**Rollback:** per-PR revert.

### Phase 5 — `next/headers` / `cookies()` route conversion

The 6 routes that use `cookies()` need replacement before cutover (they're under `app/api/auth/*` and `app/api/agent-mcp/operator-converse`). They keep running under Next until cutover; in parallel I add Hono-native equivalents inside `_hono/`:

- New `_hono/auth.ts` with the auth routes ported to Hono handlers using `getCookie(c, name)` from `hono/cookie`.
- Mount them on the existing Hono `app` (they're already in the catch-all's API space, just currently as standalone Next route files).
- Delete the Next route files **at cutover, not before** — keeping both up means double maintenance for ~8 weeks but avoids a flag day.

**Acceptance:** Hono versions return identical responses to the Next versions for the same input (recorded request/response pairs from integration tests).

**Rollback:** delete the new `_hono/auth.ts`; Next routes are untouched.

### Phase 6 — The other 234 standalone `route.ts` files

The remainder of `app/api/**/route.ts` that **don't** mount the Hono `app`. Each is a small Next route handler that needs a Hono equivalent.

Per host-architecture v2 Phase 4 audit (when it runs):

- **A1-class** routes (do real business logic) — port handler **wrapper** to Hono; handler body unchanged.
- **Genuinely migratable** routes — host-architecture Phase 4 will pull these into endpoint-system tools. **I don't touch these.** They disappear from my count.
- **Trivial PG-read/return** — port to Hono.

Without the audit output: I treat every route as A1-class (preserve handler body, swap wrapper). This is the safe default.

**Sequencing:** by directory, matching the page-migration order (auth first, then settings, then admin, then dev, then long tail).

**Acceptance per batch:** all routes in the batch have Hono equivalents mounted on the catch-all `app`; original Next route file slated for deletion at cutover.

**Estimate:** the route wrapper conversion is mechanical — `export const POST = async (req: NextRequest) => …` → `app.post('/path', async (c) => …)`. Conservatively ~15 routes/week sustained = ~16 weeks for 234. Likely faster after the first 50 establish a transform pattern.

**Rollback:** per-batch revert.

### Phase 7 — fumadocs

Decision: **keep fumadocs MDX loader; reshape the renderer.**

Two viable paths:

**(a) Tiny Next sidecar.** A `apps/operator-docs/` mini-app that's still Next-powered, mounted as a sub-process listening on `:3056`, with `apps/operator-host/`'s main server proxying `/docs/*` and `/internal/docs/*` to it. Simple; preserves every existing MDX page exactly.

**(b) Vite + MDX pipeline.** Replace `fumadocs-ui` (Next-coupled) with a hand-rolled MDX renderer using `fumadocs-mdx` (the loader is framework-agnostic). Bigger change; achieves true Next-free.

**Recommendation: (a) first, evaluate (b) as a follow-up.** Reasoning:

- The `docs:outline` / `docs:get` / `docs:search` MCP tools (memory: `project_docs_retrieval_phase1.md`) read MDX files directly via the loader — that path stays.
- The user-facing HTTP rendering is the only Next-coupled piece. Isolating it in a sub-sidecar means I'm not blocked on solving "Astro vs custom" before cutover.

User can override and choose (b) up front; that adds ~2 weeks to the timeline.

**Acceptance:** `/internal/docs/agent-policies` and `/internal/docs/index` render identically pre- and post-cutover.

**Rollback:** kill the docs sub-process; revert the proxy mount.

### Phase 8 — Tauri sidecar build pipeline

The current pipeline:

- `next build` → `.next/standalone/` → `papercusp-desktop/bin/release-local.sh` copies into `src-tauri/sidecar/` → Tauri packages it.

Replacement:

- `vite build` → `apps/operator-host/dist/` (client) + tsc/esbuild bundle of `server/index.ts` → combined into `apps/operator-host/dist-server/` → copied into `src-tauri/sidecar/` by an updated `release-local.sh`.

**Same shape, simpler:** one `node server.js` invocation in the sidecar, same port, same behavior. No `next/standalone` postbuild dance, no `outputFileTracingIncludes` for `node-pty`'s prebuilds (handled by direct esbuild externals instead).

**Acceptance:** `papercusp-desktop/bin/release-local.sh` produces a runnable Tauri build; the packaged app boots, the harness page works, the IPC bridge works, the embedded-PG path works, console errors are 0.

**Rollback:** the script is the single point of swap. Revert it; the build returns to Next.

### Phase 9 — Cutover

Single PR:

1. Add `apps/operator-host/` as a workspace member if not already.
2. Update `papercusp-desktop` to depend on `apps/operator-host/` for the sidecar build.
3. Delete `apps/operator/app/api/[[...route]]/route.ts` (the Next wrapper file — its `app` import is unchanged, just no Next handler exports).
4. Delete every other `app/api/**/route.ts` whose Hono equivalent has shipped in Phase 5/6.
5. Delete every `page.tsx` whose TanStack equivalent has shipped in Phase 3/4.
6. Delete `next.config.js`, `next-env.d.ts`, `middleware.ts`, `instrumentation*.ts`.
7. Delete `apps/operator/source.config.ts` if Phase 7 chose path (b); keep if (a).
8. Remove Next dependencies from `apps/operator/package.json`.
9. Rename `apps/operator-host/` → `apps/operator/` (and rename the old to `apps/operator-legacy/` for one stability window, then delete in a follow-up).

**Acceptance:** entire app boots from the new host; all 240 routes answer; all 63 pages render; Tauri build packages and runs; the harness page connects under IPC polyfill conditions with ≤ 2 ESTAB connections.

**Rollback:** revert the cutover PR. The old `apps/operator/` is intact (it never stopped working) — re-point the dev script + sidecar build back.

### Phase 10 — Cleanup

After a stability window (~2 weeks):

- Delete `apps/operator-legacy/`.
- Delete any `lib/` files that turned out to be Next-specific shims (most won't be).
- Update CLAUDE.md and the operator AGENTS.md to reflect the new shape.
- Update memory:
  - `feedback_webapp_retired_use_tauri_dev.md` — note that "Tauri dev" now points at the Vite-based host.
  - `project_papercup_deployment_model.md` — same.
  - Memory about Next standalone bundles obsolete; remove or annotate.

---

## Honest timeline

| Phase | Duration | Cumulative |
|---|---|---|
| 0 — catch-all extraction | 2 days | 2d |
| 1 — scaffold | 1 week | 1w 2d |
| 2 — router shell + globals | 1 week | 2w 2d |
| 3 — harness route (proving ground) | 2 weeks | 4w 2d |
| 4 — remaining 62 pages | 10 weeks | 14w 2d |
| 5 — cookie/auth route conversion | 2 weeks (parallel with 4) | overlaps |
| 6 — remaining 234 routes | 16 weeks (parallel with 4) | overlaps |
| 7 — fumadocs sub-sidecar | 1 week | within 16w |
| 8 — Tauri sidecar pipeline | 1 week | within 16w |
| 9 — cutover | 3 days (after all above ship) | ~18w |
| 10 — cleanup | 2 weeks (stability window + sweeps) | ~20w |

**Total realistic: 18–20 weeks of focused work**, assuming no path (b) on docs, no major audit-driven re-classifications, no parallel work blocking, and that host-architecture v2 Phase 4 either (a) doesn't migrate routes I'm porting (b) does — in which case my count goes down.

**Worst-case stretch to 6 months** if the audit reveals A1-class business logic in routes I assumed were trivial, or if path (b) is chosen for docs.

---

## Coordination with host-architecture v2

Committed positions (mirrored in `next-removal-agent-reply-2026-05-20.md`):

- `apps/operator/tsconfig.json` is theirs (Phase 6a). I don't touch.
- `apps/operator/lib/endpoint-ipc/` and `apps/operator/lib/transport-adapters/` are theirs (Phase 1). I don't touch.
- The polyfill mount point at root: documented contract in `apps/operator-host/src/root.tsx`, IPC polyfill installs there.
- The Hono catch-all `app` extraction (Phase 0 above) is my one shared edit; coordinated via `coord/frontend.jsonl` + lock.
- I run `git log --since="48 hours ago" --name-only` on their owned paths before any PR that lands inside `apps/operator/`.
- When their Phase 4 audit produces the per-route A1/migratable/trivial table, I read it and skip A1 handler bodies + skip migratable routes entirely (they go away in Phase 4, not in my count).

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Vite-vs-Next behavior drift in obscure features (Next has lots of magic: ISR, edge runtime, font optimization, etc.) | The operator doesn't use ISR, edge runtime, or `next/font` heavily. Pre-flight audit each page for Next-specific features in Phase 4. |
| `nuqs` adapter compatibility with TanStack Router | Verify on the Design tab + harness filters before committing to TanStack. Fallback: `nuqs`'s generic `useQueryState` works with `URLSearchParams` directly. |
| `node-pty` prebuild loading without Next's `outputFileTracingIncludes` | esbuild externals + manual copy in the sidecar script. Tested in Phase 8. |
| fumadocs sub-sidecar adds operational complexity | If it turns out to be more pain than value, switch to (b) before cutover — adds ~2 weeks. |
| Host-architecture v2 Phase 4 starts migrating routes I haven't ported yet | Pure upside; those routes leave my count. Coordinate via `coord/frontend.jsonl`. |
| Cookie/CSRF behavior subtly differs between `cookies()` and `getCookie(c)` | Record/replay tests on the 6 routes before swap. |
| 804 `next/*` imports include things I haven't enumerated (next/dynamic, next/script, next/font) | Phase 2's grep enforces 0 `next/*` imports in the new dir; everything is hand-replaced as it shows up. |
| Tauri sidecar build regression breaks desktop release | Phase 8 ships before cutover; release-local.sh verified end-to-end before Phase 9. |
| 18-week timeline doubles in practice | Parallel directory means the user can shelve this at any phase without affecting the running operator. Worst-case = `apps/operator-host/` becomes dead code; no production impact. |

---

## What I need from the user before starting

1. **Approval of the parallel-directory approach.** In-place is the alternative; I think parallel is correct but the user has the call.
2. **Approval of TanStack Router** (vs React Router). I lean TanStack; happy to take direction.
3. **Approval of fumadocs path (a) — sub-sidecar — for first cutover, with (b) Vite-MDX as a possible follow-up.**
4. **Confirmation that mobile apps are out of scope.** I'm assuming yes.
5. **Confirmation that `apps/operator-host/` is an OK working name.** Can be anything; I'll use the user's preferred name.

After approval, Phase 0 is the first PR. Everything else is sequenced behind it.
