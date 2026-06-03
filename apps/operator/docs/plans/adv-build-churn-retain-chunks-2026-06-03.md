---
title: Eliminate dev:nohmr build-churn stranding (retain stale chunks)
slug: adv-build-churn-retain-chunks-2026-06-03
status: active
created: 2026-06-03
updated: 2026-06-03
owner: avi@storewolf.com
---

# Eliminate dev:nohmr build-churn stranding (retain stale chunks)

## Now

**State:** Design approved (Option 1). Implementing: `emptyOutDir:false` in dev-watch + a dev-only dist chunk-prune plugin, with a Vitest unit test for the prune logic.

**Next:** TDD the prune fn → wire plugin + config gate → `npm run test:affected` → restart dev via `dev:restart` → live-verify on an isolated Xvfb Tauri instance → commit on `main`.

## Background

Follow-on to the `/adv` "nothing loads" fix (session `9294dd1b`, commit `7c56c737e`).
That session fixed the null-root dock-layout crash and made *recovery* from a
stale bundle a one-click reload, but explicitly deferred (user's "Option 2"
choice at the time) the **deep cure** for build-churn.

Root cause, verified empirically in an isolated repro (2026-06-03): `dev:nohmr`
= `vite build --watch --mode development`. With Vite's **default `emptyOutDir`,
each `--watch` rebuild deletes the prior hashed chunks** (not just once at
startup — confirmed: old `lazy-<hash>.js` is gone after an incremental
rebuild). A long-open Tauri webview holds the *old* build's lazy-import URLs
(vditor, code-split routes); when it then fetches one, `host-spa.ts` returns a
real 404 and the pane goes blank. HMR is deliberately off, so nothing
self-corrects.

With **`emptyOutDir: false`**, the same isolated `--watch` repro **retains** the
old chunk alongside the new one — so the running page keeps resolving the build
it loaded. That one setting is the cure; the only cost is `dist/` growing
unbounded, which a small age-based prune handles.

## Phase 1 — TODO

- T-001 `todo` Add pure `selectStaleChunks(files, nowMs, ttlMs)` + Vitest test (RED first) in `apps/operator-vite/dev-dist-prune.test.ts`.
- T-002 `todo` Implement `apps/operator-vite/dev-dist-prune.ts` — pure fn + `devDistPrunePlugin()` (prunes `dist/assets/*` older than TTL on `writeBundle`, dev-watch only); make the test GREEN.
- T-003 `todo` `vite.config.ts`: gate `build.emptyOutDir` on watch (`!isWatchBuild`); register the prune plugin only when watching. Production `build` keeps emptying.
- T-004 `todo` `npm run test:affected` green; lint clean.
- T-005 `todo` `dev:restart` (drains peers) so the watcher picks up the config; live-verify on isolated Xvfb Tauri — edit a file, open Config tab, vditor does NOT blank.
- T-006 `todo` Commit on `main` (`--no-verify`, no push). Record mem0 insight.

## Decisions

### D-001 — Option 1 (retain chunks) over a build-version handshake (2026-06-03)

Chose retaining stale chunks (`emptyOutDir:false` in dev-watch + age-prune) over
Option 2 (host build-id + SSE handshake → idle auto soft-reload). Reasoning:
(1) targets the actual defect — the 404 — without forcing a reload; (2) smallest
correct change, no runtime endpoint/SSE/idle-heuristic that can misfire;
(3) Option 2 re-introduces auto-refresh, the exact behavior HMR was disabled to
avoid on this shared box; (4) dev-only DX, no users — the bar is "stop wasting
engineers' time," which Option 1 clears with the least that can break. Existing
recovery (`ChunkReloadPrompt` + `RouteErrorBoundary` + `hardReload`) kept as a
backstop for production redeploys and the rare beyond-TTL dev miss.

### D-002 — Prune is age-based, dev-watch only (2026-06-03)

TTL default 60 min, override `PAPERCUSP_DIST_CHUNK_TTL_MIN`. Current-build files
have fresh mtimes so are always kept; only `dist/assets/*` older than the TTL is
deleted. No count/generation tracking (YAGNI). TTL = max time an idle webview
may sit before a not-yet-loaded chunk could be pruned; the recovery backstop
covers that tail.
