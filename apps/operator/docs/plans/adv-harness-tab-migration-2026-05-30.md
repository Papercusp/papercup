---
title: ADV Harness Tab — port /harness queues into /adv
slug: adv-harness-tab-migration-2026-05-30
status: active
created: 2026-05-30
updated: 2026-05-30
owner: avi@storewolf.com
---

# ADV Harness Tab — port /harness queues into /adv

## Now

**State:** Phase 1 (3-panel Features/Issues/Detail + pin-to-panel) shipped as `402c80da` but was never verified — the originating OMP session (`019e60b2`, 2026-05-25/26) broke the dev API server while testing and ended by asking the user to restart Tauri. Re-verifying now against the `papercup` harness (the workspace no longer has `sheets`; `papercup` has features but 0 issues).

**Next:** (B) verify v1 renders in the live Tauri webview via `tauri-agent-tools`; then (C) build Phase 2 — visual & filter parity in the Features/Issues panels.

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
- **P-008** `todo` Verify Phase 1 end-to-end in the live Tauri webview (`tauri-agent-tools`): Harness tab visible, 3 panes render with non-zero height, Features list populated for `papercup`, row-click drives Detail, right-click pins a panel, no console errors. (This is task B.)

## Phase 2 — Visual & filter parity

- **P-009** `todo` Features saved-view chips with counts: All / Running (in_progress+validating) / Stuck (attempts ≥3) / Blocked (blocked+failing) / Todo / Passed / Deprecated. Mirror `BUILT_IN_VIEWS` from `FeatureList.tsx`. Replaces the current flat status filter.
- **P-010** `todo` Features result counter ("N/M shown") and per-row parity: status pill colors, attempts pill (warning tint at ≥3), claims chip, plan pill (`↗ plan` linking to `/adv/plans?slug&plan=<sourcePlanSlug>`).
- **P-011** `todo` Issues per-row parity: severity icon+color, source icon (validator/worker/human → Bot/User), status icon (Hammer when fixing, CheckCircle when closed…), code-pointer chip (FileCode), linked-feature pill (ArrowUpRight), `foundDuring` chip.
- **P-012** `todo` Issues pending-validator triage: pending banner + "Triage N" button above the list when pending findings exist.
- **P-013** `todo` Decide fate of legacy lifecycle chips (mine / working / available / shipped) and project/tag filters — keep only if used in practice; default to cutting `mine` (needs viewer github id) on first pass.

## Phase 3 — Live data via Zero

- **P-014** `todo` Replace the 5–6s REST `setInterval` polling in FeaturesPanel / IssuesPanel / DetailPanel with `useSyncQuery` against the same query names the legacy uses (`featuresConsolidated`, `issuesConsolidated.bySlug`, `harnessPendingIssues.byHarness`). Drop the polling timers. On desktop the transport is SSE (per CLAUDE.md). Stops the periodic flicker.

## Phase 4 — Detail richness

- **P-015** `todo` Feature Detail: last 3 agent runs (result line; click → opens the session), "Issues filed against this feature" (1-line each, click → swaps `?sel` to the issue), steer notes (collapsed unless populated).
- **P-016** `todo` Issue Detail: add-note form + existing notes (collapsed); linked-feature pill click → swaps `?sel` to the feature; selection-history "Back" affordance.

## Phase 5 — Inline row actions

- **P-017** `todo` Features rows: Reset / Edit / Chat / Steer inline (reuse `OperatorNoteForm` + `openFeatureChat` via alias where cheap).
- **P-018** `todo` Issues rows: Promote / Acknowledge / Close / Won't-fix inline (the Detail pane already has these; surface on the row too).

## Phase 6 — Polish

- **P-019** `todo` Keyboard shortcuts scoped to the focused panel: J/K move, ↵ open (sets `?sel`), R reset, X select, / search. Mirror `useShortcut('feature.*')` registrations.
- **P-020** `todo` Virtualize the lists (`@tanstack/react-virtual`) once a harness regularly exceeds ~100 rows.
- **P-021** `todo` Empty-state + loading-state refinement across all three panes.

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
