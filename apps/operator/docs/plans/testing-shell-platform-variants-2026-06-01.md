---
title: Platform-variant test domains: browser-equivalent chaos + live
slug: testing-shell-platform-variants-2026-06-01
status: draft
created: 2026-06-01
updated: 2026-06-02
owner: aviynw3@gmail.com
parent: testing-shell-cross-project-2026-06-01
---

# Platform-variant test domains: browser-equivalent chaos + live

## Now

**State:** IMPLEMENTATION COMPLETE + VERIFIED on both projects (2026-06-02). Lib core (submodule `c1b4bc8`). **Restart 'web' side** (P-007 `/api/chaos-web` route + P-010 tabs, `platform='web'`): live chaos run drove `:3001`, both panels render (Restart `da4315ae`). **papercup 'both' side** (P-006 `/api/admin/testing/chaos-web` route + P-009 wiring; papercup `636198f0f`): 3 live chaos runs drove the built `:3070` SPA (real clicks + caught 401/403 console errors); the operator-vite bundle rebuilt with the tabs; the **Tauri-shell DOM eval** confirms `/admin/testing` renders Chaos (web) + Live (web) (`tabCount 24`, `hasChaosWeb`/`hasLiveWeb` true). Three findings vs the plan's assumptions: (1) **P-008 was a NO-OP** — both projects already ship Playwright + chromium; (2) the contended `testing-domains-registry.ts` was **NOT touched** — `/admin/testing`'s TABS are hardcoded in operator-vite's `TestingClient.tsx`, so platform tagging lives there, not the registry; (3) papercup chaos-web drives **`:3070`** (the built SPA the desktop loads), NOT `:3055` (the Vite HMR dev server throws `createHotContext` in a plain headless browser).

**Next:** only **P-012** (human sign-off on the cross-repo wiring) remains — the user's call.

## Background — approved design

**Problem.** chaos/live only run inside the Tauri shell. A webapp (Restart) — and papercup's own browser SPA (`:3055`) — have no equivalent. We want a browser variant of each, selected by platform, with both available when a project is both.

**Approved decisions (see Decisions):** explicit `platform` prop, not runtime detection (D-001); mirror the desktop split — `live`=in-page observer, `chaos`=Playwright subprocess (D-002); ship generic variants in `@papercusp/testing-shell` and wire BOTH papercup (`both`) and Restart (`web`) (D-003); mechanism = platform-tagged tabs + filter (D-004); add the Playwright dependency to Restart (D-005).

**Mechanism (platform-tagged tabs).** `TestingShellTab` gains optional `platform?: 'desktop' | 'web'` (omit = platform-agnostic, always shown). `TestingShell` gains `platform: 'desktop' | 'web' | 'both'` (default `'both'` — back-compat). A pure `visibleTabs(tabs, platform)` shows a tab when its `platform` is undefined, equals the active platform, or `platform === 'both'`. So `chaos`/`live` each become two sibling entries (e.g. `chaos` `platform:'desktop'` + `chaos-web` `platform:'web'`), each with its own `customTab` component + runner; "both shows both" falls out of the filter.

**`live` browser variant — in-page observer (client-only).** `@papercusp/testing-shell/web` `startWebObserver()` mirrors the desktop `vitals-recorder`: hooks `console.error/warn`, `window.onerror`, `unhandledrejection`, and a `PerformanceObserver` (CLS + long-tasks) into a buffered recorder with a teardown. The `live-web` panel renders the buffer. No backend, no deps — it observes the app session it runs in.

**`chaos` browser variant — Playwright subprocess (shared runner + per-host spawn).** `@papercusp/testing-shell/web/chaos-runner.mjs` mirrors the desktop chaos AND the existing `ai` Stagehand-runner: launch headless Chromium → `goto(baseUrl)` → for N steps random-click visible interactive elements → capture console errors / page crashes / dialogs → emit NDJSON progress. Args: `baseUrl`, `maxSteps` (argv/env). The **runner script is shared in the lib**; the **spawn endpoint is per-host** (a small SSE route in each app, ~the `ai-explore` / `load-tests` pattern). The `chaos-web` panel is a start/stream/stop run UI like Restart's `LoadTestPanel`.

## Phase 1 — Selection mechanism (lib)

- **P-001** `done` Add `Platform` type + `TestingShellTab.platform?` + `TestingShell` `platform` prop (default `'both'`) + pure `visibleTabs(tabs, platform)` filter in `@papercusp/testing-shell`. TDD `visibleTabs`. Existing consumers unaffected (default `'both'`). (platform prop + TestingShellTab.platform + pure visibleTabs default 'both', back-compat. TDD 4/4; package 18/18; lib self-typechecks added node types + fixed glob.ts Dirent<string>. submodule 2330802 / gitlink f20287f72.)

## Phase 2 — `live` browser variant (lib, client-only)

- **P-002** `done` `src/web/observer.ts`: `startWebObserver()` hooking console/error/unhandledrejection + `PerformanceObserver` (CLS, long-tasks) → buffered recorder + teardown. Unit-test the event-shaping (pure mapping fn). blocked-by: P-001 (startWebObserver console/window-error/unhandledrejection/CLS/longtask, stop+restore, import-safe. TDD 5/5 jsdom. submodule b80c538.)
- **P-003** `done` `LiveWebPanel` customTab component (renders the observer buffer + clear). Ships in the lib (generic). blocked-by: P-002 (LiveWebPanel customTab renders the observer buffer, snapshots on interval, clear. Exported from the client barrel. submodule b80c538.)

## Phase 3 — `chaos` browser variant (lib runner + per-host spawn)

- **P-004** `done` `src/web/chaos-runner.mjs`: Playwright headless random-clicker over `baseUrl`, N steps, capture console/crash/dialog, emit NDJSON. Smoke-test against a static fixture page (asserts clicks + events + clean exit). blocked-by: P-001 (chaos-runner.mjs: Playwright headless random-clicker over baseUrl, NDJSON events console/pageerror/crash/dialog/step/done. Pure helpers TDD'd 3/3; Playwright dynamically imported. ./web/chaos-runner export. submodule 511c384.)
- **P-005** `done` `ChaosWebPanel` customTab: start/stream/stop run UI (mirror Restart's `LoadTestPanel`); POSTs to the host's chaos-web SSE endpoint. blocked-by: P-004 (ChaosWebPanel customTab: start/stream/stop, POSTs {baseUrl,maxSteps} to a host runEndpoint, parses the NDJSON stream. Exported from the client barrel. submodule 511c384.)
- **P-006** `done` papercup: operator SSE route that spawns `chaos-runner.mjs` (pattern of `ai-explore` / `load-tests`). blocked-by: P-004 (apps/operator/lib/endpoint-route/routes/admin/testing-chaos-web.ts: POST /api/admin/testing/chaos-web, raw-NDJSON stream — NOT sseResponse (the shared panel reads raw NDJSON) — spawns chaos-runner via a repo-relative resolve, localhost-only baseUrl guard, default :3070. Registered in routes/index.ts; :3070 restarted. Verified: 3 live runs drove the built :3070 SPA — real clicks + 401/403 console errors caught. papercup 636198f0f.)
- **P-007** `done` Restart: `_hono` SSE route that spawns `chaos-runner.mjs`. blocked-by: P-004 (app/api/_hono/chaos-web.ts: POST /run spawns chaos-runner via project.repoRoot, relays NDJSON verbatim; localhost-only baseUrl guard; /stop kills. Registered at /api/chaos-web. Verified: 3-step run vs :3001 → start/step/done. Restart da4315ae.)
- **P-008** `done` (NO-OP) Add Playwright to Restart — **already satisfied**: `playwright` resolves from Restart root + chromium binaries present in `~/.cache/ms-playwright` (the shop tests use them). The plan's "Restart has NO Playwright" was stale. No install needed.

## Phase 4 — Wiring

- **P-009** `done` papercup (`platform='both'`): tag desktop `chaos`/`live` `platform:'desktop'`; register `chaos-web`/`live-web` `platform:'web'`; set the harness + `/admin/testing` `TestingShell` `platform='both'`. blocked-by: P-003, P-005, P-006 (operator-vite TestingClient.tsx: desktop chaos/live tagged 'desktop', chaos-web/live-web added 'web', platform='both'; baseUrl → :3070 (built SPA), not :3055. testing-custom-tabs.tsx: ChaosWebPanel+LiveWebPanel customTabs. HarnessTestsView platform='both' (consistency — chaos/live are admin-level, not per-harness, so the harness tab shows no web variant; correct). Did NOT touch the contended testing-domains-registry.ts. Tauri-shell DOM eval: hasChaosWeb/hasLiveWeb true. papercup 636198f0f.)
- **P-010** `done` Restart (`platform='web'`): add `chaos-web` + `live-web` tabs to `TestsClient` (baseUrl → `:3001`); pass `platform='web'`. blocked-by: P-003, P-005, P-007 (TestsClient: platform='web' + Live (web)/Chaos (web) tabs tier 'project' platform:'web', LiveWebPanel + RestartChaosWebPanel(hostBase). Verified: rail shows 6 tabs Universal[2]/Restart[4], both panels render, no pageerrors. Restart da4315ae.)

## Phase 5 — Verify

- **P-011** `done` Lib units (`visibleTabs`, observer mapping) + `chaos-runner` smoke; papercup + Restart `next build`/operator-config; live-render eyeball of both dashboards. blocked-by: P-009, P-010 (lib 30 tests green; chaos-runner exercised by both routes' live runs; Restart `next build` ×2 + operator-vite bundle rebuild clean; Restart /tests eyeballed via Playwright (6 tabs + StatusStrip), papercup /admin/testing eyeballed via the Tauri-shell bridge DOM eval (Chaos (web)+Live (web) present).)
- **P-012** `needs-human` Sign-off before the cross-repo wiring is considered shipped (touches papercup + Restart). importance: high blocked-by: P-011

## Decisions

### D-001 — Explicit `platform` prop, not runtime detection
Date: 2026-06-01
The host passes `platform: 'desktop' | 'web' | 'both'`; the framework never sniffs `window.__TAURI_INTERNALS__`. More predictable/testable; papercup passes `'both'`, Restart `'web'`. (User choice over auto-detect.)

### D-002 — Mirror the desktop split (don't unify the interface)
Date: 2026-06-01
Per `testing-shell-cross-project` D-008, we do NOT collapse chaos/live into one cross-platform driver. Instead: `live` browser variant = in-page observer (mirrors `vitals-recorder` hooking the webview); `chaos` browser variant = Playwright subprocess (mirrors the desktop chaos driving the shell externally). Each browser variant matches how its desktop counterpart works.

### D-003 — Generic variants in the shared lib; wire both projects
Date: 2026-06-01
The browser observer + Playwright chaos runner are generic (a base URL + a page hook), so they ship in `@papercusp/testing-shell`. Wire papercup (`both` → desktop + browser variants against its `:3055` SPA) AND Restart (`web` → browser variants in `/tests`).

### D-004 — Mechanism: platform-tagged tabs + filter (approach A)
Date: 2026-06-01
A tab/domain carries optional `platform?`; `TestingShell` filters by the `platform` prop. Chosen over a merged per-tab `{desktop,web}` variant with a toggle — it's the smallest change to the shell, and desktop/web are genuinely different tests, so sibling tagged entries are clearer than a hidden toggle. "Both shows both" is just the filter.

### D-005 — Add Playwright to Restart
Date: 2026-06-01
`chaos-web` needs a real headless-browser driver; Restart has no Playwright today (0 e2e). Add it (the `chaos-runner` dep). `npm install` is broken in Restart, so add via the `npm pack`+extract workaround. (User: "add the dependency.")

## Verification
- `visibleTabs` + observer-mapping: Vitest units in the lib (TDD).
- `chaos-runner.mjs`: smoke run vs a static fixture page.
- Per-host: papercup operator-config test + Restart `next build`; live-render eyeball of both `/tests` (and papercup's harness/admin testing) showing the platform-correct tabs.
- Regression: existing consumers (no `platform` prop → default `'both'`) render exactly as before.
