---
title: `/tests` page — plan
slug: tests-page-2026-05-14
status: active
created: 2026-05-14
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-14 **Status:** Awaiting review **Scope:** New top-level "Tests" surface for autonomous UI perf testing of the operator app (running in the Tauri webview).

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# `/tests` page — plan

**Date:** 2026-05-14
**Status:** Awaiting review
**Scope:** New top-level "Tests" surface for autonomous UI perf testing of the operator app (running in the Tauri webview).

---

## What's already set up (you can ignore this section — already done)

| Component | State | Where |
|---|---|---|
| **Gremlins.js 2.2.0** | installed | `apps/operator/package.json` deps |
| **react-scan 0.5.6** | installed | `apps/operator/package.json` deps |
| **@browserbasehq/stagehand 3.4.0** | installed | `apps/operator/package.json` deps |
| **`web-vitals`** | already present from prior work | — |
| **tauri-driver** | installed via cargo | `~/.cargo/bin/tauri-driver` |
| **WebdriverIO runner scaffold** | written | `tools/perf-test/wdio/` |
| **wdio config + smoke spec** | written, untested (needs packaged binary) | `tools/perf-test/wdio/wdio.conf.ts` + `specs/smoke.spec.ts` |

**Pending host-system install** (one-time, requires sudo):
```bash
sudo apt install webkit2gtk-driver
```
Needed only when you actually want to run the packaged-binary tests. The in-process `/tests` page doesn't require it.

---

## The /tests page itself

### Route

`app/tests/page.tsx` — top-level, **not** nested under `/admin`. Added to the primary sidebar nav (placement: bottom group, alongside `/dev` and `/settings`).

### Tabs (nuqs-backed via `?tab=`)

| Tab | Purpose | Stack |
|---|---|---|
| **Chaos** | "Find perf issues" — autonomous monkey clicker + metrics | Gremlins.js + web-vitals + react-scan |
| **AI Explore** | Goal-directed autonomous exploration | Stagehand + Anthropic API key |
| **Live metrics** | Passive perf observer (you use the app normally, slow interactions surface in a table) | web-vitals + PerformanceObserver |
| **Routes** | Aggregate per-route INP / error / a11y history across all runs | localStorage roll-up |
| **Packaged build** | Runs WebdriverIO smoke against the shipped Tauri binary | shells out to `npm test` in `tools/perf-test/wdio` |

### Architecture decision: in-place vs iframe

**Decision: in-place, not iframe.**

Rationale: in earlier turns I proposed an iframe so the controller UI stays alive while the app navigates underneath. After thinking more about it — Gremlins.js is designed to run in-page (it's literally a script you eval). It's safer than the autonomous-clicker concern made it sound: built-in form-filler skips destructive selectors via allowlist API, and it stops on `mogwais` (heuristic bots that detect bugs like console errors / fps drops / element count explosions).

Iframe adds same-origin gymnastics, intercepted-navigation handling, and a 2nd React tree's worth of memory for no real safety win. Drop it.

Instead: the `/tests` page **opens its own browser tab** (window.open) that loads the app + a query-param flag `?perf-recorder=1`. The recorder tab gets:

- Gremlins injected via `<script type="module">` in the layout when the flag is present
- web-vitals INP/LCP/CLS observers
- react-scan overlay
- A small floating control bar (stop, dump-results)

Results are posted back to the original `/tests` tab via `BroadcastChannel`. Closing the recorder tab ends the run.

This is the standard pattern for "exercise the live app while keeping a control surface alive."

### Chaos tab — UX

```
┌─ Chaos run ────────────────────────────────────────────────┐
│  Target route: [ / ▾]      Duration: ( 30s ◉  2m  10m )   │
│  Mode: ( Dry-run  ◉ Full chaos )                           │
│  Blocklist: [ delete|reset|sign out|destroy ] ⟳            │
│  [ Launch recorder window ]                                │
│                                                             │
│  ─── Last run · 2m12s · /  ───────────────────────────────  │
│  Top slow interactions (sorted by INP desc):                │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ INP    LongTask  Route   Target                     │   │
│  │ 312ms   180ms    /h/abc  button "Add tab"           │   │
│  │ 247ms   140ms    /h/abc  [role=tab] "Issues"        │   │
│  │ 198ms    85ms    /      a[href=/settings]           │   │
│  │ ...                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│  Errors caught (4):    Console: 2  Network: 1  A11y: 1     │
│  [ Export JSON ]  [ View react-scan report ]               │
└─────────────────────────────────────────────────────────────┘
```

### AI Explore tab — UX

Same shape but with a "Goal" textbox instead of duration:

> *"Open a harness, switch to the Issues tab, click into the first issue, return to dashboard."*

Stagehand drives Playwright (via Stagehand's local mode, no Browserbase needed) against `http://localhost:3055`. Each `page.act(...)` call gets wrapped with web-vitals measurement. The same results table is reused.

**Cost gate:** the tab shows a cost-per-run estimate (current Anthropic Sonnet 4.6 pricing × expected tokens), and requires `ANTHROPIC_API_KEY` env var. If missing → tab is disabled with an inline link to settings.

### Live metrics tab — UX

Always-on PerformanceObserver registered globally (not just on this tab) via a top-level provider. Records:
- Every `event` PerformanceEntry with `duration > 50ms` → bucketed by target element selector
- Every `longtask` entry > 50ms
- Every `layout-shift` entry with value > 0.01

Table renders the last N events (sortable, filterable by route). Persists to localStorage (last 1000 events).

The "this is the killer feature" tab — you don't have to run anything, just use the app, slow spots surface here.

### Routes tab — UX

Reads from localStorage roll-up. For each Next.js route ever visited, shows:
- Median INP across all interactions on that route
- 95th percentile INP
- Total console errors caught
- Total a11y violations caught (axe-core delta from initial load)
- Last visited timestamp

Sortable by p95. Click → drills into per-event detail.

### Packaged build tab — UX

Read-only summary:
- Status of the last `npm test` run in `tools/perf-test/wdio` (read from a results JSON file the runner writes)
- "Run now" button → kicks off a child-process via existing `/api/dev/exec` style endpoint (TBD which one — leverage existing infrastructure, don't add new shell-exec surface)
- Links to the README for setup

This tab is intentionally minimal — the heavy lifting happens outside the browser.

---

## File layout

```
apps/operator/
  app/
    tests/
      page.tsx                     # tab shell, nuqs ?tab=
      _components/
        ChaosTab.tsx
        AIExploreTab.tsx
        LiveMetricsTab.tsx
        RoutesTab.tsx
        PackagedBuildTab.tsx
        RecorderLauncher.tsx       # opens window + manages BroadcastChannel
        ResultsTable.tsx           # shared sortable table
      _lib/
        gremlins-driver.ts         # configures gremlins (allowlist, mogwais)
        stagehand-driver.ts        # configures Stagehand
        vitals-recorder.ts         # web-vitals + PerformanceObserver wrapper
        results-store.ts           # localStorage persistence
  app/
    layout.tsx                     # add `<PerfObserverProvider>` (Live metrics)
    _perf-recorder/
      page.tsx                     # opened in a separate tab when ?perf-recorder=1
                                   # NO — actually injected via layout, not its own page
```

(Correction in-place: the recorder doesn't need its own route. The main app layout reads `searchParams.perf-recorder` and conditionally mounts the Gremlins script + control bar. That way recorder window URLs are stable across navigation: `/?perf-recorder=1`, `/settings?perf-recorder=1`, etc.)

## Build order

1. **Vitals recorder + LiveMetricsTab** (no chaos engine yet) — gets you immediate value: every slow interaction shows up.
2. **Gremlins driver + ChaosTab + recorder window** — autonomous clicker.
3. **react-scan overlay integration** — bind into the recorder window.
4. **RoutesTab** — aggregate roll-up.
5. **Stagehand driver + AIExploreTab** — LLM exploration.
6. **PackagedBuildTab** — wire the wdio runner.

Each step ships independently and is useful on its own. If we pause after step 2, you already have the killer feature.

---

## Open questions for review

1. **Sidebar placement** — bottom group near `/dev`, or top-level next to harness list? I'd lean bottom group (dev/admin character, not user-facing).
2. **AI Explore cost limit** — soft cap per run ($1 default?) with abort if exceeded. Configurable in `/settings/api-keys` alongside the existing Anthropic key. OK to add a setting, or leave the cap hard-coded?
3. **react-scan in production** — currently a dev-mode-only tool. Should we ship its overlay only when `?perf-recorder=1` is present (i.e., gated behind the recorder), or also expose a "toggle scan overlay" button on `/tests` for general inspection?
4. **localStorage size budget** — Live metrics + Routes roll-ups will accumulate. Cap at 1000 events / 30 days, oldest evicted. OK?
5. **Authorization** — `/tests` is a powerful surface (can crawl arbitrary routes, can call Anthropic API). Gate behind same loopback-host check as `/desktop/*`, or open to anyone with a session? Recommend loopback-only for the AI Explore + Packaged Build tabs; the rest can be session-only.
6. **Packaged build tab in v1** — include it or defer? It requires `sudo apt install webkit2gtk-driver` + a packaged binary, which is a meaningful setup chore. Defer to a follow-up?

---

## Out of scope (deferred to followups)

- Scripted Playwright suite from prior plan
- Visual regression (Playwright `toHaveScreenshot()` or Lost Pixel) — separate workstream
- CI integration — `/tests` is interactive; CI runs come later via the wdio runner
- Persistence to PG — localStorage is enough for v1; promote to PG when we want cross-machine history
