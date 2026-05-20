---
title: Dockview migration plan (consolidated v3) — 2026-05-13
slug: dockview-migration-plan-2026-05-13
status: active
created: 2026-05-13
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Status**: proposal, awaiting greenlight. No code shipped.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Dockview migration plan (consolidated v3) — 2026-05-13

**Status**: proposal, awaiting greenlight. No code shipped.

**Supersedes**: the v1 plan and v2 audit-appendix in earlier revisions of this file.

This document is the single source of truth for the operator dockview migration.
Read top-to-bottom. Section A = what we're building and why. Section B = the
phased plan with concrete acceptance criteria. Section C = open decisions
gating greenlight. Section D = notes for the implementer.

---

## A. What we're building

### A.1 Goal

Every long-lived view in the operator harness UI becomes a draggable, dockable
panel inside one shared `dockview-react` tree. Users freely arrange / split /
float panels. Layouts persist per-user across machines via Postgres. The pi
tab's existing dock pattern extends to the entire operator.

### A.2 Non-goals

- Replacing app chrome (operator chat sidebar, command palette, toasts) — these
  stay fixed outside the dock.
- Transient overlays (FeaturePeekPanel drawer, IssueDetail drawer, modals) —
  stay outside the dock.
- Multi-OS-window Chrome-style tear-off — substituted by FloatingGroups
  (dockview v6) within one window.
- Cross-window BroadcastChannel sync — not needed; single-window.
- Plugin SDK breaking changes — `dashboardTabs` stays as a deprecated alias of
  the new `panels` field.

### A.3 Final render tree

```
<ChromeShell>                              ← stays (apps/operator/app/_components/ChromeShell.tsx)
  ├── <OperatorChatSidebar>                ← chrome, fixed left
  │     └── <HarnessSelectorChip />        ← MOVED here from .h-header
  ├── <HarnessHudOverlay />                ← chrome, fixed top (stripped down)
  ├── <DockviewReact components=…>         ← ONE root dock, replaces all middle content
  ├── <FeaturePeekPanel />                 ← overlay drawer (vaul)
  ├── <IssueDetail />                      ← overlay drawer (vaul)
  ├── <CommandPalette />                   ← overlay (Cmd+K)
  └── <Toaster />                          ← overlay
```

### A.4 Panel registry (final shape)

```ts
const PANEL_REGISTRY = {
  // Harness meta — absorbs .h-header content
  'view:harness-overview':   HarnessOverviewPanel,   // phase tabs, status, progress
                                                     // params: { slug, phase? }

  // Today's top-level "tabs" become panel types
  'view:dashboard-overview': DashboardOverviewPanel,
  'view:docs':               DocsPanel,
  'view:vscode':             VSCodePanel,            // iframe wrapper for code-server
  'view:pi-terminals':       PiTerminalsDock,        // nested dock (existing)
  'view:design':             DesignPanel,
  'view:proposals':          ProposalsPanel,

  // Today's intra-dashboard splits
  'data:features':           FeaturesPanel,
  'data:issues':             IssuesPanel,
  'data:agents':             AgentsPanel,
  'data:logs':               LogsPanel,
  'data:git':                GitGraphPanel,
  'data:chat':               ChatPanel,

  // Pinned-detail panels (right-click "Pin as panel")
  'pin:feature':             PinnedFeaturePanel,
  'pin:issue':               PinnedIssuePanel,

  // Fallback for unknown types (uninstalled plugin etc.)
  '__missing__':             MissingPanel,

  // Plugin-contributed (registered dynamically at plugin onLoad)
  // 'plugin:linear:projects': …
};
```

Every panel receives `props.api.params: { workspaceId, slug, ...specific }`.
Two `data:features` panels with different `slug` are distinct instances.

### A.5 The harness selector — explicit decision

Currently lives in `.h-header` inside `HarnessDashboard.tsx` and is bound to
the `?slug=` URL param. In a multi-panel world the global "selected slug"
loses meaning, so the selector splits into three roles:

| Purpose | Today | After |
|---|---|---|
| **Pick the default slug for new panels + agent/voice focus** | `?slug=` URL | `HarnessSelectorChip` in `OperatorChatSidebar` header. Stored in nuqs as `?focusSlug=`. |
| **Show harness-level meta** (phase tabs, alive/idle, project path, progress, todo/blocked/passed) | `.h-header` block | A `view:harness-overview` panel that takes a `slug` param. Multiple instances allowed. |
| **Switch active harness** | RSelect in `.h-header` | The chip in the chat sidebar; switching it changes default-slug for *new* panels only — does not retroactively re-target open panels. |

Two `view:harness-overview` panels with different `slug` can sit side-by-side.

### A.6 Phase state — per-panel, not global

`?phase=staging` URL state goes away. Each `view:harness-overview` panel
carries its own `params.phase` so two overviews of *the same harness* in
different phases can sit side-by-side. Implications:

- Anything that reads "current phase" today (some agent tools, some HUD
  badges) must accept a panel-resolved phase, not a URL-global phase.
- Default phase for a new panel = the harness's `current_phase` from PG.
- Agent UI dispatch (Section B.6) needs new actions to set per-panel phase.

### A.7 Default layout (recreates today's UX)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Left rail "context" (280px, full-height)                            │
│   tabs: view:harness-overview, data:git                             │
├─────────────────────────────────────────────────────────────────────┤
│ Middle "main" (flex)                                                │
│   tabs: view:dashboard-overview*, data:features, data:issues,       │
│         view:docs, view:vscode, view:pi-terminals, view:design      │
├─────────────────────────────────────────────────────────────────────┤
│ Right rail "telemetry" (320px, full-height)                         │
│   tabs: data:agents, data:logs                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### A.8 Persistence

Migration **070** (069 is taken by `system-docs-read-cap`):

```sql
CREATE TABLE harness_shared.harness_dock_layouts (
  workspace_id    text    NOT NULL,        -- text, not uuid: workspace is a slug-style id (e.g. 'default')
  user_id         text    NOT NULL,        -- text: '_local' in loopback dev, uuid string in webapp
  layout_name     text    NOT NULL DEFAULT 'default',
  schema_version  int     NOT NULL,        -- monotonic int, bumped per breaking dockview/schema change
  layout_json     jsonb   NOT NULL,
  updated_ts      bigint  NOT NULL,        -- ms; used as optimistic-concurrency etag
  created_ts      bigint  NOT NULL,
  PRIMARY KEY (workspace_id, user_id, layout_name)
);
CREATE INDEX harness_dock_layouts_user_idx ON harness_shared.harness_dock_layouts (workspace_id, user_id);
```

**URL** carries minimal pointers (nuqs):

- `?layout=default` — which named layout to load
- `?focusSlug=sheets` — default slug for new panels (replaces `?slug=`)
- `?focusPanel=panel:abc123` — currently focused panel (transient, throttled)

The layout body itself never goes in the URL (5–15 KB, mutates constantly).

`?slug=` URL param is retained as a deep-link compat hint: on first load, if
`?focusSlug` is absent but `?slug` is present, the bootstrap layout opens a
`view:harness-overview` and `data:features` pre-loaded for that slug.

### A.9 Layout schema versioning + corruption recovery

- **`schema_version`** column starts at `1`. Increment on any breaking change
  to the dockview JSON shape (e.g., the v5→v6 upgrade is `1 → 2`).
- On load, if `schema_version` doesn't match the running app's expected
  version, run an in-process migrator; if no migrator exists, log + fall back
  to the default bootstrap layout (with a toast: "Saved layout was from an
  older app version and couldn't be restored").
- On hydrate JSON-parse error, fall back to bootstrap layout + toast.
- **Hard reset shortcut**: `Shift+Esc` held for 1s wipes the active layout
  back to bootstrap (handler installed on `window`, not inside the dock, so
  it works even if the dock won't render).

### A.10 Unknown panel-type handling

When hydrating a layout, any panel whose `type` isn't in `PANEL_REGISTRY`
gets rendered as `MissingPanel`:

- Shows the original type + a "Remove" button
- If the plugin that owns that type is *loading*, show "Loading plugin…"
  with a spinner; the registry supports late registration via
  `registerPanel(type, component)` from the plugin's onLoad hook, and any
  open `MissingPanel` whose type matches hot-swaps to the real component on
  next render via a registry subscription.

### A.11 Multiple Zero subscriptions per duplicate panel

Each panel instance owns its own Zero subscription scoped to its
`params.slug`. Two `data:features` panels for the same slug *will* open two
subscriptions. Acceptable for now; Zero dedupes at the channel layer so wire
cost is one stream. If this proves heavy at 10+ duplicate panels, hoist a
slug-keyed shared subscription into a context provider (Phase-later
optimization, not blocking).

### A.12 Per-panel nuqs namespacing

Panels that want URL-backed state get a per-instance namespace:
`useQueryState(\`p_${api.id}_filter\`)`. Panel close handler deletes all
`p_<id>_*` keys. Without this, two `data:features` panels would fight over
`?filter=…`.

### A.13 Auth resolver

```ts
function getUserIdForLayouts(req: Request): string {
  // In webapp with Plan 4 auth: req.auth.userId (uuid string)
  // In loopback desktop dev: '_local'
}
```

Both write to the same table. Multi-user webapp queries filter by
`user_id = current_user_id`. Loopback dev users always see/write `_local`.

### A.14 Concurrent layout writes

Two tabs of the same user editing the same layout → last writer wins by
default. Layouts mutate often (every drag), so heavy locking is wrong. Add
optimistic concurrency as a refinement only if testing reveals lost-update
pain:

- Client passes the `etag` (previous `updated_ts`) on PUT
- Server rejects with 409 if current `updated_ts != etag`
- Client refetches and replays its diff

Ship Phase 2 with last-writer-wins. Re-evaluate after dogfooding.

---

## B. Phased delivery

8 phases. Each ships as its own PR on `main` (per the user's instruction —
no worktrees). Per-turn commits. Paperclip-pause windows are flagged.

### Phase 0 — Pre-flight (one PR, foundations only)

**Why it exists**: the v2 audit found 7 cross-cutting issues that should be
solved once, not re-solved in every later phase. Phase 0 lands those once.

**Scope**:

1. **SSR-safe dynamic import wrapper** — `app/_components/DockMount.tsx` that
   `dynamic(() => import('dockview-react'), { ssr: false })`s the dock root and
   handles `'use client'` boundary cleanly. Every later phase imports
   `DockMount`, not `DockviewReact` directly.
2. **Explicit CSS import** — `dockview-react@6` no longer auto-injects its
   stylesheet. Import `dockview-react/dist/styles/dockview.css` once from the
   client entry that first mounts `DockMount`. Theme class on the wrapper
   element only.
3. **Migration 070** + `lib/dock-layouts.ts` helper +
   `/api/dock-layouts/*` Hono endpoints (GET/PUT/DELETE). Includes
   schema_version handling and the Shift+Esc reset shortcut.
4. **PANEL_REGISTRY with late-registration support** —
   `registerPanel(type, component)` callable from plugin onLoad, plus the
   `MissingPanel` fallback (Section A.10).
5. **`getUserIdForLayouts` resolver** (Section A.13).
6. **`resize-observer-polyfill`** added to vitest setup so jsdom tests of
   dock-resident panels don't blow up.
7. **Layout JSON validator** — a single zod schema for the layout shape;
   used on both PUT (server) and hydrate (client) to fail fast on corrupt
   data.

**Does not yet replace any UI.** Pi tab still uses dockview-5 + localStorage
at end of Phase 0. Phase 0 only adds the foundations.

**Acceptance**:
- New endpoints round-trip a sample layout in a unit test
- Loading a sample layout containing a `plugin:nonexistent:foo` panel
  renders `MissingPanel` without crashing the tree
- `Shift+Esc` long-press handler triggers the reset confirm
- `vitest --run apps/operator/lib/dock-layouts.test.ts` green

**Risk**: low. All additive.

**Effort**: 1 day.

---

### Phase 1 — Upgrade pi-tab from dockview 5 → 6

**Scope**:

- Bump `dockview` and `dockview-react` from `5.2.0` → `6.2.2` (or latest at
  start time).
- Address known v5→v6 breaks:
  - CSS no longer auto-injects → already handled by Phase 0 explicit import.
  - `TabGroupColor` → `DockviewTabGroupColor` rename (search-and-replace).
  - `contain: layout` removed from core CSS — verify no layout regressions.
  - Verify `onDidLayoutChange`/`onDidAddPanel`/`onDidRemovePanel` still fire
    for the events `PiTerminalsDock.tsx` listens to.
- Migrate `PiTerminalsDock.tsx` to use the `DockMount` wrapper from Phase 0.
- Spike test: open 10 terminals, drag-split, save, reload — layout restored
  byte-identical.

**Persistence stays in localStorage in Phase 1.** Migrating pi-tab to PG is
Phase 2.

**Acceptance**:
- All existing pi-tab interactions work
- FloatingGroups: drag a terminal tab outside its group → floats within
  window, can re-dock
- v5 localStorage entries still rehydrate (handled by a one-time `1 → 2`
  schema migrator)

**Risk**: low-medium. Pi tab is isolated.

**Effort**: 1 day.

---

### Phase 2 — Migrate pi-tab persistence localStorage → PG + perf spike

**Scope**:

- Replace pi-tab's localStorage read/write with the Phase 0 endpoints.
- One-time migration: if localStorage `papercusp:pi-dock-layout:<slug>`
  exists, POST it to PG (`INSERT … ON CONFLICT DO NOTHING` to handle the
  multi-tab race), then delete the localStorage key.
- **Performance spike at end of phase**: open 10 pi terminals → measure
  per-frame cost during drag, memory footprint, Zero subscription count.
  Document numbers in this file as Section E. If numbers exceed any of
  these thresholds we replan before Phase 3:
  - Drag frame budget: 16ms (60fps)
  - 10-panel memory delta: < 80 MB
  - Per-panel mount time: < 50ms

**Acceptance**:
- Pi-tab layout survives across browser refresh, across machines (via
  tunnel), across desktop ⇄ webapp
- Migration runs idempotently
- Perf numbers documented

**Risk**: medium. First PG-backed layout. Get the contract right here.

**Effort**: 1 day.

---

### Phase 3 — Dockify the Dashboard internals (no top-level changes yet)

**Scope**: keep the top-level "Dashboard / Docs / VSCode / Pi / Design" tab
strip exactly as is. Inside the Dashboard tab, replace the
`react-resizable-panels` split with a nested DockviewReact containing:
`data:git`, `data:features`, `data:issues`, `data:agents`, `data:logs`,
`data:chat`.

- Each panel = thin wrapper around the existing inner content (no logic
  moves).
- Default layout = today's split shape, expressed as a dockview tree.
- Layout name in PG: `'dashboard-v1'` per `(workspace_id, user_id)`.
- Keep `react-resizable-panels` as a dependency (still used elsewhere, e.g.
  ProposalsPanel). Drop it only after the last consumer migrates (separate
  cleanup PR after Phase 6).

**Paperclip pause window required**: this PR touches `app/harness/*` heavily.
Coordinate with user to ensure paperclip is paused during the merge.

**Acceptance**:
- All 6 dashboard panels render
- Drag any panel to a new position; reload restores
- FeaturePeekPanel drawer still opens on row click (overlay, outside dock)
- IssueDetail drawer still opens on row click
- Existing keyboard shortcuts still work
- No regressions in feature/issue/git interaction flows
- e2e: layout-persistence test passes

**Risk**: medium-high (most-trafficked screen). Interaction regressions, not
layout, are the threat.

**Effort**: 1.5 days.

---

### Phase 4 — `view:harness-overview` panel + selector relocation

**Scope**:

- Build `HarnessOverviewPanel`: renders phase tabs (per-panel param, not
  URL), alive/idle status chip, project path, progress %, todo/blocked/
  passed counts. Takes `params: { slug, phase? }`.
- Build `HarnessSelectorChip`: combobox of harnesses for current workspace,
  reads/writes `?focusSlug=` via nuqs. Lives in `OperatorChatSidebar`
  header.
- Remove the `.h-header` block from `HarnessDashboard.tsx`.
- Default dashboard layout updated to include `view:harness-overview` pinned
  to the left rail.
- Deep-link compat: `/harness/sheets` (or `?slug=sheets`) on first load
  opens a default layout containing `view:harness-overview` pre-loaded for
  `sheets`. `?slug=` retained.
- Agent UI dispatch: add `setFocusSlug(slug)` action. Agent voice/text
  "summarize state" replies use `focusSlug` for context resolution.

**Chat sidebar header space audit** (the header is currently 63px tall with
286px control row: Active 70px + Voice 178px + Settings 28px). Adding a
~120px selector chip exceeds budget. Two viable layouts; pick one in
greenlight review:

- **Option A (preferred)**: shrink Active to 50px and Voice to 130px,
  selector chip 100px. Total 50+130+28+100 = 308px → grows row width or
  drops chip to a second sub-row.
- **Option B**: keep controls as-is, selector chip goes on a 2nd 24px sub-
  row below the controls. Header grows to ~90px.

Decision goes in Section C.

**Acceptance**:
- `/harness/sheets` shows default layout with overview pre-loaded
- Chip in chat sidebar reflects current focusSlug
- Switching chip → new panels default to new slug; open panels unchanged
- Open second `view:harness-overview` for a different slug → both render
  side-by-side
- Voice mode "summarize state" uses focusSlug

**Risk**: medium. Semantic shift; user education needed.

**Effort**: 1.5 days.

---

### Phase 5 — Collapse top-level tabs into the root dock

**Scope**:

- One root `<DockviewReact>` replaces the entire `ChromeShell` content area.
- Default layout ≈ Section A.7.
- Former top-level tabs (Dashboard/Docs/VSCode/Pi/Design) become first-class
  panels openable via the catalog button, command palette, or default
  layout.
- `ReactActivity`-based tab switching removed.
- `?panel=` URL param preserved as a first-load focus hint.
- `PiTerminalsDock` becomes nested inside `view:pi-terminals`. **Drag-out
  of a nested dock to the outer dock is not supported by dockview v6 out
  of the box**; document this limitation. Users wanting a terminal at top
  level can open a new pi-terminals panel.
- Agent UI dispatch: add `openPanel({ type, params, group? })`,
  `closePanel(id)`, `focusPanel(id)`, `setPanelPhase(id, phase)`. These are
  hard requirements (not deferrable to Phase 6) because removing the
  top-level tab strip removes agents' current way to navigate.

**Paperclip pause window required** (largest harness/* surface change).

**Acceptance**:
- All previously-top-level views reachable via catalog + command palette
- Drag Docs next to Features in one group
- Multiple harness overview panels with different slugs
- FloatingGroup: drag panel out → floats, re-dockable
- Layout reloads across sessions
- Agents can openPanel / focusPanel / setPanelPhase

**Risk**: medium. Largest visible UX change.

**Effort**: 2 days.

---

### Phase 6 — Plugin contract + "Pin as panel" actions

**Scope**:

- Plugin manifest gets optional `panels: PluginPanel[]`. `dashboardTabs`
  deprecated alias (dev-warn, still works).
- Plugin host wires panels into `PANEL_REGISTRY` via `registerPanel` at
  onLoad time.
- New panel types `pin:feature` and `pin:issue`: read-only detail view of
  a specific entity, refreshed via Zero subscription.
- Right-click on a feature/issue row → context menu → "Pin as panel"
  creates the appropriate pinned panel.
- Catalog: a right-click on empty group + "Add panel" submenu lists all
  registered types. Cmd+K command palette gains "Open: <Panel Type>"
  commands.

**Acceptance**:
- Linear-sync plugin's panels appear in the catalog
- Right-click "Pin as panel" on F-FIND-002 opens a permanent detail panel
- Multiple pinned features open simultaneously
- Pinned panels survive layout reload
- Uninstalling a plugin while its panels are open: panels swap to
  `MissingPanel` cleanly

**Risk**: low. Additive.

**Effort**: 1 day.

---

### Phase 7 — Mobile fallback + dead-code sweep (post-greenlight optional)

**Scope**:

- Below `768px` viewport, render a single-panel mode (active panel only,
  switchable via a bottom drawer) instead of the full dock.
- Remove `react-resizable-panels` from any remaining call sites that have
  been migrated (audit + delete).
- Remove `ReactActivity`-based tab switching dead code.
- Update CLAUDE.md / memory notes with "Almost all layouts in PG"
  companion rule to the existing nuqs rule.

**Acceptance**:
- iPad-sized viewport renders without horizontal scroll
- `rg react-resizable-panels apps/operator/` returns only intended call
  sites
- No `ReactActivity` orphans

**Risk**: low.

**Effort**: 0.5 days.

---

### Effort summary

| Phase | Effort |
|---|---|
| 0 — Foundations | 1.0 d |
| 1 — Pi-tab dockview 6 | 1.0 d |
| 2 — Pi-tab PG persistence + perf spike | 1.0 d |
| 3 — Dockify dashboard internals | 1.5 d |
| 4 — Overview panel + selector relocate | 1.5 d |
| 5 — Root-dock collapse + agent dispatch | 2.0 d |
| 6 — Plugin panels + pin actions | 1.0 d |
| 7 — Mobile + cleanup | 0.5 d |
| **Total** | **9.5 days** |

Phases 0–2 are minimum-viable risk validation. Phase 3 delivers the
biggest *visible* value. Phases 4–6 are the full vision. Phase 7 is
cleanup.

---

## C. Open decisions (gate greenlight)

The user must resolve each before implementation starts. Defaults shown.

1. **Selector chip placement in chat sidebar** (Section B.4): Option A
   (shrink existing controls, single row) vs Option B (add a 24px sub-row).
   **Default: B** (less disruptive to existing controls).

2. **`view:harness-overview` multiple-instances-same-slug**: allow two
   overviews of the *same* harness in different phases? **Default: yes**
   (lets users compare staging vs production side-by-side; phase is
   per-panel param).

3. **Default layout content** (Section A.7): Git left + Dashboard middle +
   telemetry right vs Features+Issues left + overview middle + telemetry
   right. **Default: Section A.7 as drafted.**

4. **Nested-dock drag-out** (Phase 5): accept that you cannot drag a
   terminal out of the pi-terminals panel to the root dock, vs. invest in
   the dockview-v6 workaround (custom drag handler). **Default: accept the
   limitation, document it.**

5. **`dashboardTabs` deprecation timing**: warn forever vs hard-remove
   after Phase 6 + 1 week. **Default: warn forever** (pre-alpha or not,
   it's a tiny alias).

6. **Phase ordering**: Phase 4 (selector relocate) before Phase 3 (dockify
   internals) vs current order. **Default: current order** — validate
   dockview at scale (Phase 3) before semantic shift (Phase 4).

7. **Layout sharing across users**: future scope or never? **Default:
   never** (layouts are personal; "share my layout" can be a
   copy-as-JSON action if ever needed).

8. **Optimistic concurrency for layout writes** (Section A.14): include in
   Phase 0 vs add later if needed. **Default: add later.**

9. **e2e test coverage threshold**: how many of the layout-persistence,
   floating-group, multi-instance flows need e2e (vs unit) coverage before
   greenlight on Phase 5? **Default: 3 e2e specs**:
   `dock-layout-persists-across-reload.spec.ts`,
   `multi-harness-side-by-side.spec.ts`, `floating-group-redock.spec.ts`.

10. **Agent dispatch surface for panels**: should `openPanel` accept a
    free-form `params` JSON object, or only known param shapes per panel
    type (validated against a registry of schemas)? **Default: validated
    against schemas** (safer for agent-driven layouts).

---

## D. Notes for the implementer

These are working constraints, not aesthetic preferences.

- **Per-turn commits**: every phase PR commits + pushes at the end of every
  agent turn (per memory `feedback_per_turn_commit`).
- **Paperclip discipline**: before editing `app/harness/*` files, run
  `pgrep -af paperclip`. If active, coordinate a pause window with the
  user. Phases 3 and 5 carry the highest stomp risk.
- **`mcp__pi__edit` over regex**: per memory `feedback_no_regex_for_func_args`,
  do not use regex for any function-argument list edits. Greedy `[^)]*`
  swallows nested parens.
- **Don't delete TS code** in `apps/operator/` or `libs/papercusp/` per
  memory `feedback_no_ts_deletion`. The Rust port is parallel.
- **No FS mirrors**: per memory `feedback_pg_canonical_no_mirrors`, the
  layout is canonical in PG; never dual-write to disk.
- **DB is not a transport**: per memory `feedback_db_not_a_transport`,
  cross-tab layout sync is not "poll PG for changes" — it's a Zero
  subscription on `harness_dock_layouts`, or last-writer-wins with no
  sync (initial default).
- **Submodule discipline**: `libs/papercusp` is a submodule. The migration
  file lives there; the operator code lives in the outer `papercup` repo.
  Both commits + a submodule pointer bump in the outer repo.
- **Pre-alpha**: per memory `feedback_pre_alpha_freedom`, no deprecation
  aliases beyond `dashboardTabs` (which exists for plugin-author UX, not
  backwards-compat dogma). Don't preserve `?phase=` URL state.
- **Verify before claiming done**: every phase's acceptance criteria must
  be live-verified in the running operator, not just typecheck-passed.

---

## E. Performance numbers (filled in after Phase 2)

To be filled in at end of Phase 2:

- Drag frame budget (target 16ms): TBD
- 10-panel memory delta (target < 80MB): TBD
- Per-panel mount time (target < 50ms): TBD
- Zero subscription count per panel: TBD

If any threshold breached, replan before starting Phase 3.

---

## F. Change log

- **2026-05-13 v3 (this revision)**: consolidated v1 plan + v2 audit into
  one document. Corrected migration number to 070. Corrected column types
  to `text` (workspace_id and user_id, not uuid). Added explicit v5→v6
  dockview breaking-change handling. Specified `ChromeShell.tsx` as the
  dock-root host (not invented "HarnessShell"). Resolved per-panel phase
  state explicitly. Specified the chat-sidebar space budget and two layout
  options. Hard-required agent dispatch in Phase 5 (not deferrable to 6).
  Added Section E perf-numbers placeholder. Numbered open decisions for
  greenlight.
- 2026-05-13 v2: appended audit section to v1.
- 2026-05-13 v1: original 6-phase plan.
