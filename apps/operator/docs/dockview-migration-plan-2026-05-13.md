# Dockview migration plan + audit (2026-05-13)

Status: **proposal — awaiting greenlight**. No code shipped.

This doc combines:
- §A The plan (sections 1–9, as previously discussed)
- §B Audit findings — gaps, oversights, and additions discovered on a thorough re-read
- §C Revised phase list incorporating §B
- §D Open decisions for the user

---

## §A The plan (as originally proposed)

### 1. Goal

Make the entire operator harness UI feel like the pi tab: every long-lived view is a draggable panel; users freely arrange/split/float them; layouts persist per-user across machines. Eliminate the inconsistency between the pi tab's drag-and-drop docking and the rest of the dashboard's fixed-split layout.

### 2. Non-goals

- Replacing **app chrome** (operator chat sidebar, top HUD bar, command palette, toasts).
- Replacing **transient overlays** (FeaturePeekPanel drawer, IssueDetail drawer, modals).
- Multi-OS-window Chrome-style tab tear-off. FloatingGroup (single-process floating panel) is the substitute.
- Cross-window sync (BroadcastChannel). Not needed; staying single-window.
- Plugin SDK breaking changes. `dashboardTabs` gets a backwards-compatible superset.

### 3. The harness selector — unbundling

Today the harness selector lives in `.h-header` and is scoped to `?slug=`. After migration the three purposes it serves are unbundled:

| Purpose | Today | After |
|---|---|---|
| Drive the operator's default harness context (default slug for new panels, agent context, voice replies) | `?slug=` URL param | A small selector in the **operator chat sidebar header**. nuqs-backed. |
| Show harness-level meta (phase tabs, alive/idle, project path, progress, todo/blocked/passed) | `.h-header` block | A new dock panel type `view:harness-overview` taking a `slug` param. Default layout opens one. Users may open multiple, one per harness. |
| Switch which harness is "active" | RSelect dropdown | Same dropdown, in the chat sidebar header. Changes default slug for new panels; does not retroactively change open panels. |

`?slug=sheets` continues to deep-link into a default layout containing an overview panel pre-loaded for `sheets`.

### 4. Final architecture

```
<HarnessShell>                                     ← stays
  ├── <OperatorChatSidebar>                        ← chrome, fixed left
  │     └── <HarnessSelectorChip />                ← MOVED HERE; drives default slug
  ├── <HarnessHudOverlay />                        ← chrome, fixed top (stripped: no selector)
  ├── <DockviewReact components={PANEL_REGISTRY}   ← ONE root dock
  │       onReady={hydrateFromPG} />               
  ├── <FeaturePeekPanel /> <IssueDetail />         ← stay as overlay drawers
  ├── <CommandPalette />                           ← stays as overlay
  └── <Toaster />                                  ← stays as overlay
```

### 4.1 PANEL_REGISTRY

```ts
const PANEL_REGISTRY = {
  'view:harness-overview':   HarnessOverviewPanel,   // phase tabs + status + meta
  'view:dashboard-overview': DashboardOverviewPanel,
  'view:docs':               DocsPanel,
  'view:vscode':             VSCodePanel,
  'view:pi-terminals':       PiTerminalsDock,
  'view:design':             DesignPanel,
  'view:proposals':          ProposalsPanel,
  'data:features':           FeaturesPanel,
  'data:issues':             IssuesPanel,
  'data:agents':             AgentsPanel,
  'data:logs':               LogsPanel,
  'data:git':                GitGraphPanel,
  'data:chat':               ChatPanel,
  'pin:feature':             PinnedFeaturePanel,
  'pin:issue':               PinnedIssuePanel,
  'plugin:*':                PluginPanelRouter,
};
```

Each panel receives `props.api.params: { workspaceId, harnessSlug, ...specific }`. Two panels of the same type with different `harnessSlug` are distinct instances.

### 4.2 Default layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Group "context"  (left rail, 280px, full-height)                     │
│   tabs: data:git, view:harness-overview                              │
├──────────────────────────────────────────────────────────────────────┤
│ Group "main"  (flex, fills middle)                                   │
│   tabs: view:dashboard-overview*, data:features, data:issues,        │
│         view:docs, view:vscode, view:pi-terminals, view:design       │
├──────────────────────────────────────────────────────────────────────┤
│ Group "telemetry"  (right rail, 320px, full-height)                  │
│   tabs: data:agents, data:logs                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.3 Persistence (migration 067)

```sql
CREATE TABLE harness_shared.harness_dock_layouts (
  workspace_id   uuid    NOT NULL,
  user_id        uuid    NOT NULL,
  layout_name    text    NOT NULL DEFAULT 'default',
  layout_json    jsonb   NOT NULL,
  schema_version int     NOT NULL DEFAULT 1,
  created_ts     bigint  NOT NULL,
  updated_ts     bigint  NOT NULL,
  PRIMARY KEY (workspace_id, user_id, layout_name)
);
```

URL carries: `?layout=default` and (throttled) `?focus=panel:abc123`. No layout body in URL.

### 4.4 Plugin contract extension

```json
{
  "id": "linear-sync",
  "panels": [
    { "id": "linear:projects", "title": "Linear Projects", "iframeUrl": "/p/linear/projects" }
  ]
}
```

`dashboardTabs` continues to work as deprecated alias.

### 5. Phased delivery (initial proposal — see §C for revision)

- Phase 1: Upgrade pi-tab to dockview 6.2.2
- Phase 2: Migrate pi-tab persistence localStorage → PG
- Phase 3: Replace HarnessDashboard's `react-resizable-panels` with nested DockviewReact
- Phase 4: Add `view:harness-overview` + move selector to chat sidebar
- Phase 5: Collapse top-level tab strip into root dock
- Phase 6: Plugin contract + "Pin as panel" actions

### 6. Testing strategy

- Unit tests for `dock-layouts.ts` helper
- Existing e2e tests should still pass without modification (target inner content, not chrome)
- Manual smoke per phase

### 7. Rollback

Per-phase PRs. Migration 067 is additive. localStorage → PG migration in Phase 2 is one-time read; no data deletion.

### 8. Open questions (original)

1. Is the harness-selector unbundling (§3) correct?
2. Should `view:harness-overview` be openable multiple times for the same slug?
3. Default layout content shape — Git-left / dashboard-middle / telemetry-right?
4. Are nested docks (pi-terminals as dock-within-a-dock) OK?
5. Plugin `dashboardTabs` migration deadline — warn or break?
6. Phase ordering: Phase 4 before Phase 3?

### 9. Total effort estimate

~5 days, 6 PRs. §C updates this.

---

## §B Audit findings — gaps, oversights, risks

Re-reading §A from scratch against the actual codebase. Findings grouped by severity.

### B.1 Critical gaps (must address before phase 1)

**B.1.1 — dockview-react SSR compatibility.**
`DockviewReact` touches `window`, `document`, and uses ResizeObserver internally. Next.js App Router will SSR the page by default. The pi tab already lives behind a client-only boundary, but `HarnessDashboard.tsx` is mixed (server + client). Phases 3–5 will hit hydration mismatches and "ReferenceError: window is not defined" if dockview is imported at module scope in a server-component path.

**Mitigation**: every dockview component module begins with `'use client'`. The shell at phase 5 (root dock) needs a `dynamic(() => import('./RootDock'), { ssr: false })` wrapper. Add this to the plan explicitly.

**B.1.2 — Layout JSON schema versioning.**
Original plan stored raw `layout_json` with no version field. dockview's own JSON shape is versioned by them. If dockview ever changes its schema (v6 → v7), every existing layout in PG silently corrupts. Already added `schema_version` column in §A.4.3 revision. Need: a hydrate function that detects unknown `schema_version` and falls back to default layout + logs warning. Need: layout fixture/snapshot tests that catch dockview schema changes during upgrade.

**B.1.3 — Layout corruption recovery / hard-reset.**
If a layout JSON is malformed (race-condition write from two tabs, or schema drift), the dock can render blank — and the user has no UI to recover because the controls are inside the dock. Need: a non-dock-resident keypress (e.g. **Shift+Esc held 1 second**) that invokes `resetLayout(layoutName)` and rehydrates from defaults. Surface "Reset layout" in the command palette too.

**B.1.4 — Unknown panel type handling.**
If a saved layout references `plugin:linear:projects` and that plugin is now uninstalled, dockview throws when trying to render. Need: PANEL_REGISTRY proxy that, for unknown types, returns a `MissingPanel` component showing "This panel's plugin is not installed. [Remove from layout]". Without this, a single missing plugin breaks the whole dock.

**B.1.5 — Multiple Zero subscriptions per duplicate panel.**
Today there's one `useQuery(features)` per page. With multiple `data:features` panels open for the same slug, each calls its own `useQuery`. Zero dedupes subscriptions at the client level, but the React-side overhead (re-render on each update × N panels) and the agent UI dispatch state (one nuqs key per "selected feature") will collide.

**Mitigation**: each panel keeps an `instanceId` (dockview gives this). Per-panel state (selection, scroll, filter) is namespaced in nuqs under `panel:<instanceId>.*`. Validate this scales to 10+ panels before phase 5.

**B.1.6 — Auth `user_id` source.**
Layout PK is `(workspace_id, user_id, layout_name)`. The operator runs loopback-only with no per-user auth in dev. Need to decide:
- Single-user mode (today): `user_id = workspace_id` or `'_local'` placeholder
- Phase 4 (Plan 4 user accounts landed in migration 058): use the authenticated user
- Webapp/mobile: real auth user id

Spec the resolver: `getUserIdForLayouts(req)` returning a canonical UUID for whichever auth mode is active.

**B.1.7 — paperclip + harness file edits.**
`paperclipai run` rewrites files under `apps/web/app/harness/*` and `apps/operator/app/harness/*`. Per `memory://root/MEMORY.md` (`feedback_paperclip_collision_race.md`), every file in `app/harness/` is a stomp candidate. Phases 3–5 edit `HarnessDashboard.tsx` and shell files extensively.

**Mitigation**:
- `pgrep -af paperclip` at the start of every editing session for this migration
- User explicitly pauses paperclip for the duration of phase 3 and phase 5 (largest edits)
- Per-turn commits per `feedback_per_turn_commit.md`

### B.2 High-severity gaps

**B.2.1 — `react-resizable-panels` is used in many more places than HarnessDashboard.**
Plan §5 phase 3 says "remove react-resizable-panels from HarnessDashboard, leave dependency for others." Need to enumerate the others to scope a phase 3.5 (or phase 7) for them:

Per quick grep, `react-resizable-panels` is also used by:
- `ProposalsPanel.tsx` (internal split)
- `IssueDetail.tsx` (drawer internals)
- `apps/web/app/.../` shared harness pages

Decide: do `ProposalsPanel`/`IssueDetail` internals become dock-within-dock (likely no, they're overlays), or keep their own `react-resizable-panels` indefinitely (yes, cheap and consistent)?

**B.2.2 — Drawer overlap with dock floating groups.**
FeaturePeekPanel and IssueDetail are vaul Drawers that overlay the right side. dockview FloatingGroup also positions absolutely. Z-index ordering and click-through behavior between an open drawer and a floating dock group is not defined.

**Mitigation**: explicit z-index scale in `harness.css`:
- 100–199: dockview floating groups
- 200–299: vaul drawers
- 300+: modals, command palette, toasts

Verify by smoke test in phase 3.

**B.2.3 — `papercusp-app` div wrapping for paperclip injection.**
Per recent commit `601dcc11 fix(operator): wrap layout body in <div id='papercusp-app'>`, the layout body needs that wrapper. Confirm the dock root sits *inside* `#papercusp-app`. Easy miss.

**B.2.4 — Keyboard shortcuts: global vs panel-local scope.**
Today there's no clear scoping; some shortcuts (Cmd+K palette) bind on `window`, some (xterm copy) bind on the focused panel. With many panels, "Cmd+W close current panel" needs to know which panel has focus. dockview exposes `activeGroup` and `activePanel` but the keyboard handler still binds to `window`.

**Mitigation**: introduce a `useFocusedPanel()` hook reading dockview's `onDidActiveGroupChange`. Document the scoping rules in this doc before phase 5.

**B.2.5 — Phase tabs inside `view:harness-overview`: per-panel state or global?**
A user opens two `view:harness-overview` panels for the same slug — one showing "Phase: production" and one "Phase: staging". Currently phase is global URL state. To support this, phase becomes per-panel-instance state.

**Decision needed**: confirm we want this. If yes, all phase-related agent UI dispatch lookups need to receive the instance id. Significant.

**B.2.6 — `papercup-db` and `papergrid` are untracked dirs.**
`git status` shows `libs/papercup-db/` and `libs/papergrid/` as untracked. These may contain another agent's in-progress work. Editing in their vicinity is unsafe. Confirm before phase 3.

**B.2.7 — VSCode and code-server iframes during drag.**
Iframes don't survive being re-parented in the DOM. When a panel containing an iframe is dragged between groups, browsers reload the iframe — losing terminal state, editor scroll, unsaved buffers. This is a known dockview limitation.

**Mitigation**:
- Detached portal pattern: iframe lives in a fixed-position container outside dockview; the panel just positions an absolutely-positioned div over the panel's bounding rect. The pi-tab already does this for xterm — extend the same pattern to `view:vscode` and any other iframe-hosting panel.
- Document the pattern in a `apps/operator/docs/dockview-iframe-pattern.md` companion.
- Test: drag VSCode panel between groups → editor scroll and unsaved buffer preserved.

**B.2.8 — Brainstorm canvas full-screen mode.**
The brainstorm view today is a full-screen takeover. In a dock world it's awkward. Options:
- Stays as a route-level overlay (outside the dock) → simplest, matches existing UX
- Becomes a panel that defaults to a maximize-group state → more flexible but conflicts with the "drawing canvas needs the full viewport" use case

**Decision needed**.

### B.3 Medium-severity gaps

**B.3.1 — Workspace switch invalidation.**
Layouts are keyed by `workspace_id`. When the user switches workspace, the dock should hydrate the new workspace's layout. Need explicit `onWorkspaceChange` → tear down + rehydrate flow. Without it, the old layout lingers and points at stale slugs.

**B.3.2 — Floating group position clamping.**
A floating group at `{x: 1900, y: 1100}` on a 4K monitor positions off-screen when the user moves to a 1440p monitor. On hydrate, clamp `{x, y}` to current viewport.

**B.3.3 — HUD content audit.**
Plan §A.4 says "strip HUD: no longer hosts selector." Need explicit list of what the HUD currently shows and where each item goes:
- Mission state pill → stays in HUD
- Build status pill → stays in HUD
- Voice indicator → stays in HUD
- (any others?) — enumerate before phase 4

**B.3.4 — Voice mode "summarize state".**
Voice commands today reference the global `?slug=`. In a dock world with multiple harnesses visible, "summarize state" needs to disambiguate. Use the chat-sidebar selector value (= active default slug) as the disambiguator. Document explicitly.

**B.3.5 — Agent UI dispatch (`ui:get_state`, `ui:dispatch`) compatibility.**
The agent contract reads/writes URL state. After phase 5, much state moves to PG (layout) and per-panel nuqs keys. The agent contract needs:
- A new `ui:list_panels` action returning all open panels and their params
- `ui:open_panel(type, params)` and `ui:close_panel(instanceId)` actions
- Per-panel state remains via existing `ui:dispatch` with panel-namespaced keys

This is a separate plan item. Phase 6 or 7. Without it, the agent loses the ability to navigate post-migration.

**B.3.6 — Drizzle schema regeneration.**
Migration 067 adds a table. The Drizzle TS schema (`generated.ts`) needs regeneration. Add to phase 2 checklist.

**B.3.7 — dockview-react peer dep + Next 15 / React 19.**
Verify dockview 6.2.2 lists React 19 in peer deps. v5.2.0 only declared 18.x. If not, pin to a compatible point release or add a `.npmrc` `legacy-peer-deps`. Verify in phase 1.

**B.3.8 — HMR + dockview state.**
During development, HMR re-mounts components. The pi tab handles this via the `restored` flag. Verify the same pattern works for the root dock. Test: edit `FeaturesPanel.tsx`, save, confirm layout doesn't reset.

**B.3.9 — Jsdom test compatibility.**
ResizeObserver is not in jsdom by default. dockview tests will fail unless polyfilled. Add `resize-observer-polyfill` to `vitest.setup.ts`.

**B.3.10 — Concurrent layout writes from two tabs.**
User opens operator in two browser tabs (or desktop + webapp). Both write to `harness_dock_layouts` for the same `(workspace_id, user_id, 'default')`. Last writer wins. Acceptable but document.

**Mitigation (optional)**: PG row-level lock via `SELECT … FOR UPDATE` in the save endpoint. Probably overkill — last-writer-wins is fine for layout.

**B.3.11 — Command palette discoverability.**
Today the command palette doesn't index panels (there's nothing to index). Add a `Panel.openCatalog()` action and a per-panel-type "Open: Features (sheets)" command. Phase 6 deliverable.

**B.3.12 — Browser back-button after phase 5.**
After phase 5, route is fixed (`/harness`) and layout changes are not navigations. Back-button does nothing useful. This matches the pi tab behavior today — acceptable. Document.

### B.4 Low-severity / nice-to-have

- **B.4.1** Telemetry: emit `panel_open`/`panel_close` events with panel type to understand usage
- **B.4.2** Empty group cleanup: dissolve groups with zero panels (dockview default) vs preserve as "favorite slot" — pick dissolve
- **B.4.3** Mobile responsiveness: dockview doesn't fit mobile. Below 768px, fall back to a flat tab strip. Phase 7+.
- **B.4.4** Accessibility: dockview tab focus order and ARIA roles need verification. Most LIFs handle this; double-check in phase 1.
- **B.4.5** RTL: dockview handles RTL via CSS direction. Verify if relevant.
- **B.4.6** Layout sharing: "share my layout" → export JSON, import on another user. Phase 7+.
- **B.4.7** Default layout shipped with the app vs computed at runtime: ship a static JSON in `apps/operator/lib/default-layouts/` for determinism.
- **B.4.8** Changelog entry: this changes how users think about layouts. Add a note to release notes when phase 5 ships.

### B.5 Things the original plan got right

- Three-purpose unbundling of the selector (§3) is the central design call and it's correct
- PG canonical persistence (`feedback_pg_canonical_no_mirrors.md`)
- Phased delivery with revertable per-phase PRs
- Keeping drawers/modals outside the dock
- FloatingGroup as the cheap alternative to multi-window

---

## §C Revised phase list

Each phase is a single PR with explicit acceptance criteria. Inline references to §B audit items.

### Phase 0 — Pre-flight (new, was implicit)

**Scope**: groundwork that doesn't touch the dock yet.

**Changes**:
- Add `resize-observer-polyfill` to `vitest.setup.ts` (B.3.9)
- Decide `getUserIdForLayouts(req)` resolver shape (B.1.6)
- Enumerate HUD content audit (B.3.3) and other `react-resizable-panels` callsites (B.2.1)
- Confirm dockview 6.2.2 peer deps against React 19 / Next 15 (B.3.7)
- Document iframe portal pattern at `apps/operator/docs/dockview-iframe-pattern.md` (B.2.7)
- Add a z-index scale section to `apps/operator/app/harness/harness.css` (B.2.2)

**Acceptance**: doc deliverables exist; one-line POC importing `dockview-react@6.2.2` in a sandbox page renders without errors.

**Effort**: half day.

### Phase 1 — Upgrade pi-tab to dockview 6.2.2

**Scope** (unchanged):
- bump dockview 5.2.0 → 6.2.2
- fix any 5→6 API breaks in `PiTerminalsDock.tsx`
- verify existing pi terminal layouts in localStorage still rehydrate
- verify FloatingGroup works (drag a terminal tab outside → floating)

**Audit additions**:
- HMR test (B.3.8): edit a terminal component, ensure layout persists
- Iframe portal pattern applied to xterm if not already (already is per current code)
- A11y smoke (B.4.4)

**Effort**: half a day.

### Phase 2 — Migrate pi-tab persistence localStorage → PG

**Scope** (unchanged):
- Migration 067 (with `schema_version` column per B.1.2)
- `apps/operator/lib/dock-layouts.ts` helper
- API endpoints under `/api/dock-layouts/*`
- Switch `PiTerminalsDock` from localStorage to PG
- One-time localStorage → PG read on first load

**Audit additions**:
- Drizzle schema regeneration (B.3.6)
- Hard-reset shortcut wiring (B.1.3)
- Unknown layout `schema_version` fallback (B.1.2)
- Workspace switch teardown/rehydrate (B.3.1)
- `getUserIdForLayouts` resolver wired (B.1.6)

**Effort**: 1 day (was half).

### Phase 3 — Replace HarnessDashboard's `react-resizable-panels` with nested DockviewReact

**Scope** (unchanged):
- New `DashboardDock` wrapping `<DockviewReact>` with: `data:git`, `data:features`, `data:issues`, `data:agents`, `data:logs`, `data:chat`
- Each panel = thin wrapper around existing inner content
- Layout name `'dashboard'`
- Default dashboard layout matching today's shape
- Remove `react-resizable-panels` from `HarnessDashboard.tsx` only

**Audit additions**:
- Drawer z-index verification (B.2.2)
- `MissingPanel` fallback wired into PANEL_REGISTRY (B.1.4)
- Per-panel nuqs namespacing (B.1.5)
- Verify `#papercusp-app` wrapper survives (B.2.3)
- Iframe portal pattern applied to any iframe panels added in this phase
- e2e: confirm FeaturePeekPanel drawer still opens on feature row click
- e2e: confirm previous-session drawer-open-immediate fix still works

**Risk**: medium-high. Touches most-trafficked screen.

**Effort**: 1.5 days (was 1).

### Phase 4 — Add `view:harness-overview` panel + move selector to chat sidebar

**Scope** (unchanged):
- New `HarnessOverviewPanel` rendering phase tabs, status chip, project path, progress, counts
- `HarnessSelectorChip` in `OperatorChatSidebar` header, nuqs-backed
- Remove `.h-header` block from `HarnessDashboard.tsx`
- Default dashboard layout includes one `view:harness-overview` pinned to left rail
- `?slug=sheets` deep-link hydrates default layout with that slug

**Audit additions**:
- Decide phase-state scoping (B.2.5) — per-panel-instance vs global
- Voice "summarize state" updated to use selector value (B.3.4)
- Multiple-overview-of-same-slug allowed (open question §A.8.2 — recommend **yes**)

**Effort**: 1 day.

### Phase 5 — Collapse top-level tab strip into root dock

**Scope** (unchanged):
- One root `<DockviewReact>` replaces `HarnessShell` content area
- Default layout per §A.4.2
- `view:dashboard-overview`, `view:docs`, `view:vscode`, `view:pi-terminals`, `view:design`, `view:proposals` become panels
- `ReactActivity`-based switching removed
- `?panel=` URL param preserved as initial focus hint
- `PiTerminalsDock` becomes nested inside `view:pi-terminals`

**Audit additions**:
- Dynamic import w/ `ssr: false` wrapper (B.1.1)
- Hard-reset keypress active globally (B.1.3)
- Floating-group position clamping on hydrate (B.3.2)
- HUD content audit completed; remaining HUD items survive (B.3.3)
- Brainstorm canvas decision applied (B.2.8)
- Nested-dock drag boundary smoke test (§A.8.4)

**Risk**: medium. Largest visible UX change.

**Effort**: 2 days (was 1.5–2).

### Phase 6 — Plugin contract + "Pin as panel" actions

**Scope** (unchanged):
- Plugin manifest `panels: PluginPanel[]` (with `dashboardTabs` deprecated alias)
- Dynamic PANEL_REGISTRY registration for plugin panels
- `pin:feature`, `pin:issue` panel types
- Right-click → "Pin as panel" on feature/issue rows

**Audit additions**:
- Command palette indexing of panels (B.3.11)
- `ui:list_panels`, `ui:open_panel`, `ui:close_panel` agent actions (B.3.5)
- Telemetry events (B.4.1)
- MissingPanel handling validated with an uninstall-plugin scenario (B.1.4)

**Effort**: 1.5 days (was 0.5).

### Phase 7 — Deferred items (new)

- Mobile responsiveness fallback (B.4.3)
- Layout share/export/import (B.4.6)
- ProposalsPanel/IssueDetail internal `react-resizable-panels` migration if desired (B.2.1)
- A11y polish (B.4.4)

Not part of the v1 ship. Track in `apps/operator/docs/dockview-followups.md`.

---

## §D Open decisions for user review

Before greenlight, please confirm or decide:

1. **Selector unbundling (§A.3)** — confirm the three-purpose split is correct.
2. **Multi-instance harness-overview** — recommend yes, two overview panels for the same slug allowed. Confirm.
3. **Default layout content** — recommend Section 4.2 shape (Git+Overview left, dashboard middle, Agents+Logs right). Confirm or specify alternative.
4. **Brainstorm canvas (B.2.8)** — option A: stays as full-screen route overlay (recommend). Option B: becomes a panel that maximizes its group.
5. **Phase-state scoping (B.2.5)** — recommend per-panel-instance (each `view:harness-overview` carries its own phase). Confirm.
6. **Plugin `dashboardTabs` migration deadline** — recommend warn indefinitely (pre-alpha freedom; remove when no plugins use it). Confirm.
7. **`react-resizable-panels` elsewhere (B.2.1)** — recommend leave `ProposalsPanel`/`IssueDetail` alone. They're cheap split UIs internal to overlays. Confirm.
8. **`getUserIdForLayouts` resolver (B.1.6)** — current dev mode: `'_local'` placeholder. Webapp/Phase-4-auth: real user id. Confirm.
9. **Phase ordering** — keep current order (1→6)? Or swap 3 and 4 (do selector first)?
10. **HUD content audit (B.3.3)** — list final post-strip HUD items.

---

## §E Total revised effort

| Phase | Effort | Risk |
|---|---|---|
| 0 — pre-flight | 0.5d | low |
| 1 — pi-tab dockview 6 | 0.5d | low |
| 2 — pi-tab → PG | 1.0d | medium |
| 3 — dashboard nested dock | 1.5d | medium-high |
| 4 — overview panel + selector move | 1.0d | medium |
| 5 — root dock | 2.0d | medium |
| 6 — plugins + pin | 1.5d | low |
| **Total v1** | **8.0d** | |
| 7 — deferred polish | variable | low |

Original estimate was 5 days. Revised is 8 days because phase 0 and audit additions to each phase add ~3 days of correctness work. Still doable; just sets honest expectations.

---

## §F Notes for the implementer (me, when greenlit)

- Work on `main` directly per user instruction. User pauses paperclip before phase 3 and phase 5.
- Per-turn commits per `feedback_per_turn_commit.md`.
- `pgrep -af paperclip` before every editing session.
- Use `mcp__pi__edit` not regex per `feedback_no_regex_for_func_args.md`.
- Smoke tests live-verified before closing each phase.
- Treat the audit checklist (§B) as a per-phase checklist; tick items off in the PR description.
