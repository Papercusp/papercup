---
title: Fully universalize the AI-Explore / Chaos / Live / k6 test domains in @papercusp/testing-shell
slug: universal-testing-domains-generic-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
supersedes: []
---

# Fully universalize the AI-Explore / Chaos / Live / k6 test domains in @papercusp/testing-shell

> **For agentic workers:** implement task-by-task. Each `P-NNN` item is bite-sized; the phase prose above each item block carries the exact files, interfaces, and code. TDD: write the failing test first, watch it fail, implement, watch it pass, commit (`git commit --no-verify`) every item. The lib is a **git submodule** — see Phase 6 for the landing protocol; do **not** `git push` without asking (memory: submodule pins are local-only).

## Now

**State:** Phases 0–3 DONE + committed + both checkouts synced at 9e8d5da; lib suite 91/91 green. Phase 1 k6 (server/k6 cores + k6-routes Hono router + LoadTestPanel). Phase 2 chaos-web core (server/chaos.ts spawnChaosWebStream). Phase 3 AI Explore (server/stagehand-runner.mjs moved+startUrl-required, server/ai-explore.ts cores + spawnAiExploreSSE, web/AiExplorePanel generic). Live-web/chaos-web panels already existed. Backend cores follow D-002 (framework-agnostic core + thin per-app wrapper; Hono routers behind their own subpath exports so ./server stays hono-free). Remaining: Phase 4 (chaos-desktop in-app recorder → desktop/), Phase 5 (un-narrow universal.ts + buildUniversalTesting helper), Phase 6 (rewire Restart + operator onto the lib, delete bespoke, land submodule, live-verify), Phase 7 (LLM framework → lib + Restart ScoutTarget). Note: a peer is active in apps/operator/lib/llm-testing/** — re-coordinate before Phase 7.

**Next:** Phase 4: port the operator's in-app perf-recorder chaos (recorder-channel + RecorderHost + ChaosTab) into libs/testing-shell/src/desktop/, parameterized by {recorderUrl, route, blocklist, durations}.

## Background

### What exists today (ground truth, 2026-06-03)

The shared lib `@papercusp/testing-shell` is a submodule consumed by both repos:
- **Restart** checkout: `/home/marsh-office/Restart/libs/testing-shell` (currently **detached at `513621c2`**).
- **Papercusp operator** checkout: `/home/marsh-office/papercupai-workspace/papercup/libs/testing-shell` (currently on **`main` at `5f14a245`**). **These two have diverged — Phase 0 reconciles them.**

Already generic in the lib (`libs/testing-shell/src/`):
- `platform.ts` — `Platform = 'desktop'|'web'|'both'`, `TabPlatform`, `visibleTabs(tabs, platform)`. The desktop/web split mechanism. (platform-variants D-001/D-004.)
- `web/observer.ts` — `startWebObserver()` passive console/error/CLS/longtask recorder. **Import-safe server-side; runs in ANY browser context including the Tauri webview.**
- `web/LiveWebPanel.tsx` — observer UI, zero backend.
- `web/ChaosWebPanel.tsx` — start/stream/stop UI; props `{ runEndpoint, baseUrl, defaultMaxSteps }`.
- `web/chaos-runner.mjs` — headless-Chromium random clicker; `node chaos-runner.mjs <baseUrl> <maxSteps>`; emits NDJSON; Playwright imported dynamically (pure helpers `formatEvent`/`clampSteps`/`pickIndex` are test-safe).
- `registry.ts` — `TestDomain`/`TestSection`/`TestRunner` (incl. `k6` kind)/`TestTier`, `defineTestDomain`, `applyRoleGlobs`, `listTestDomains`.
- `registry/universal.ts` — **narrowed to only `routes`** (D-007).
- `TestingShell.tsx` (`tabs`, `tierLabels`, `dataSource`, `customTabs`, `platform`), `DomainTestPanel.tsx`, `AdoptionMatrix.tsx`, `JUnitRollupPanel.tsx`, `data-source.ts`, `junit.ts`, `run-status.ts`, `glob.ts`.

Still bespoke / NOT universal (the gaps this plan closes):
- **k6 / Load** — entire feature is Restart-only: panel `apps/web/app/load-tests/LoadTestPanel.tsx`, Hono backend `apps/web/app/api/_hono/load-tests.ts` (spawns `k6 run`, SSE), scripts `load-tests/scripts/*.js`. Only the `TestRunner` *type* lives in the lib. Papercup has a Hono host but no k6.
- **Chaos-web backend** — two near-identical thin spawn routes exist: Restart `apps/web/app/api/_hono/chaos-web.ts` (Hono) and operator `apps/operator/lib/endpoint-route/routes/admin/testing-chaos-web.ts` (`defineTool` + `sseResponse`). Both spawn the shared `chaos-runner.mjs`. The spawn/stream substance should live in the lib.
- **AI Explore** — operator-only and already mostly config-driven: runner `apps/operator/scripts/stagehand-runner.mjs` (uses `@browserbasehq/stagehand`; stdin JSON `{goal,startUrl,model,apiKey,maxSteps,maxCostUsd,headless}`), route `apps/operator/lib/endpoint-route/routes/admin/testing-ai-explore.ts`, panel `apps/operator/app/admin/testing/_components/AIExploreTab.tsx`. Hardcoded: default `startUrl='http://127.0.0.1:3055/'`, model pricing table.
- **Chaos-desktop** — an **in-app perf-recorder**, not an external driver: `apps/operator/app/admin/testing/_components/ChaosTab.tsx` (controller) opens a second WebviewWindow (Tauri) / `window.open` (web) at the app's recorder URL; `RecorderHost.tsx` runs `PerformanceObserver`s (INP/longtask/CLS) + console/error capture + autonomous clicking inside that window and talks back over Tauri-event (desktop) / BroadcastChannel (web), protocol in `_lib/recorder-channel.ts`. No backend route. Hardcoded: default route `'/'`, duration presets, blocklist, recorder window 1280×800.

The two consumers use **different server frameworks**: Restart = plain Hono (`new Hono()`); operator = the endpoint-system `defineTool` + `@papercusp/sse` `sseResponse`. This shapes D-002 below.

### Why now

User directive (2026-06-03): "AI Explore and Chaos and Live and k6 should all be universal in our generic shared lib and not tied to Restart other than via configs. If Papercusp can't use them because it's desktop not web, the lib should be generic and Papercusp passes a desktop/web parameter, or use separate universal web/desktop components, and each app uses one." Approved design: separate web+desktop component variants filtered by the existing `platform` prop; generic desktop driver configured by the app; generic AI Explore with Stagehand/Playwright as optional peer deps; k6 panel + shared backend core.

## Design / Architecture

### Target lib layout

```
libs/testing-shell/src/
  web/                          universal WEB variants (drive an HTTP baseUrl)
    observer.ts, LiveWebPanel.tsx         (exist; Live is platform-AGNOSTIC — see D-004)
    ChaosWebPanel.tsx, chaos-runner.mjs   (exist)
    LoadTestPanel.tsx           NEW  generic k6 UI (ported from Restart, endpoints via props)
    AiExplorePanel.tsx          NEW  generic Stagehand UI (ported from operator AIExploreTab)
  desktop/                      universal DESKTOP variants (drive the native shell)   NEW DIR
    recorder-channel.ts         NEW  protocol types + transport (Tauri-event | BroadcastChannel)
    RecorderHost.tsx            NEW  in-window perf recorder + autonomous clicker (from operator)
    ChaosDesktopPanel.tsx       NEW  controller (opens recorder window, renders progress)
  server/                       Node-only, framework-agnostic cores (NO React/CSS import)   NEW DIR
    index.ts                    NEW  barrel for ./server export
    k6.ts                       NEW  listK6Scripts/runK6Stream/listK6Results/getK6Result + createK6HonoRoutes
    chaos.ts                    NEW  spawnChaosWebStream({baseUrl,maxSteps,repoRoot}) -> ReadableStream
    ai-explore.ts               NEW  spawnAiExploreStream(config) + DEFAULT_MODELS/pricing; resolves stagehand-runner.mjs
    stagehand-runner.mjs        NEW  moved from operator scripts/, default baseUrl parameterized
  registry/
    universal.ts                MODIFY  un-narrow: add load/chaos-web/ai/live/chaos-desktop descriptors (pure data)
    universal-tabs.tsx          NEW  buildUniversalTesting(cfg) -> { tabs, customTabs }   the consumer ergonomic
```

`package.json` `exports`: add **`./server`** (→ `./src/server/index.ts`, Node-safe — no React so Hono/tsx hosts import the cores without exploding), and `./server/stagehand-runner` (→ the .mjs, like the existing `./web/chaos-runner`). Add `@browserbasehq/stagehand` + `playwright` to **`peerDependencies`** with `peerDependenciesMeta` `optional:true` (AI Explore + chaos-web degrade with a clear error when absent).

### The consumer ergonomic (config, not code) — used by Phase 5

One config type drives everything. Presence of a key ⇒ that domain's tab is emitted (so a project with no k6 scripts simply omits `load` and gets no Load tab — D-005):

```ts
// libs/testing-shell/src/registry/universal-tabs.tsx
export interface UniversalTestingConfig {
  routes?: { globs: string[] };                                   // endpoint-test domain (role:'endpoints')
  load?: { scriptsEndpoint: string; runEndpoint: string; stopEndpoint: string; resultsEndpoint: string; project?: string };
  liveObserver?: boolean;                                         // in-page observer; agnostic; no backend
  chaosWeb?: { runEndpoint: string; stopEndpoint?: string; baseUrl: string; defaultMaxSteps?: number };
  aiExplore?: { runEndpoint: string; defaultStartUrl: string; defaultGoal?: string; models?: string[] };
  chaosDesktop?: { recorderUrl: string; defaultRoute?: string; blocklist?: string[] };
}
export function buildUniversalTesting(cfg: UniversalTestingConfig): {
  tabs: TestingShellTab[];                                        // platform-tagged nav entries
  customTabs: Record<string, () => ReactElement>;                 // id -> pre-wired panel (routes has NO customTab: falls through to DomainTestPanel)
};
```

Tab ids, tiers, and platform tags emitted:

| domain key   | tab id          | tier        | platform   | renders via |
|--------------|-----------------|-------------|------------|-------------|
| routes       | `routes`        | `universal` | (agnostic) | DomainTestPanel (dataSource) — no customTab |
| load         | `load`          | `universal` | (agnostic) | `LoadTestPanel` customTab |
| liveObserver | `live-web`      | `universal` | (agnostic) | `LiveWebPanel` customTab |
| chaosWeb     | `chaos-web`     | `universal` | `web`      | `ChaosWebPanel` customTab |
| aiExplore    | `ai-explore`    | `universal` | `web`      | `AiExplorePanel` customTab |
| chaosDesktop | `chaos-desktop` | `universal` | `desktop`  | `ChaosDesktopPanel` customTab |

Consumer call site (both apps converge on this):

```ts
const { tabs: uTabs, customTabs: uCustom } = buildUniversalTesting(cfg);
<TestingShell
  tabs={[...uTabs, ...projectTabs]}
  customTabs={{ ...uCustom, ...projectCustom }}
  tierLabels={{ universal: 'Universal', project: '<App>' }}
  dataSource={dataSource}
  platform="web" /* operator: "both" */ />
```

`visibleTabs()` then hides `chaos-desktop` for Restart and shows everything for the operator. **Each app uses exactly one variant per platform** — the user's requirement — for free via the existing filter.

### Backend: framework-agnostic core + thin per-app wrapper (D-002)

The lib owns the *substance* (spawn the subprocess, parse/stream NDJSON|SSE, resolve script dirs). Each app keeps a ~5–10 line route that adds its own auth + framework and calls the core:
- Restart Hono route → `return new Response(coreStream, { headers })`.
- Operator `defineTool` → feeds the core into `sseResponse`/returns the `Response`.

The lib additionally ships `createK6HonoRoutes(cfg)` (a `Hono` sub-app) as a convenience for Hono consumers (Restart). The operator wraps the same `server/k6.ts` cores in its `defineTool` routes.

## Phase 0 — Scaffolding + reconcile the diverged submodule

All lib edits happen in **one** checkout to avoid double-divergence. Use the **papercup checkout** (`/home/marsh-office/papercupai-workspace/papercup/libs/testing-shell`, on `main`) as the working copy; reconcile Restart's detached checkout to the same `main` first, so both repos build against identical lib source.

- **P-001** `done` Reconcile the two testing-shell checkouts. In papercup's `libs/testing-shell`: `git fetch && git log --oneline main..513621c2` and `513621c2..main` to learn which side is ahead. If Restart's `513621c2` carries commits not on `main`, cherry-pick/merge them into `main` first (inspect with `git show 513621c2`). Then in `/home/marsh-office/Restart`: `git -C libs/testing-shell fetch origin && git -C libs/testing-shell checkout main && git -C libs/testing-shell pull`. Verify `git -C libs/testing-shell rev-parse HEAD` matches papercup's. **Do not lose Restart's detached work** — if unsure, stop and surface the diff. importance: high (reconciled: both checkouts at b78dfb1; recovered stranded token migration onto main; no work lost. baseline lib tests 57/57 green.)
- **P-002** `done` Add the `./server` + `./server/stagehand-runner` entries to `libs/testing-shell/package.json` `exports` (mirror the existing `./web/chaos-runner` shape: `{ "./server": { "types": "./src/server/index.ts", "import": "./src/server/index.ts", "default": "./src/server/index.ts" } }`). Add `@browserbasehq/stagehand` and `playwright` to `peerDependencies` and a `peerDependenciesMeta` block marking both `optional: true`. Create `src/server/index.ts` as an empty barrel (`export {};`) so the export resolves. Commit. (./server export + hono/playwright/stagehand optional peers added; src/server/index.ts barrel created.)
- **P-003** `done` Create the empty `src/server/` and `src/desktop/` dirs with a `.gitkeep` or the index barrels, and confirm `npm -w @papercusp/testing-shell run test` still passes (no regressions). Commit. (server/ dir created barrel; lib tests 57/57 green; both checkouts synced to 1c859ba. desktop/ deferred to Phase 4 empty dir serves nothing earlier.)

## Phase 1 — k6 / Load universal

**Goal:** the k6 panel + its backend logic live in the lib; Restart consumes them via config; the feature is identical to today's Restart UX. Scripts stay per-project.

**Files:**
- Create `libs/testing-shell/src/server/k6.ts` — the framework-agnostic core + a Hono convenience router.
- Create `libs/testing-shell/src/server/k6.test.ts` — unit tests (mock `node:child_process` + `node:fs`).
- Create `libs/testing-shell/src/web/LoadTestPanel.tsx` — ported from `Restart/apps/web/app/load-tests/LoadTestPanel.tsx`, endpoints via props.
- Modify `libs/testing-shell/src/index.ts` — export `LoadTestPanel`.
- Modify `libs/testing-shell/package.json` — already has `./server` (P-002); k6.ts re-exported from `src/server/index.ts`.
- Rewire (Phase 5/6) `Restart/apps/web/app/api/_hono/load-tests.ts` → `createK6HonoRoutes(...)`; delete `Restart/apps/web/app/load-tests/LoadTestPanel.tsx`.

**`server/k6.ts` interface (extract the pure pieces from Restart's `load-tests.ts`):**

     
                            
                                                                                                                                                 
                                                                                                                                                                
                                                                                                                                                
                                                                  
                                                                  
                                                                                 
                                                                                                                
                                                                                                                                                                                                                
                                                                                                 
                                                                                                     
                                                                                                                                                                              
   

- **P-010** `done` Write `server/k6.test.ts` failing tests: `parseScriptMeta` extracts `@name/@category/@defaultVUs` from a sample header string and defaults id/category when absent; `listK6Scripts` over a mocked `readdirSync`+`readFileSync` returns parsed metas and `[]` when dir missing. Run `npm -w @papercusp/testing-shell test -- k6` → FAIL (module missing).
- **P-011** `done` Implement `parseScriptMeta`/`listK6Scripts`/`listK6Results`/`getK6Result` in `server/k6.ts` (lift the regex + fs logic verbatim from `Restart/apps/web/app/api/_hono/load-tests.ts` lines 33–60, 65–72, 188–215; take `content`/dirs as args instead of reading `c.req.query`). Run tests → PASS. Commit.
- **P-012** `done` Add a `runK6Stream` test: mock `spawn` to emit two stdout lines + `close(0)`; assert the stream yields `data: {"type":"log"...}` lines then `data: {"type":"done","code":0,...}` and that a `<resultId>.meta.json` is written (mock `writeFileSync`, assert called with the log array). Implement `runK6Stream` (lift `load-tests.ts` lines 95–176, SSE encoder + single-child model + sidecar write; the module-level `runningChild` becomes closure state returned alongside, or keep a module singleton — keep the singleton to preserve "one run at a time"). Run → PASS. Commit.
- **P-013** `done` Add `createK6HonoRoutes` test: build the router with a stub `resolvePaths`+fake dirs (mock fs), `app.request('/scripts')` → 200 JSON `{scripts}`; `app.request('/run',{method:'POST',body})` with unknown scriptId → 404; valid → streamed Response. Implement `createK6HonoRoutes` (the 5 routes delegating to the cores; `ALLOWED` scriptId regex `^[a-z0-9-]+$` preserved). Run → PASS. Commit.
- **P-014** `done` Port `LoadTestPanel.tsx` into `libs/testing-shell/src/web/`. Change: replace `useProject()` + hardcoded `/api/load-tests/*` with **props** `{ scriptsEndpoint, runEndpoint, stopEndpoint, resultsEndpoint, project? }`; the `?project=` query becomes `props.project ? \`?project=${props.project}\` : ''`. Replace `import { readSSEStream } from '@/lib/sse'` with a small inlined SSE line-reader (the lib can't import Restart's `@/lib/sse`) — or add `parseSSE` to `run-status.ts`/a tiny `web/sse.ts` and unit-test it. Keep the inline `<style>` and `var(--*)` tokens (lib panels already use them). Export from `index.ts`. Add a render test (RTL): given a mock `fetch` returning 2 scripts, the script list renders 2 buttons. Run → PASS. Commit. (ported; reused ../sse readSSEStream; endpoints via props; kept token-based category colors lib k6.ts colors are hex — reconciling them is a separate cleanup.)
- **P-015** `done` Add `LoadTestPanel` + the k6 cores to `src/server/index.ts` barrel and `src/index.ts`. Run `npm -w @papercusp/testing-shell test` (full) → PASS. Commit. (Restart rewiring happens in Phase 6.) (./server barrel exports k6 cores; ./server/k6-routes subpath added; index.ts exports LoadTestPanel. 72/72 green.)

## Phase 2 — Chaos-web backend core

**Goal:** the spawn/stream substance behind both apps' chaos-web routes moves to the lib; the two routes shrink to thin wrappers. `ChaosWebPanel` already exists.

**Files:**
- Create `libs/testing-shell/src/server/chaos.ts` + `chaos.test.ts`.
- Rewire (Phase 6) Restart `apps/web/app/api/_hono/chaos-web.ts` and operator `apps/operator/lib/endpoint-route/routes/admin/testing-chaos-web.ts` to call the core.

**`server/chaos.ts` interface:**

     
                                                               
                                                                                          
                                                                                                  
                                                                                    
                                                                    
                                                                                                                    
                                                                                                                               
   

- **P-020** `done` Write `chaos.test.ts`: `clampMaxSteps` (NaN→25, 0→1, 999→200, '50'→50); `ALLOWED_BASE` accepts `http://localhost:4321/` + `http://127.0.0.1:3070` and rejects `https://evil.com`; `resolveChaosRunner` returns the path when `existsSync` (mocked) true, null otherwise. Run → FAIL.
- **P-021** `done` Implement those three pure/near-pure fns in `server/chaos.ts`. Run → PASS. Commit.
- **P-022** `done` Add a `spawnChaosWebStream` test: mock `spawn` to emit one NDJSON line on stdout + `close()`; assert the stream forwards the line verbatim; emit a stderr chunk and assert it surfaces as `{"type":"error",...}\n`. Implement `spawnChaosWebStream` (lift Restart `chaos-web.ts` lines 44–78 — the ReadableStream + single `runningChild`). Export from `server/index.ts`. Run → PASS. Commit. (server/chaos.ts core + 5 tests; exported from ./server. Route rewiring is Phase 6. Full suite 77/77.)

## Phase 3 — AI Explore universal

**Goal:** the Stagehand runner + panel move to the lib, parameterized by base URL / model / pricing; the operator route shrinks to a thin wrapper; Restart gains an AI Explore tab. Stagehand + Playwright are optional peer deps.

**Files:**
- Create `libs/testing-shell/src/server/stagehand-runner.mjs` — moved from `apps/operator/scripts/stagehand-runner.mjs`. Change: the default `startUrl` fallback (operator line ~71 `'http://127.0.0.1:3055/'`) is removed — `startUrl` becomes **required** from stdin config (the caller supplies the default). Keep the model pricing table but export it (see core).
- Create `libs/testing-shell/src/server/ai-explore.ts` + `ai-explore.test.ts` — the core + `DEFAULT_MODELS`/pricing.
- Create `libs/testing-shell/src/web/AiExplorePanel.tsx` + a render test — ported from operator `AIExploreTab.tsx`, endpoints/defaults via props.
- Modify `src/server/index.ts` + `src/index.ts` barrels.
- Rewire (Phase 6) operator `testing-ai-explore.ts` → call the lib core; add a Restart Hono `ai-explore.ts` route + tab.

**`server/ai-explore.ts` interface:**

     
                                                                                                                                                               
                                                                                                       
                                                                                                                                          
                                                                                                                                                                                          
                                                                              
                                                 
                                                                                                                              
                                                                                                                                                                               
   

- **P-030** `done` Move `apps/operator/scripts/stagehand-runner.mjs` → `libs/testing-shell/src/server/stagehand-runner.mjs` (`git mv` in the operator repo is wrong — the file moves *into the submodule*; copy it into the lib, then delete the operator copy in Phase 6). Make `startUrl` required (drop the `127.0.0.1:3055` fallback; throw `{type:'error',message:'startUrl required'}` if absent). Export the pricing table as a named const so the core can re-expose it. Add the `./server/stagehand-runner` package export. Commit. (runner COPIED into lib operator copy deleted in Phase 6/P-063; startUrl now required; ./server/stagehand-runner export added.)
- **P-031** `done` Write `ai-explore.test.ts`: `parseAiExploreConfig` rejects missing `goal`/`startUrl` with a message, clamps `maxSteps` to [1,50] and `maxCostUsd` to [0.05,20] (mirror operator `parseConfig` bounds), and passes a valid body; `DEFAULT_MODELS` has the 3 ids. Run → FAIL.
- **P-032** `done` Implement `parseAiExploreConfig` + `DEFAULT_MODELS` + `resolveStagehandRunner` in `server/ai-explore.ts` (lift validation from operator `testing-ai-explore.ts` `parseConfig`). Run → PASS. Commit.
- **P-033** `done` Implement `spawnAiExploreStream` (spawn `process.execPath [runnerPath]`, write `JSON.stringify(cfg)` to stdin, `createInterface` over stdout → yield parsed JSON lines; non-JSON lines → `{type:'log',level:'info',line}`). Add a test mocking `spawn` with a fake stdout stream of two JSON lines; assert the async-iterator yields both parsed. Export from `server/index.ts`. Run → PASS. Commit. (spawnAiExplore + parseAiExploreLine + spawnAiExploreSSE; exported from ./server.)
- **P-034** `done` Port `AIExploreTab.tsx` → `libs/testing-shell/src/web/AiExplorePanel.tsx`. Props: `{ runEndpoint: string; defaultStartUrl: string; defaultGoal?: string; models?: AiExploreModel[] }` (default `models = DEFAULT_MODELS`). Replace operator imports (`toast` etc.) with lib-safe equivalents (inline minimal status text instead of `toast`; the panel already manages its own event list). Keep the SSE `event:`/`data:` line parser (operator lines 110–135). Export from `index.ts`. Add an RTL render test: renders the goal input + model `<select>` with `models.length` options; clicking Run with empty goal shows the inline "enter a goal" message. Run → PASS. Commit. (web/AiExplorePanel.tsx generic props, no operator deps, inline model list to avoid client/server coupling; +3 RTL tests. Dropped the operator inline credential-mgmt UI backend owns the key; missing key surfaces as a run error.)

## Phase 4 — Chaos-desktop (in-app perf-recorder) universal

**Goal:** the in-app recorder chaos (controller + recorder window + channel) moves to the lib `desktop/`, parameterized by `{recorderUrl, defaultRoute, blocklist, durations}`. This is the genuine "generic desktop driver, app supplies config" (user's choice). Transport (Tauri-event vs BroadcastChannel) is auto-detected inside `recorder-channel.ts` via `window.__TAURI_INTERNALS__` (platform-variants D-001 keeps detection out of the *tab* layer, but the channel internally bridges both — it must, to be one component).

**Files (port from operator `app/admin/testing/`):**
- Create `libs/testing-shell/src/desktop/recorder-channel.ts` (from `_lib/recorder-channel.ts`) — `ControllerMsg`/`RecorderMsg` types + a `openRecorderChannel()` that returns `{ send, onMessage, close }` choosing Tauri-event or BroadcastChannel. Pure protocol + transport; unit-testable with a fake transport.
- Create `libs/testing-shell/src/desktop/RecorderHost.tsx` (from `_components/RecorderHost.tsx`) — mounted by the app at its recorder route; sets up PerformanceObservers + console/error capture + autonomous clicking; messages back over the channel. Config via props/URL params: `{ blocklist, runFromQuery? }`.
- Create `libs/testing-shell/src/desktop/ChaosDesktopPanel.tsx` (from `_components/ChaosTab.tsx`) — controller. Props: `{ recorderUrl: string; defaultRoute?: string; blocklist?: string[]; durations?: Record<string,number> }`. Opens the recorder window (Tauri `WebviewWindow` or `window.open`), renders progress/events.
- Create tests: `recorder-channel.test.ts` (message round-trip over a fake transport; transport selection by a `hasTauri` flag), `ChaosDesktopPanel.test.tsx` (RTL: renders route input + duration select + Run; Run calls a mocked window-open with `recorderUrl`).
- Modify `src/index.ts` — export `RecorderHost`, `ChaosDesktopPanel`, channel types.

- **P-040** `todo` Port `recorder-channel.ts` into `desktop/`. Make the channel name a parameter (default `'papercusp-perf-recorder'` → generic default `'pc-perf-recorder'`, configurable) and the transport choice testable: `openRecorderChannel({ channelName, hasTauri }: { channelName?: string; hasTauri?: boolean })`. Write `recorder-channel.test.ts` first (round-trip a `{type:'progress'}` msg through a fake `BroadcastChannel` double; assert `onMessage` fires). Implement. Run → PASS. Commit.
- **P-041** `todo` Port `RecorderHost.tsx` into `desktop/`. Remove operator-specific imports; the perf-observer + console-capture + click loop is app-agnostic (it operates on `document`/`window` of whatever page hosts it). The blocklist comes from a URL query param or prop (default the generic list). Add a smoke RTL/jsdom test that mounting it sets up without throwing and `stop` cleans up. Run → PASS. Commit.
- **P-042** `todo` Port `ChaosTab.tsx` → `ChaosDesktopPanel.tsx`. Parameterize: `recorderUrl` (was the app's own SPA URL + `?perf-recorder=1`), `defaultRoute` (was `'/'`), `blocklist`, `durations` (was the hardcoded `DURATIONS`). Keep the Tauri-`WebviewWindow`-vs-`window.open` branch (detect `__TAURI_INTERNALS__`) and the recorder-window dimensions as props (default 1280×800). Write the RTL test (renders controls; Run with `recorderUrl` opens a window — mock `window.open`). Implement. Export all three from `index.ts`. Run full lib test → PASS. Commit.

> **Note (logged, not silently dropped):** chaos-desktop requires the consuming app to mount `<RecorderHost>` at `recorderUrl`. The operator already has one (the perf-recorder route). Restart does **not** run a desktop shell, so it never enables `chaosDesktop` (its `platform:'web'` hides the tab anyway) — no Restart recorder route is needed. If a future desktop consumer appears, it mounts `<RecorderHost>` per the lib README added in P-061.

## Phase 5 — Universal catalog + `buildUniversalTesting` helper

**Goal:** un-narrow `registry/universal.ts` and add the one-call consumer ergonomic. After this phase the panels/cores exist *and* are discoverable as universal domains.

**Files:**
- Modify `libs/testing-shell/src/registry/universal.ts` — keep `routes`; add pure-data descriptors for `load`, `live-web`, `chaos-web`, `ai-explore`, `chaos-desktop` (id/label/description/tier/platform). **Pure data only — no React** (file stays side-effect-free + server-importable via `./registry`).
- Create `libs/testing-shell/src/registry/universal-tabs.tsx` + `universal-tabs.test.tsx` — `buildUniversalTesting(cfg)` (this file MAY import React + the panels; it is NOT imported by `./registry`).
- Modify `src/index.ts` — export `buildUniversalTesting`, `UniversalTestingConfig`.

- **P-050** `todo` Extend `registry/universal.ts`: add a `platform?: TabPlatform` field to the descriptor objects (the array is typed `TestDomain[]`; `TestDomain` has no platform field, so add the tags in `universal-tabs.tsx`'s tab mapping instead — keep `universal.ts` as `TestDomain[]` of pure `{id,label,description,tier,sections}` and let `buildUniversalTesting` attach platform). Add descriptors for `load`/`live-web`/`chaos-web`/`ai-explore`/`chaos-desktop` (each with a single descriptive section using `runners:[]`-free placeholder — these are custom-panel domains, so give each a `sections:[{id:'panel',label:'…',role:'custom-panel'}]` to satisfy the `defineTestDomain` invariant, or simply DON'T register them via defineTestDomain — they are rendered as customTabs, not domain panels). **Decision:** these five are customTab-only; they do NOT go through `defineTestDomain`/`universalDomains` (which feeds DomainTestPanel). Keep `universalDomains` = `[routes]`; add a separate exported const `UNIVERSAL_PANEL_DOMAINS` (metadata for tab labels/tiers/platform) consumed only by `buildUniversalTesting`. Write the test asserting `UNIVERSAL_PANEL_DOMAINS` has the 5 ids with correct platform tags. Run → FAIL → implement → PASS. Commit.
- **P-051** `todo` Write `universal-tabs.test.tsx` first: `buildUniversalTesting({})` → empty tabs/customTabs; `buildUniversalTesting({ load:{...}, chaosWeb:{...} })` → tabs `['load','chaos-web']` with `load` agnostic + `chaos-web` `platform:'web'`, and `customTabs` has both ids; `{ routes:{globs:[...]} }` → a `routes` tab but **no** `routes` customTab (falls through to DomainTestPanel). Run → FAIL.
- **P-052** `todo` Implement `buildUniversalTesting` in `universal-tabs.tsx`: for each present cfg key, push the tab (from `UNIVERSAL_PANEL_DOMAINS` metadata) and, except `routes`, a `customTabs[id]` thunk wiring the matching panel with cfg (`load`→`<LoadTestPanel {...cfg.load}/>`, `liveObserver`→`<LiveWebPanel/>`, `chaosWeb`→`<ChaosWebPanel runEndpoint baseUrl defaultMaxSteps/>`, `aiExplore`→`<AiExplorePanel runEndpoint defaultStartUrl .../>`, `chaosDesktop`→`<ChaosDesktopPanel recorderUrl .../>`). `routes` emits only the tab. Run → PASS. Export from `index.ts`. Commit.

## Phase 6 — Rewire both consumers, clean up, land the submodule, verify live

**Goal:** both apps consume the lib via `buildUniversalTesting`; bespoke duplicates deleted; submodule landed in both superprojects; live-verified.

### Restart (`platform:'web'`)
- **P-060** `todo` Rewire `Restart/apps/web/app/api/_hono/load-tests.ts` to `export const loadTests = createK6HonoRoutes({ k6Bin: '/home/marsh-office/bin/k6', resolvePaths: (project) => projectPaths(project) })` (reuse Restart's existing `projectPaths`/`getProject`). Delete `Restart/apps/web/app/load-tests/LoadTestPanel.tsx`. Run `npm run test:affected`. Commit.
- **P-061** `todo` Rewire `Restart/apps/web/app/api/_hono/chaos-web.ts` to call `spawnChaosWebStream({ baseUrl, maxSteps: clampMaxSteps(...), repoRoot: getProject(...).repoRoot })` (keep the Hono shell + `ALLOWED_BASE` from the lib). Add a Restart Hono route `apps/web/app/api/_hono/ai-explore.ts` that reads the Anthropic key from Restart's creds, calls `spawnAiExploreStream`, and returns the SSE Response (mirror operator's route shape, Hono-style). Add a short lib `README.md` documenting the desktop `RecorderHost` mount contract. Commit.
- **P-062** `todo` Rewrite `Restart/apps/web/app/tests/TestsClient.tsx` to build its tabs via `buildUniversalTesting({ routes:{globs:[<Restart endpoint-test globs>]}, load:{scriptsEndpoint:'/api/load-tests/scripts',runEndpoint:'/api/load-tests/run',stopEndpoint:'/api/load-tests/stop',resultsEndpoint:'/api/load-tests/results',project:'restart'}, liveObserver:true, chaosWeb:{runEndpoint:'/api/chaos-web/run',baseUrl:'http://localhost:3001/'}, aiExplore:{runEndpoint:'/api/ai-explore',defaultStartUrl:'http://localhost:3001/'} })` then spread `{...uTabs, ...projectTabs}` where projectTabs = the `ci`+`adoption` tabs (kept, with their existing custom panels). Replace the `guardDataSource` stub with a real dataSource so the `routes` domain renders (the original prior-session gap). Keep `platform="web"`. Run `npm run test:affected` + a verdict pass on `http://localhost:3001/tests?project=restart`: confirm the rail shows CI, Adoption, Routes, Load, Live (web), Chaos (web), AI Explore, and that Load runs a smoke test. Commit.

### Papercusp operator (`platform:'both'`)
- **P-063** `todo` Rewire operator `apps/operator/lib/endpoint-route/routes/admin/testing-chaos-web.ts` and `testing-ai-explore.ts` to call the lib cores (`spawnChaosWebStream`, `spawnAiExploreStream`) inside the existing `defineTool`/`sseResponse` wrappers; delete `apps/operator/scripts/stagehand-runner.mjs` (now in the lib; resolve via `resolveStagehandRunner()`). Commit (operator repo — `:3070` has no hot-reload; restart via `dev:restart` after).
- **P-064** `todo` In operator `apps/operator/lib/testing-domains-registry.ts`, remove the now-universal `chaos`/`ai`/`live` defineTestDomain entries (they become universal customTabs); KEEP `test-runs` (admin-suite orchestrator — Papercusp-only) and `live` as the **operator-vitals** business panel (rename its id to `vitals` to avoid colliding with the universal observer's `live-web`; update `testing-custom-tabs.tsx` mapping). Keep the 16 Papercusp-only domains + the `routes` role resolution. Commit.
- **P-065** `todo` Rewire the operator harness Tests tab `apps/operator/app/adv/harnesses/HarnessTestsView.tsx` (and/or `apps/operator-vite` `/admin/testing` `TestingClient.tsx`) to merge `buildUniversalTesting({ routes:{globs:[OPERATOR endpoint globs]}, load:?(omit — papercup has no k6 scripts), liveObserver:true, chaosWeb:{runEndpoint:'/api/admin/testing/chaos-web',baseUrl:'http://127.0.0.1:3055/'}, aiExplore:{runEndpoint:'/api/admin/testing/ai-explore',defaultStartUrl:'http://127.0.0.1:3055/'}, chaosDesktop:{recorderUrl:'<operator SPA>/?perf-recorder=1'} })` with its project/Papercusp-only domains; drop the bespoke `_components/ChaosTab.tsx`/`LiveMetricsTab.tsx`(→keep as `vitals`)/`AIExploreTab.tsx` from `TESTING_CUSTOM_TABS` (replaced by universal customTabs). Keep `platform="both"`. Commit.
- **P-066** `todo` Delete the now-dead operator components: `_components/ChaosTab.tsx`, `_components/AIExploreTab.tsx`, and the desktop recorder pieces now in the lib (`_components/RecorderHost.tsx`, `_lib/recorder-channel.ts`) — replace their usages with the lib exports; mount the lib `<RecorderHost>` at the operator's `?perf-recorder=1` route. Run operator affected tests. Commit.

### Land + verify
- **P-067** `todo` Land the submodule: commit all `libs/testing-shell` changes on `main` in the papercup checkout; in Restart `git -C libs/testing-shell fetch && checkout main && pull` to the same HEAD; bump BOTH superprojects' gitlinks (`git add libs/testing-shell` in each + commit). Do **not** `git push` (memory: submodule pins local-only; ask first). importance: high
- **P-068** `needs-human` Human sign-off: review the live-verified Restart `/tests` + operator `/adv` Tests tab, confirm both render the universal domains from one `buildUniversalTesting` call, then approve push of the submodule + both superproject pointer bumps. importance: high
- **P-069** `todo` Live-verify the operator: launch a dedicated Tauri instance under Xvfb on `DISPLAY=:99` with its own `PAPERCUSP_BRIDGE_PORT` (per `/internal/docs/testing/agent-e2e`); open the `/adv` Tests tab; confirm Universal tier shows Routes/Load(absent, no scripts)/Live(web)/Chaos(web)/AI Explore/Chaos(desktop), that Chaos (desktop) opens a recorder window, and AI Explore starts a Stagehand walk. blocked-by: P-065, P-066

## Verification

- **Lib unit tests:** `npm -w @papercusp/testing-shell run test` green (new: k6, chaos core, ai-explore, recorder-channel, universal-tabs, panel render tests).
- **Restart:** `npm run test:affected` green; verdict pass on `:3001/tests?project=restart` (rail + a real k6 smoke run + Routes now populated).
- **Operator:** affected tests green; Tauri-under-Xvfb `/adv` Tests tab shows the universal set from one config call; Chaos (desktop) + AI Explore actually run.
- **Cross-repo:** both superproject gitlinks point at the same testing-shell `main` HEAD.

## Risks / notes

- **Submodule divergence (P-001)** is the highest-risk step — reconcile before editing; never lose Restart's detached commits.
- **Stagehand/Playwright as optional peers:** importing the cores must not crash a consumer that lacks them. The cores resolve the runner path lazily and only `spawn` it on run; the dynamic `import('playwright')` already lives inside the runner subprocess. Verify a consumer without Stagehand can still load `./server` (import-time must not touch the optional deps).
- **`@/lib/sse` coupling:** the ported `LoadTestPanel`/`AiExplorePanel` must not import app-local modules — inline a tiny SSE line-reader in the lib (P-014).
- **Operator `live` id collision:** universal observer is `live-web`; operator vitals must be renamed off `live` (P-064) — they're different things.
- **No `npm run test:all` for routine edits** (Restart CLAUDE.md); use `test:affected`. `libs/test-config` changes would require `test:all` but this plan doesn't touch it.


## Phase 7 — LLM scenario testing universal

- **P-070** `todo` `todo` Move the generic LLM framework + tests from `apps/operator/lib/llm-testing/` → `libs/testing-shell/src/llm/`: `runner.ts`, `judge.ts`, `sim-user.ts`, `llm-client.ts` (+`MODEL_PRICES`), `types.ts`, `asserts/`, `__tests__/`. Introduce the `ChatTarget` interface (open/send→TurnResult/close) and route the runner's SUT access ONLY through it, so the lib has NO papercup-shared/operator import (the agent-chat-stream usage moves to operator's OperatorTarget in P-073). Run `npm -w @papercusp/testing-shell test` green. See D-007.
- **P-071** `todo` `todo` Define the `LlmTestStore` storage interface in the lib (`persistRunReport`/`listRuns`/`getRun`/`listFindings`/`ackFinding`); the runner takes an injected `store`. The lib NEVER touches Postgres. TDD: a fake in-memory store proves the runner persists a RunSummary + findings through the interface. See D-007 (storage stays per-app).
- **P-072** `todo` `todo` Move the `LlmTab` UI (`apps/operator/app/admin/testing/_components/LlmTab.tsx`, 4 subtabs Targets/Scenarios/Runs/Findings) → `libs/testing-shell/src/llm/LlmTestPanel.tsx`, endpoints via props `{ scenariosEndpoint, runsEndpoint, runDetailEndpoint, findingsEndpoint, credentialsEndpoint? }` (inline any `@/lib/*` deps, like P-014). Add `llm?: {…those endpoints…}` to `UniversalTestingConfig`; `buildUniversalTesting` emits an agnostic `llm` tab (tier `universal`) rendering `LlmTestPanel`. RTL render test + universal-tabs test. Export from `index.ts`.
- **P-073** `todo` `todo` Rewire the operator: import framework + types from `@papercusp/testing-shell/llm` (delete the moved files from `apps/operator/lib/llm-testing/`); keep operator-only data — `scenarios/`, `personas/`, `rubrics/`, and `targets/operator.ts` now `implements` the lib `ChatTarget` (the agent-chat-stream usage lands here); implement `LlmTestStore` against the existing `harness_shared` tables (keep `storage.ts` + schema + `/api/admin/llm-tests/*` routes); map `llm` into the operator's `buildUniversalTesting` config. Operator LLM behavior unchanged. Operator affected tests green; restart `:3070` (no hot-reload).
- **P-074** `todo` `todo` Restart adoption (NO prior Scout scenarios exist to port — only 2 unit tests + 1 e2e found; author fresh — D-008): write `ScoutTarget implements ChatTarget` driving `ScoutService.chat()`/`POST /chat/stream` (map SSE session/token/products/tool_start/card → TurnResult); author ~4-6 starter scenarios (search_products-before-prose, ask_choice, governed `list_orders` routing) + a Restart rubric + shopper persona; add gpt-4o-mini to MODEL_PRICES + set Restart `LLM_TEST_SUT_MODEL`; implement `LlmTestStore` on Restart's DB + `/api/.../llm-tests/*` routes; wire `llm` into Restart's `buildUniversalTesting`. `npm run test:affected` green.
- **P-075** `todo` `todo` Live-verify both LLM tabs end-to-end: operator `/adv` Tests tab (Tauri-under-Xvfb) runs an operator scenario (transcript + judge scores + findings render); Restart `/tests` LLM tab runs a fresh Scout scenario against the live scout-service and shows a pass/finding. blocked-by: P-073, P-074






## Decisions

### D-001 — Component model: separate web + desktop variants, filtered by the existing `platform` prop
Date: 2026-06-03
The user offered (A) one component with a desktop/web parameter or (B) separate universal-web + universal-desktop components each app uses one of. Chose **B**, which also matches what platform-variants-2026-06-01 already built (`LiveWebPanel`/`ChaosWebPanel` + per-tab `platform` tag + `visibleTabs`). The lib ships `web/*` and `desktop/*` variants; `buildUniversalTesting` tags each tab's platform; `TestingShell`'s `platform` prop hides the non-matching ones. No new mechanism; no dead code shipped to either app.

### D-002 — Backend = framework-agnostic core + thin per-app wrapper, not a single cross-framework router
Date: 2026-06-03
Restart uses plain Hono; the operator uses the endpoint-system `defineTool` + `@papercusp/sse`. A single shared router can't satisfy both (auth/trust + transport differ). So the lib owns the *substance* — `runK6Stream`/`spawnChaosWebStream`/`spawnAiExploreStream` returning a `ReadableStream`/line-iterator — and each app keeps a ~5–10 line route adding its own auth + framework. A `createK6HonoRoutes` convenience router is provided for Hono consumers (Restart); the operator wraps the same cores in `defineTool`. This is the honest seam: substance is shared, mount is per-app.

### D-003 — Un-defer cross-project D-002/D-007; supersede its D-008
Date: 2026-06-03
`testing-shell-cross-project-2026-06-01` shipped only `routes` as universal and parked chaos/ai/live as "Papercusp-runtime-bound" (D-007), with D-008 deferring a generic driver as "no consumer." Both premises no longer hold: AI Explore is already URL/model-parameterized (just hardcodes a default base URL + pricing); chaos-web is a Node subprocess that drives any base URL; k6 hits any URL; and there are now two consumers (Restart + operator). The only genuinely shell-coupled piece — desktop chaos — is the in-app `RecorderHost`, which generalizes as a lib `desktop/` component the app mounts. Affects: `testing-shell-cross-project-2026-06-01`, `testing-shell-platform-variants-2026-06-01`.

### D-004 — Live needs no separate desktop variant; operator-vitals stays Papercusp-only
Date: 2026-06-03
`startWebObserver()` runs in any browser context including the Tauri webview, so the universal Live observer (`LiveWebPanel`, tab `live-web`) is **platform-agnostic** — no `LiveDesktopPanel` (YAGNI). The operator's "Live = operator vitals" (voice spend, lock queue) is Papercusp business state, not a portable test tool; it stays operator-only and is renamed off the `live` id to `vitals` (P-064) to avoid colliding with the universal observer.

### D-005 — "Universal" = available in the lib + selected by config presence, not force-shown
Date: 2026-06-03
`buildUniversalTesting(cfg)` emits a tab only for the config keys a consumer supplies. Papercup has no k6 scripts, so it omits the `load` key and shows no Load tab; Restart supplies it and shows it. This keeps the lib the single home for the domain while letting each app opt in per its runtime — the "not tied to Restart other than via configs" the user asked for.

### D-006 — Stagehand + Playwright are optional peerDependencies of the lib
Date: 2026-06-03
AI Explore (Stagehand) and chaos-web (Playwright) pull heavy browser deps. They go in `peerDependencies` with `peerDependenciesMeta.optional:true`; the cores only `spawn`/dynamic-`import` them at run time, so a consumer that never runs those domains isn't forced to install them and importing `./server` never touches them at module load.

### D-007 — LLM scenario-testing framework splits like k6 — generic framework→lib (stateless), data+storage+routes→app, via a ChatTarget abstraction
Date: 2026-06-03
Papercusp's LLM testing harness (`apps/operator/lib/llm-testing/`) is operator-only today. It splits exactly like k6: a **generic framework** with zero Papercusp logic, plus **per-project data**. Phase 7 moves the framework to the lib; data + storage + routes stay per-app.

MOVE TO LIB (`libs/testing-shell/src/llm/`):
- `runner.ts` (sim-user → target.send → asserts → judge → persist loop), `sim-user.ts`, `judge.ts`, `llm-client.ts` (+ `MODEL_PRICES`), `types.ts`, `asserts/` (pluggable `registerEvaluator(kind, fn)`), and their `__tests__`.
- The `LlmTab` UI (856 lines) → `llm/LlmTestPanel.tsx`, endpoints via props: `{ scenariosEndpoint, runsEndpoint, runDetailEndpoint, findingsEndpoint, credentialsEndpoint? }` (mirrors how LoadTestPanel was parameterized).
- The contract INTERFACES: `ChatTarget` (`open() → session`, `session.send(turnInput) → TurnResult`, `close()`), `Scenario`, `Persona`/`PersonaTraits`, `GoalSpec`, `JudgeRubric`/`JudgeAxis`, `DeterministicAssert`, `RunSummary`, `JudgeResult`.

CRITICAL DECOUPLING: the runner currently imports agent-chat-stream from papercup-shared. The lib must NOT depend on papercup-shared (Restart consumes the lib). So the runner talks to the SUT ONLY through the `ChatTarget` interface; the agent-chat-stream usage moves into the operator's `OperatorTarget implements ChatTarget`. After the move the lib `llm/` has no papercup-shared / operator / agent-mcp import.

STATELESS LIB (storage stays per-app — chosen over a lib storage layer): the runner takes an injected `store: LlmTestStore` interface — `persistRunReport(r)`, `listRuns(filter)`, `getRun(id)`, `listFindings(filter)`, `ackFinding(id, on)`. Each app implements it: the operator keeps its `harness_shared.llm_test_runs`/`llm_test_findings` tables + queries (`storage.ts`) + its `/api/admin/llm-tests/*` routes; Restart implements its own against its DB + routes. The lib never touches Postgres. This matches D-002 (substance in lib, mount + persistence per-app).

STAYS PER-APP (data): scenario files (operator's 60+ in `scenarios/`), `ChatTarget` impls (`OperatorTarget`; Restart's new `ScoutTarget`), personas/blends, rubrics. Like k6 scripts: generic runner, per-project data.

HELPER: `buildUniversalTesting` gains an optional `llm?: { scenariosEndpoint; runsEndpoint; runDetailEndpoint; findingsEndpoint; credentialsEndpoint? }` key → emits an `llm` tab (tier `universal`, platform-agnostic) rendering `LlmTestPanel` wired to those endpoints. Omit the key → no LLM tab (D-005).

Model selection stays config-driven (env `LLM_TEST_SUT_MODEL`/`LLM_TEST_JUDGE_MODEL`/`LLM_TEST_SIM_MODEL` + agent-config); `MODEL_PRICES` moves with `llm-client.ts` and is extensible (the operator uses claude-*; Restart's Scout uses gpt-4o-mini/gemini/groq/qwen — add their prices when wiring Restart).

### D-008 — Restart adopts LLM testing now via a ScoutTarget + freshly-authored scenarios — no prior Scout scenarios existed to port
Date: 2026-06-03
User asked to wire Restart's LLM testing now AND to find/port the "lot of Scout tests" agents had run. Investigation (2026-06-03) found NO saved Scout LLM scenarios/evals anywhere in Restart — nothing encodes "given user message → expect tool-call/response". The entire Scout test surface is: `apps/scout-service/src/scout/scout-governance.test.ts` (memory-scope + governed tool allow-list, 4 cases), `apps/scout-service/src/scout/card-correlator.test.ts` (ask_choice pause/resume, 4 cases), and `apps/shop/src/lib/scout-fab.e2e.test.ts` (FAB CSS visibility, Playwright). None are conversational. So there is nothing to port; Restart scenarios are authored fresh.

Restart adoption (Phase 7, P-074):
- `ScoutTarget implements ChatTarget` in `apps/scout-service` (or a Restart test lib). Drives Scout's real entry point: `ScoutService.chat(req): AsyncGenerator<CopilotSSEEvent>` (`apps/scout-service/src/scout/scout.service.ts:124`) or `POST /chat/stream` (`scout.controller.ts:98`). Request `CopilotChatRequest { sessionId?, message, pageContext?, model?, userId? }`; SSE events `{type:'session'|'token'|'products'|'tool_start'|'card'|'done'}`. The target maps these to the framework's `TurnResult` (assistant text from `token`, tool calls from `tool_start`, cards from `card`).
- Author ~4-6 starter scenarios from Scout's documented behavior (system prompt + COPILOT_TOOLS in `scout.types.ts`): e.g. "show me laptops under $800" → asserts `tool_called: search_products` with `category:'Laptops'`, `maxPriceCents:80000`, and a `products` event before prose (the system-prompt guardrail); an `ask_choice` scenario; a governed-tool scenario ("show my orders" → `list_orders`/`orders.list`). Plus a Restart rubric (axes: helpfulness, grounded-in-catalog, tool-discipline) + a shopper persona.
- Scout default model is gpt-4o-mini (OpenAI) — add its pricing to `MODEL_PRICES` and set Restart's `LLM_TEST_SUT_MODEL` accordingly; judge can stay a claude model.
- Restart implements `LlmTestStore` against its DB + adds `/api/.../llm-tests/*` routes + wires `llm` into its `buildUniversalTesting` config so `/tests` gets a live LLM tab.
