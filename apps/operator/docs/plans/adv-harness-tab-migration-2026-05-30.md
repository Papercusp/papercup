---
title: ADV Harness Tab — port /harness queues into /adv
slug: adv-harness-tab-migration-2026-05-30
status: shipped
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# ADV Harness Tab — port /harness queues into /adv

## Now

**State:** Migration shipped + audit follow-ups + dock-panel ports (agents/logs/overview) done. This pass (D-012): (1) decoupled the brainstorm/prs/settings/insights/git /adv tabs from the 5,259-line HarnessDashboard — they now render their own panel components directly (commit 5091d985); only config + docs still mount the monolith. (2) Soft-retired /harness as a landing — home redirect, header CTA, and the root /harness route all now go to /adv; old /harness?panel=/?slug= URLs translate-redirect in (commit 063114fa). All verified live in Tauri. /harness/$slug (org/department + dock shell) intentionally left functional — no /adv parity yet.

**Next:** To finish full retirement (P-022): decouple config + docs from HarnessDashboard (lift plugin-tab + spec resolution into a shared hook), then give /adv org/department + per-slug parity for /harness/$slug; once no /adv tab renders HarnessDashboard, move legacy-only app/harness/* page code to _retired/.

## Background

The `/adv` route is replacing the legacy `/harness` OPS dashboard. Once every feature is ported, `/harness` is deleted. This plan covers porting the feature-queue and issues-queue into a new **Harness** tab in `/adv` (tab id `harnesses`, label "Harness").

The plan was originally carried entirely in the OMP chat — no plan file existed. This doc formalizes it. The finalized design (after the user steered away from the cluttered legacy `FeaturePeekPanel` drawer) is a **three-panel dockview layout**: Features list, Issues list, and a persistent Detail pane driven by `?sel=<id>`, plus right-click → "Pin to new panel".

Key files (live UI is the Vite SPA; components live in the Next tree and are consumed via the `@/app/adv/harnesses/*` Vite alias):
- `apps/operator/app/adv/harnesses/{HarnessesWorkspace,HarnessTopBar,HarnessesDock,FeaturesPanel,IssuesPanel,DetailPanel,PinMenu}.tsx`
- `apps/operator/lib/dock-layouts.ts` — `defaultAdvHarnessesLayout()` seed (lines ~259, ~500, ~620)
- `apps/operator-vite/src/components/adv/{AdvShell,AdvNowRunning}.tsx`
- Legacy references to port: `apps/operator/app/harness/FeatureList.tsx` (938 lines) + `apps/operator/app/harness/issues/IssuesList.tsx`

## Phase 1 — Skeleton + minimal Detail + pin-to-panel (shipped, unverified)

- **P-001** `done` Add "Harness" tab to AdvShell (Vite + parallel Next shell). Tab id `harnesses`, label "Harness", first in the strip.
- **P-002** `done` Rebuild the top bar fresh (`HarnessTopBar`) — pulse / lanes / passed / $ spent / health badge; data from `/api/harness/<slug>/status`. Not extracted from the 5,270-line `HarnessDashboard.tsx`.
- **P-003** `done` `AdvNowRunning` widget in the AdvShell header — compact Start/Stop + one pulsing pill per running agent, hover → legacy `AgentThinkingPopover` (SSE thinking stream) reused via alias.
- **P-004** `done` 3-panel dock seed `defaultAdvHarnessesLayout` (Features 1 / Issues 1 / Detail 2). Register `adv:features`, `adv:issues`, `adv:detail`, `adv:pinned` in `HarnessesDock`; reuse `panel-registry` + `HarnessDock` + `layout-adapter`.
- **P-005** `done` `DetailPanel` — swap mode reads `?sel=<id>` (F-* → feature, I-* → issue); pinned mode locks to `params.itemId` and ignores `?sel=`. Minimal content: header + description + status changer + Reset/Edit (features); evidence/repro/suggested-fix/code-pointer + Promote/Ack/Close/Won't-fix (issues).
- **P-006** `done` Row click → `?sel=<id>` (active-row highlight); right-click → `PinMenu` "Pin to new panel" → spawns an `adv:pinned` dock tab.
- **P-007** `done` WebKitGTK height-collapse fix: dock wrapped in `position:absolute; inset:0` (height:100% through a flex parent collapses to 0 in WebKit) + `layout-adapter` carries leaf `size` so the seed split applies (commit `26fac5cd`).
- **P-008** `done` Verified Phase 1 end-to-end in the live Tauri webview (`tauri-agent-tools`, against `papercup`): Harness tab renders, `.dv-shell` full-height (no WebKit collapse), 3 feature rows, row-click → `?sel` → Detail shows the feature. Found+fixed the lopsided-split bug (P-007 follow-up): `toLayoutDoc` dropped leaf `size` on save → reload gave panes 100px; fixed in `b02e2aea` + regression test (178 dock tests green); stale `adv-harnesses:papercup` layout row cleared so it reseeds 25/25/50 (verified Features 301 / Issues 301 / Detail 602).

## Phase 2 — Visual & filter parity

- **P-009** `done` Features saved-view chips with counts: All / Running / Stuck (≥3) / Blocked / Todo / Passed / Deprecated, mirroring `BUILT_IN_VIEWS`; deprecated hidden from every view except Deprecated. Shipped `b46bb5d6`.
- **P-010** `done` Features result counter ("N/M shown") + per-row parity: status pill colors, attempts pill (warn tint ≥3), needs-human-review dot (`b46bb5d6`). Claims chip + plan pill landed with Phase 3 (`c94b4d9f`) once `claims`/`sourcePlanSlug` became available via the Zero consolidated row.
- **P-011** `done` Issues per-row parity: severity icon+color, source icon (Bot/User), status icon (Circle/Eye/Hammer/CheckCircle/XCircle), code-pointer chip (FileCode + basename), linked-feature pill (ArrowUpRight), `foundDuring` chip. All icon maps use `?? Circle` fallback so a missing key can't crash the subtree. Shipped `b46bb5d6`.
- **P-012** `done` Issues pending-validator triage banner above the list when `pending.length > 0`. **Note:** rendered as an informational banner, not a "Triage N" button — the legacy Triage action opens `TriageQueue` (`?triage=true`), which isn't ported to `/adv` yet; wiring it is deferred until the triage flow lands. Shipped `b46bb5d6`.
- **P-013** `done` **Decided + implemented (`d0d82699`):** legacy lifecycle chips (working/available/shipped) are redundant with the Phase 2 saved views (Running/Todo/Passed) → not ported. `mine` (queue membership) needs a viewer github-id + multi-user queue data → deferred. Project filter is multi-project/sub-harness-only (own plan) → not ported. **Tag filter folded into the feature search** — `tags` now carried through `useHarnessData` (REST + Zero) and matched in search ("Search features or tags…"). Verified live (tag term filters the list).

## Phase 3 — Live data via Zero

- **P-014** `done` Replaced the 5–6s REST `setInterval` polling with `useSyncQuery` via a shared `useHarnessData` hook (`featuresConsolidated.bySlug`, `issuesConsolidated.bySlug`, `harnessPendingIssues.byHarness`). Polling timers gone. **Design:** one-shot REST bootstrap + Zero overlay (apply Zero only when it returns a non-empty array) rather than pure-Zero — REST reads `harness_features` while Zero reads the separate `harness_features_consolidated`, which can lag; the hybrid (mirrors HarnessDashboard) is robust whether or not a harness is consolidated. `RootSyncProvider` wraps `/adv` so the harness queries resolve there. Shipped `c94b4d9f`.

## Phase 4 — Detail richness

- **P-015** `done` Feature Detail: "Issues" section (issues where `linkedFeatureId`/`foundDuring` == this feature, click → swaps `?sel`), "Recent activity" (last 3 agent runs for the feature from `agentRunsConsolidated.bySlug` — role · time · cost), and collapsed "Steer notes" (`GET /features/<id>/notes`). Shipped `2e491ee6`. **Deferred:** the run "result line" + click-to-open-session — the consolidated run row has no result column (it's in the run jsonl), and there's no adv run-viewer yet; runs are read-only role·time·cost for now.
- **P-016** `done` Issue Detail: linked-feature pill is now a button (→ swaps `?sel` to the feature) + a Notes section with an add-note form (`POST /issues/<id>/update {note, by:'human'}`, optimistic append). Selection-history "Back" chip retraces feature↔issue cross-links (module-scoped stack, swap panel only). Shipped `2e491ee6`. Feature-side + Back verified live; issue-side contract-verified (no issues on papercup, no DELETE endpoint → a throwaway wasn't worth the PG cruft).

## Phase 5 — Inline row actions

- **P-017** `done` Features rows: hover actions Reset / Edit / Chat (`openFeatureChat` worker chat via `@restart/papercup-shared`). Shipped `30138d81`. **Deferred:** Steer-inline — the Detail pane shows steer notes read-only; a feature note-add needs the operator-notes write contract (follow-up, pairs with a feature add-note in Detail).
- **P-018** `done` Issues rows: hover actions Promote / Acknowledge / Close / Won't-fix (status-conditional, mirroring the Detail pane), via the shared `harness-actions` helper. Shipped `30138d81`. Feature rows verified live; issue rows contract-verified (no issues on papercup).

## Phase 6 — Polish

- **P-019** `done` Panel-scoped keyboard nav: J/K (or arrows) move a focus cursor (ring + scroll-into-view), ↵ opens (sets `?sel`), R resets the focused feature (features only), `/` focuses search, Esc blurs. X/multi-select dropped — the adv panels have no batch ops. Verified live (j → fidx 0→1, Enter → `?sel=F-DOGFOOD-002`). Shipped `537662f4`.
- **P-020** `done` Virtualized both lists with `@tanstack/react-virtual` (`c0283ca6`): only the visible window mounts, `measureElement` for accurate heights, absolute `translateY` positioning; the keyboard scroll switched from `scrollIntoView` to `virtualizer.scrollToIndex` (focused row may not be mounted). The hover-action overlay still works (the absolute row remains its positioning context). Verified at scale via a temporary 200-row synthetic scaffold (papercup has 3 features / 0 issues): **203 features → 31 DOM rows, 200 issues → 34 DOM rows**; container heights correct; selection + keyboard intact; scaffold removed before commit.
- **P-021** `done` Consistent loading/empty/error states across the panes + a kbd-hint footer (`J/K · ↵ · R · /`) that doubles as P-019 discoverability alongside the N/M-shown counter. Shipped `537662f4`.


## Phase 7 — Deferred follow-ups

- **P-022** `todo` **/harness route retirement (multi-step, needs human sign-off).** See D-010 for why a `_retired/` move is not possible today. Prep: (a) extract shared substrate (`dock/`, `Button`/`Select`/`Tooltip`, `HealthBadge`, `HarnessDashboard`, `CreateHarnessPicker`, `issues/types`) out of `app/harness/` into a neutral home so `/adv` imports survive; (b) re-point home redirects (`routes/index.tsx:31`, `app/page.tsx:20`) → `/adv`; (c) re-point ~18 inbound links + header "Ops" CTA; (d) port remaining `/harness`-only surfaces (proposals/summary/consoles/modals/banners) into `/adv`; (e) then move the residual route page to `_retired/` + RESTORE.md + git tag.
- **P-023** `todo` **#4 Richer recent-activity runs (P-015 enhancement) — deferred, blocked on data.** Wanted: a result/outcome line + click-to-open-session in DetailPanel's "Recent activity". Blocked because `harness_shared.agent_runs_consolidated` has **no outcome/result column** (only role, ts, cost_usd, tokens, duration_ms, `running`) and **no session pointer** (run_id only, no session_id/omp_session_id) — so neither the result line nor the session link has a field to bind to. Also papercup has 0 agent runs, so any change is unverifiable here. Unblock: add an outcome/result + session-id projection to the consolidated row (or join the run→session source), then render + verify against a harness that actually has runs.


## Decisions

### D-001 Per-harness scope, not cross-harness
Date: 2026-05-30

The first cut proposed cross-harness queues with per-harness as a filter. The user reversed this (OMP turn #7): the Harness tab is **single-harness**, identical in scope to the legacy `/harness`. Top bar + both queues are driven by the selected `?slug=`. No cross-harness fan-out endpoint is needed; existing `/api/harness/<slug>/status` + `/issues-list` suffice.

### D-002 Three-panel layout with a persistent Detail pane
Date: 2026-05-30

Chosen over (a) the legacy right-side `vaul` drawer, (b) inline row expansion, (c) open-each-item-as-its-own-dock-panel. The Detail pane always shows the currently-selected item (`?sel=<id>`, type inferred from `F-`/`I-` prefix), email-client "reader pane" style. Default split Features 1 / Issues 1 / Detail 2. Cross-linking is natural (issue→feature and feature→issue both swap the selection). Leans into dockview rather than fighting it (user resizes/moves/pops-out the Detail pane for free).

### D-003 Pin-to-panel ships in v1
Date: 2026-05-30

Right-click a row → "Pin to new panel" spawns an `adv:pinned` dock tab bound to that item id; it ignores `?sel=` so it stays put while the user keeps clicking. Same renderer as Detail. This is the mitigation for "Detail only shows one thing" and the user asked for it in v1 (OMP turn #35).

### D-004 Cut the legacy drawer's workflow plumbing
Date: 2026-05-30

The legacy `FeaturePeekPanel` had 14+ sections. Detail keeps only what answers "what is this, why is it stuck, what do I do": description, status, actions, recent runs, linked issues, steer notes (feature); evidence, repro, suggested fix, code pointer, actions, notes (issue). Cut to `/admin/features` (the editor) or dropped: claims, prompt budget, chunk plan, completion ref, synthesis notes, debugger notes, messages-from-other-features, tags & see-also.

### D-005 Rebuild panels fresh, reuse dock infrastructure
Date: 2026-05-30

The two queue components are rebuilt from scratch (the legacy ones are single-slug with baked-in filter/status logic), but the dock shell is reused: `panel-registry`, `HarnessDock`, `layout-adapter`. Legacy leaf components are reused via the `@/app/harness/*` Vite alias only where cheap and stable (e.g. `AgentThinkingPopover`).

### D-006 Components live in the Next tree, served via the Vite alias
Date: 2026-05-30

The live `/adv` UI is the Vite SPA (`apps/operator-vite`). The panel components live under `apps/operator/app/adv/harnesses/` (Next tree) and are imported into the Vite app through the `@/app/adv/harnesses/*` alias; `dock-layouts.ts` lives in `apps/operator/lib`. `<style jsx>` is not available in the Vite SPA — use plain `<style>`.

### D-007 WebKitGTK absolute-fill for height-filling dock content
Date: 2026-05-30

DockviewReact's `.dv-shell` sizes via `height:100%`, which WebKitGTK (the Tauri webview) does not resolve when an ancestor's height comes from `flex:1` — Chromium does, so Playwright/`:3070` checks looked fine while the real webview rendered a 0-height dock. Mount height-filling components (dockview, editors, virtualized lists) in a `position:relative` box with `position:absolute; inset:0` children. See agent-insight on WebKit flex→height:100% collapse.

### D-008 Never kill the user's hono-host to verify
Date: 2026-05-30

The originating session killed `hono-host` to pick up a `lib/*.ts` change and the replacement bound to an empty workspace (`/api/harness/projects/lite` → `[]`), breaking every panel. Lesson: UI-only changes only need the Vite build-watcher (no hono restart); for a `lib/dock-layouts.ts` change, restart the **Tauri desktop** (which re-runs the embedded-PG handshake) rather than hand-restarting `hono-host`. Already in agent memory.

### D-009 — Optimistic UI updates — hand-rolled now, Zero mutators later
Date: 2026-05-30
Date: 2026-05-30

An audit found mutations (feature status-change/reset, issue ack/close/won't-fix) POSTed + toasted but did **not** update the UI until a Zero push or reload — most visibly the Detail status `<select>` snapping back. Fixed (`e1f12917`): `useHarnessData` now exposes `patchFeature`/`patchIssue`; each action site does snapshot → optimistic patch → POST → rollback-on-error, and the Zero overlay reconciles when it pushes.

**Why hand-rolled, not Zero mutators:** per the Restart `data-fetch-surfaces-strategy-2026-05-29` plan, the *proper* end-state for synced-entity CRUD is **Zero custom mutators** (`@restart/sync` `zero.mutate.*` — optimistic apply + auto-rollback + reconcile + self-updating read cache). But that path is **not built**: the `@restart/sync` client is constructed without `mutators` (confirmed in `libs/sync/src` — no `mutators`/`zero.mutate`/`useSyncMutate`), it's the **WS** transport, and papercup desktop is **SSE**. The Restart plan itself states "No optimistic Zero writes happen today … today's optimistic UX is hand-rolled component state." So hand-rolled optimistic is the correct interim — it matches the legacy papercup panels (`IssuesList` `setIssues(prev.map(...))`) and Restart's current reality, and is forward-compatible: when the Zero-mutator path lands (Restart P4 — thread `mutators` through `SyncProvider`, expose `useSyncMutate`, + an SSE-mutate fallback), these sites swap to `zero.mutate.*`.

**Known limitation:** the patch is per-hook-instance, so only the *firing* pane updates instantly (Detail when you change status there; the list row when you act on a row). The other pane reconciles via Zero. True cross-pane instant coherence is exactly what the shared Zero store (mutators) gives — deferred with the convergence. Promote stays non-optimistic (server-assigned `linkedFeatureId` isn't client-predictable).

### D-010 — /harness is NOT a retirable leaf — retirement deferred, not executed
Date: 2026-05-30
Asked to "delete the legacy /harness route" (move it under `_retired/`). Investigated against the code — it is **not** a retirable leaf and the move was **not** executed, because it would break the very `/adv` view this plan built, plus the home page.

**Why it can't move to `_retired/` today:**

1. **`/adv` is built ON `app/harness/`.** `/adv/harnesses/*` statically imports from it: the entire dock framework (`dock/HarnessDock`, `panel-registry`, `dock-actions`, `AddPanelCatalog`), shared UI (`@/app/harness/Button`,`Select`,`Tooltip`), `HealthBadge`, `HarnessDashboard`, `CreateHarnessPicker`, and `issues/types`. Moving `app/harness/` under `_retired/` (which drops it from the workspace globs) breaks `/adv`'s build. The migration *reused* the substrate; it did not replace it.
2. **`/harness` is the home redirect** in two places: `apps/operator-vite/src/routes/index.tsx:31` (`redirect({ to: '/harness' })`) and `apps/operator/app/page.tsx:20` (`redirect('/harness')`). Retiring it 404s the home page.
3. **~18 files link to `/harness`** (header "Ops" CTA in `ChromeShell`, `not-found.tsx`, `SetupWizard`, `snapshots/SnapshotsClient`, route-pending helpers, many tests).
4. **Unported surfaces** still live only in `/harness` (proposals / summary / consoles / modals / banners).

The `_retired/` convention fits **separable leaf surfaces** (e.g. `_retired/papercup/` public site). `app/harness/` is a route **plus** the shared component/dock library `/adv` depends on — not separable as-is.

**Prep checklist to make it retirable later (see P-022):** (a) extract the shared substrate out of `app/harness/` into a neutral home (`app/_harness-shared/` or a lib) so `/adv`'s imports survive; (b) re-point the two home redirects `/harness` → `/adv`; (c) re-point the ~18 inbound links + the header "Ops" CTA; (d) port the remaining `/harness`-only surfaces into `/adv`; (e) only then is the residual route page a leaf that can move to `_retired/`.

### D-011 — Ported Agents / Run log / Overview dock panels + fixed the catalog add-panel bug
Date: 2026-05-30
Per the user's directive to "continue migrating the rest of the panels (run-log, recent agents, …) before retiring the old view," ported three legacy `Real*Panel` dock panels into `/adv` as new panel types (committed `7597e7a9`):

- **adv:overview** (`AdvOverviewPanel`) ← `RealHarnessOverviewPanel`: phase tabs (staging/testing/production, persisted via `/harness-phase-last-used`), alive/escalated/smoke badges, progress bar, status-bucket counts, iteration + mission cost.
- **adv:agents** (`AdvAgentsPanel`) ← `RealAgentsPanel`: running-dot + role accent + runId + size + age, Running/All toggle. Live via Zero `agentRunsConsolidated.bySlug` overlay + REST `/agents` bootstrap (no 5s poll).
- **adv:logs** (`AdvLogsPanel`) ← `RealLogsPanel`: `run.log.jsonl` tail with level chips + source filter (one-shot read + manual Refresh, no 3s poll).

New shared hooks `useHarnessAgents` / `useHarnessLogs` in `useHarnessData.ts`. Registered in `HarnessesDock`; added to `AddPanelCatalog` labels + the `/adv` `allowedTypes`. Token-clean (blue-frost vars) + library-compliant (aria-pressed toggles, lucide icons).

**Pre-existing dock bug fixed along the way:** `HarnessDock.useComponentsForLayout` built dockview component bridges from *only the current layout's types*, so the "Add panel" catalog threw `"Only React.memo/ForwardRef/functional components are accepted"` for ANY type not in the seed — `adv:git` was already broken this way, never noticed because it was never opened via the catalog. Now bridges every *registered* type (the `registryTick` subscription that was already wired finally does something). All four catalog panels verified opening live in the Tauri webview against papercup; layout reset back to the 3-pane seed afterward.

**Still unported before retirement (P-022):** the legacy `view:proposals` and `data:chat` dock panels. The `view:docs/insights/config/summary` surfaces are already top-level `/adv` tabs (docs/insights/config/plans/sessions), not harness-dock panels, and `summary` ≈ the new `adv:overview`.
Related: P-022

### D-012 — Decoupled 4 /adv tabs from HarnessDashboard + soft-retired /harness as a landing
Date: 2026-05-30
Two-phase pass, committed `5091d985` (decouple) + `063114fa` (retire).

**Phase 1 — decouple tabs from the monolith.** Previously 7 `/adv` tabs rendered the entire 5,259-line `HarnessDashboard` via `AdvHarnessPanelPage` (forcedPanel + CSS-hidden chrome) just to show one panel. The panel bodies are already self-contained components the dashboard lazy-loads, so `AdvHarnessPanelPage` now references them directly:
- `brainstorm` → `<BrainstormFull slug/>`; `prs` → `<PrsTab harnessSlug/>`; `settings` → `<HarnessSettingsPanel slug phase/>`; `insights` → `<AdvInsightsTab slug/>` (tiny wrapper fetches `/status` → `<InsightsPanel/>`); `git` → native `RealGitPanel` + `<PrsTab/>` pane.
- `config` + `docs` still fall back to `<HarnessDashboard forcedPanel embeddedPanelChrome/>` — their bodies need the dashboard's plugin-tab + spec resolution; decoupling those is the remaining work.
- Added `harness.css` to the `/adv` shell (`__root.tsx`) so directly-rendered panels keep `h-*` styling without the monolith.
- Verified live: brainstorm/prs/settings/insights render with NO `.h-root` (dashboard not mounted); config still mounts it.

**Phase 2 — soft-retire `/harness` as a landing.** `/adv` is now the sole entry; old `/harness` URLs redirect in. No code deleted (HarnessDashboard still backs config/docs).
- Home redirect (`routes/index.tsx` + `app/page.tsx`) → `/adv?tab=harnesses`.
- Header "Ops" CTA: dropped the legacy `/harness` block, single `/adv` OPS remains.
- `routes/harness/index.tsx` → translating redirect to `/adv` (`?slug=`/`?project=`→slug, `?panel=`→tab map).
- `NotFound` + `wiki/missing` "return to dashboard" → `/adv`.
- Verified live: `/`, `/harness`, `/harness?panel=brainstorm`, `/harness?slug=papercup&panel=prs` all land on the right `/adv` tab; header has one OPS → `/adv`, no `/harness` link.

**Deferred:** `/harness/$slug` + sub-routes (`spec`/`insights`/`projects`/`dock-preview`) are NOT redirected — they render org/department dashboards + the dock shell, which `/adv` has no parity for. Functional, reached only via deep links.

**Still blocking full code retirement (P-022):** decouple `config` + `docs` from `HarnessDashboard` (lift plugin/spec resolution into a shared hook), and give `/adv` org/department + per-slug parity for `/harness/$slug`. Once no `/adv` tab renders `<HarnessDashboard/>` and `$slug` is covered, the legacy-only `app/harness/*` page code can move to `_retired/`.
Related: P-022

### D-013 — config tab decoupled from HarnessDashboard via shared-file extraction; docs is the last holdout
Date: 2026-05-30
Per the user's "extract to a shared file" directive (the same pattern brainstorm/prs/settings/insights already use — those components were already standalone files), decoupled the **config** tab from the 5,259-line `HarnessDashboard` in three committed steps:

1. **`9038ac42`** — extracted shared plugin helpers (`PLUGIN_ICON_MAP`, `PluginIcon`, `pluginSlugFromPath`, `InstalledPluginInfo`/`InstalledPluginAction`/`EnabledPluginManifest`) into `app/harness/plugin-utils.tsx`; monolith imports them.
2. **`e3460a4f`** — moved the config cluster verbatim into `app/harness/ConfigPanel.tsx` (`ManifestOrLegacySpecEditor`, `ConfigTabBtn`, `ConfigPanel`, `PluginPanelCard`, `PluginConfigEditor`, `renderPluginConfigInput` + style consts; ~810 lines). Editors switched from the local `dynamicWithRetry` to static imports. Monolith now `import { ConfigPanel }`. Behavior preserved (verified config still renders via the monolith's import).
3. **`a1201c1b`** — new `AdvConfigTab` (`app/adv/harnesses/`) supplies `ConfigPanel`'s props the way the monolith did inline: `/status` (path/alive), `/api/plugins/global` (installed), Zero `pluginEnables.byWorkspace` (enabled slugs), Zero `pluginConfigs.byHarness` ∩ `configSchema.required` (the needs-setup map). `renderAdvTab` maps config → `AdvConfigTab`. **Verified live: `/adv?tab=config` renders the config rail + Harness pane + spec editor with NO `.h-root` — dashboard not mounted.**

**Net /adv state:** of the original 7 HarnessDashboard-backed tabs, 6 now render their components directly (brainstorm/prs/settings/insights/git + config). **Only `docs` still mounts `<HarnessDashboard forcedPanel="docs"/>`.**

**docs is deferred** because: (a) it's entirely plugin-contribution-driven — `?panel=docs` resolves to `plugin:<tabId>` via a plugin declaring `replaces:['docs']`, rendered by the monolith's inline plugin-tab dispatch (`PluginIframeWithLoader`/`PluginReactTab`/`InlinePiDock`); and (b) **papercup ships 0 dashboard-tab plugins**, so docs is empty here and its render path is unverifiable on this harness. Decoupling it = extracting that renderer cluster + a `usePluginTabs` hook, shipping unverified. Recommend doing it against a harness that actually ships a docs plugin, or as an explicit contract-only pass. Once docs is decoupled, NO `/adv` tab mounts `HarnessDashboard` and the legacy-only `app/harness/*` page code can move to `_retired/` (P-022).

Note: the plugin-only lucide imports `HarnessDashboard` no longer uses (post `PLUGIN_ICON_MAP` move) are left for a knip sweep.
Related: P-022
