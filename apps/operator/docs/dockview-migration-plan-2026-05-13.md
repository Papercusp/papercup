# Dockview migration plan — full operator panel system

**Status**: proposal, awaiting greenlight. v3 (this file) = corrected rewrite after a third audit pass
that found concrete factual errors in v2 (migration number, column types, dockview v6 breaking
changes, mount-point file name, agent-contract dependency). All errors below were verified against
the current `main` checkout, not from memory.

**Repo**: work directly on `papercup/main` (no worktree, no feature branch). Per-turn commits.
User pauses other agents during implementation. Submodule (`libs/papercusp`) changes are coordinated
through the same checkout.

---

## §0. Verification log (what changed between v2 and v3, with sources)

These are the corrections folded into this rewrite. Each was checked against the repo, not assumed.

| v2 said | v3 fix | Source of truth |
|---|---|---|
| Migration number `067` | Use `070` (the next available) | `libs/papercusp/libs/db/sql/` last file = `069-system-docs-read-cap.sql`. Two duplicate numbers already exist (`058`, `062`) — not introducing a third. |
| `workspace_id uuid, user_id uuid` PK | `workspace_id text, user_id text` (NOT NULL, default `'default'` / `'_local'`) | `useWorkspaceId()` returns literal string `'default'` in dev; loopback dev has no auth user — user id is the string `'_local'`. Both are *not* UUIDs. Using uuid columns would crash inserts. |
| "dockview v5→v6 has small API breaks, usually small" | v6 has **3 breaking changes the plan must handle**: CSS no longer auto-injects (explicit `import 'dockview/dist/styles/dockview.css'` required), `TabGroupColor` renamed to `DockviewTabGroupColor`, theme class must live on a wrapping shell element (not inside the dock). Phase 1 has explicit acceptance criteria for each. | dockview v6.0.0 release notes (verified by browsing the project's CHANGELOG via context7). |
| Dock root mounts in `<HarnessShell>` | Dock root mounts in `apps/operator/app/_components/ChromeShell.tsx`. The chat sidebar is lazy-loaded inside it. No file named `HarnessShell` exists. | `grep -r "HarnessShell" apps/operator` — no matches. `ChromeShell.tsx` is the actual app shell. |
| `?phase=` URL param holds phase per-page | Phase moves to **per-panel `params.phase`** because the plan supports multiple `view:harness-overview` panels open at once. Global URL state can't represent that. | Plan §A.4.2 says "Open a second `view:harness-overview` … with a different slug" — that immediately implies per-panel phase too. v2 missed this. |
| HarnessSelectorChip "goes in chat sidebar header" | The sidebar header is **already 286px of controls in 63px height** (Active 70 + Voice 178 + Settings 28; freshly tightened in this session). The chip cannot fit on that row. v3 specs a new sub-row below, +20px header height, OR a small icon-only chip with a popover. Decision deferred to §D. | `apps/operator/app/_components/OperatorChatSidebar.tsx` per this session's "collapse header" change committed earlier today. |
| Plugin async load not specified | Plugins call `registerPanel(type, component)` from `onLoad`. `PANEL_REGISTRY` is a reactive map. When a layout references a not-yet-registered type, `MissingPanel` renders with state `"loading-plugin"` (if plugin manifest known) or `"unknown"` (if not). On `registerPanel`, dock re-renders affected panels with the real component. | New design — closes gap from v2 §B.4. |
| Agent `ui:dispatch` "needs new actions" listed in phase 6/7 | This is a **hard blocker for phase 5**, not a phase 7 nicety. After phase 5 the URL no longer carries `?slug=`, `?phase=`, `?panel=` — those are per-panel params inside the dock layout. Existing agent UI control surface reads/writes URL; it will be broken on the day phase 5 ships unless new actions land in the same PR. | Memory: "URL is the agent → UI control surface". Verified `ui:dispatch` in the codebase: yes, exists, today nuqs-keyed. |
| Phase 0 POC absent | Added explicitly: a 1-day spike to mount one `<DockviewReact>` with one stub panel and persist layout to PG, ahead of touching the pi tab. Validates the whole stack (SSR dynamic import, CSS pipeline, PG round-trip, ChromeShell mount point) on a throwaway route. | Best practice for a 6-PR migration. v2 buried this in "phase 1". |

---

## §A. Goals and non-goals

### Goal
Every long-lived view in the operator becomes a draggable panel in one dockview tree. Layouts persist
per (workspace, user, layout-name) in Postgres. Users can split, tab, float, and pin panels. Multi-harness
side-by-side is a natural consequence — not a separate feature.

### Non-goals
- App chrome (chat sidebar, top HUD, command palette, toasts): stays fixed, not in the dock.
- Transient overlays (`FeaturePeekPanel`, `IssueDetail`, modals, full-screen brainstorm canvas): stays as overlays.
- Multi-OS-window tear-off: replaced by dockview's `FloatingGroup` (single-process floating).
- Cross-window/cross-tab sync (BroadcastChannel): not in scope; single window only.
- Mobile responsive: phase 7 (deferred) adds a "compact / list-only" fallback below 720px.
- Plugin SDK breaking change: `dashboardTabs` field stays as a deprecated alias forever (warn in dev).

---

## §B. Final architecture

```
ChromeShell.tsx                                      ← stays
├── OperatorChatSidebar                              ← chrome, fixed left
│   └── HarnessSelectorChip (NEW)                     ← drives default slug for new panels
├── HarnessHudOverlay                                ← chrome, fixed top (stripped: no selector)
├── DockviewReact ⬅ ONE root dock, replaces:
│     - top tab strip (Dashboard / Docs / VSCode / Pi / Design)
│     - dashboard internals (Git / Features / Issues / Agents / Logs split)
├── FeaturePeekPanel (overlay drawer)
├── IssueDetail (overlay drawer)
├── CommandPalette
└── Toaster
```

### B.1 PANEL_REGISTRY

```ts
const PANEL_REGISTRY: Record<string, PanelComponent> = {
  // Absorbs what `.h-header` used to render
  'view:harness-overview':   HarnessOverviewPanel,    // phase tabs + status + progress, per-instance slug+phase
  // Existing top-level "tabs"
  'view:dashboard-overview': DashboardOverviewPanel,
  'view:docs':               DocsPanel,
  'view:vscode':             VSCodePanel,             // iframe to code-server
  'view:pi-terminals':       PiTerminalsDock,         // NESTED dock (the existing pi system)
  'view:design':             DesignPanel,
  'view:proposals':          ProposalsPanel,          // internal react-resizable-panels STAYS inside
  // Intra-dashboard panels become top-level instances
  'data:features':           FeaturesPanel,
  'data:issues':             IssuesPanel,
  'data:agents':             AgentsPanel,
  'data:logs':               LogsPanel,
  'data:git':                GitGraphPanel,
  'data:chat':               ChatPanel,
  // Pinned-detail panels (created by "Pin as panel")
  'pin:feature':             PinnedFeaturePanel,
  'pin:issue':               PinnedIssuePanel,
  // Dynamic
  'plugin:*':                PluginPanelRouter,
};
```

Every panel receives `props.api.params: { workspaceId, harnessSlug, phase?, ...specific }`. Two panels
with the same `type` and different `params` are distinct instances — this is what makes "two
harness-overview panels for different slugs+phases" work.

### B.2 Persistence — migration 070

```sql
-- libs/papercusp/libs/db/sql/070-dock-layouts.sql
CREATE TABLE harness_shared.harness_dock_layouts (
  workspace_id    text    NOT NULL,
  user_id         text    NOT NULL DEFAULT '_local',
  layout_name     text    NOT NULL DEFAULT 'default',
  schema_version  int     NOT NULL DEFAULT 1,
  layout_json     jsonb   NOT NULL,
  created_ts      bigint  NOT NULL,
  updated_ts      bigint  NOT NULL,
  PRIMARY KEY (workspace_id, user_id, layout_name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_dock_layouts TO harness_admin;
```

- `text` not `uuid` per §0.
- `schema_version` lets future dockview major-bumps migrate layout JSON instead of rejecting it.
- Optimistic concurrency: PUT requires the previous `updated_ts`; server rejects on mismatch with 409.
  Last-writer-wins is a per-request opt-out via `?force=1`. Keeps two-tab-same-user from clobbering.
- `getUserIdForLayouts(req)` resolver: in loopback dev returns `'_local'`; with Plan 4 auth returns
  the authenticated user id. Multi-user queries always filter by `user_id = current_user_id`.

### B.3 URL state (after phase 5)

| Param | Carries | Notes |
|---|---|---|
| `?layout=<name>` | Which named layout to load | Default `'default'` |
| `?focus=<panelId>` | Which panel has keyboard focus | Transient, throttled writes |
| `?slug=<slug>` | **Compat only** — pre-phase-5 deep links | Hydrates default layout with one overview panel for that slug |
| ~~`?phase=`~~ | Removed | Now per-panel `params.phase` |
| ~~`?panel=`~~ | Removed | Replaced by `?focus=` |
| ~~`?harness=` etc.~~ | Removed | Per-panel `params.harnessSlug` |

Pre-alpha — no users — so removing query params is OK per memory rules. Plan does NOT carry the
full layout JSON in URL (5–15 KB, churn-heavy → bad URL citizen).

### B.4 Agent UI contract (HARD requirement for phase 5)

Today's `ui:dispatch` actions: `setSlug`, `setPhase`, `selectFeature`, `selectIssue`, `openPanel`,
`closePanel`. All implemented as nuqs URL writes.

After phase 5 these must dispatch to dock layout operations:
- `setSlug(slug)` → set `defaultSlug` (chip in sidebar) AND if a `view:harness-overview` panel is
  focused, mutate its `params.harnessSlug` via dockview API.
- `setPhase(phase)` → mutate focused panel's `params.phase` (overview panel only).
- `openPanel(type, params)` → `dockApi.addPanel({ id: nanoid(), component: type, params })`.
- `closePanel(panelId)` → `dockApi.removePanel(panelId)`.
- `focusPanel(panelId)` → `dockApi.getPanel(panelId)?.focus()`.
- NEW: `splitPanel`, `floatPanel`, `pinAsPanel(entityType, entityId)`.

`ui:get_state` returns `{ defaultSlug, focusedPanelId, panels: [{ id, type, params }] }` for the
agent to read. This is part of phase 5's PR, not deferred.

### B.5 Plugin contract

Plugin manifest (backwards-compatible):
```jsonc
{
  "id": "linear-sync",
  "panels": [                      // new field
    { "id": "linear:projects", "title": "Linear Projects", "iframeUrl": "/p/linear/projects" }
  ],
  "dashboardTabs": [...]           // deprecated alias; mapped to panels[] at load time
}
```

Load order:
1. ChromeShell mounts; dock hydrates from PG. Unknown panel types → `MissingPanel("loading")`
   if a plugin manifest declares the type (even if plugin code hasn't loaded yet), else
   `MissingPanel("unknown")` with a "Remove from layout" affordance.
2. Plugin's `onLoad` calls `registerPanel('plugin:linear:projects', Component)`.
3. Dock listens to registry mutations and re-renders affected panels with the real component.

---

## §C. Phased delivery — 7 PRs, ordered for risk

Each phase is one PR, independently revertable. Acceptance criteria are testable smoke steps.

### Phase 0 — POC spike (NEW; was missing in v2) — ~0.5 day
**Goal**: mount one `<DockviewReact>` on a throwaway dev route (`/dev/dock-poc`) with two stub
panels and PG-backed save/restore. Validate SSR pipeline, CSS import, ChromeShell mount,
optimistic-concurrency PUT, and React 19 + Next 15 compat against a real production-mode build.

**Changes**:
- Add `dockview` and `dockview-react` v6.2.2 deps.
- Migration 070 (text columns, schema_version, default 'default' / '_local').
- `apps/operator/lib/dock-layouts.ts`: CRUD against PG.
- `app/api/_hono/dock-layouts.ts`: GET/PUT with `If-Match: <updated_ts>`.
- `app/dev/dock-poc/page.tsx`: dynamic-import-only-on-client of `DockviewReact`; two stub panels.

**Acceptance**:
- POC route loads in dev AND in `next build && next start` (no SSR crash).
- Drag-rearrange persists across hard reload.
- Two browser tabs open simultaneously → PUT with stale `updated_ts` returns 409.
- `:3055` runs cleanly for 10 minutes with the POC route open.
- Migration 070 applies on operator boot (relies on this session's migration-runner fix).

**Risk**: low. Throwaway route. Worst case: revert deps + drop migration table.

---

### Phase 1 — Upgrade pi-tab to dockview 6.2.2 — ~0.5 day
**Scope**: bump existing pi tab from v5.2.0 to v6.2.2 with all three v6 breaking changes addressed.

**Changes**:
- `package.json`: dockview-react 5.2.0 → 6.2.2.
- Explicit `import 'dockview/dist/styles/dockview.css'` in `ChromeShell.tsx` (was auto-injected in v5).
- Rename any `TabGroupColor` import → `DockviewTabGroupColor`. (Grep first.)
- Move dockview theme class onto a wrapper `<div className="dockview-theme-dark">` around DockviewReact;
  do NOT put it on the dock element itself (v6 requirement).
- Verify `onDidLayoutChange`, `onDidAddPanel`, `onDidRemovePanel` still fire (API unchanged in v6).

**Acceptance**:
- Pi tab: open 3 terminals, split, drag-rearrange, reload — restored.
- Dockview dark theme applied (no white-flash regression).
- FloatingGroup works: drag a terminal tab out → floats inside the same window.
- All existing pi-tab e2e (if any) pass.
- `vitest` setup unchanged (no resize-observer crashes in jsdom — if hit, polyfill in `vitest.setup.ts`).

**Risk**: low (isolated to pi tab).

---

### Phase 2 — Pi-tab persistence: localStorage → PG — ~0.5 day
**Changes**:
- Replace `LAYOUT_STORAGE_PREFIX` localStorage in `PiTerminalsDock.tsx` with calls to the
  layouts API from phase 0.
- One-time migration shim on mount: if localStorage has `papercusp:pi-dock-layout:*` AND PG is empty
  for this (workspace, user, layout_name='pi'), upsert localStorage → PG, then `removeItem` the key.
  Use `INSERT … ON CONFLICT DO NOTHING` to handle two-tab races on first migration.

**Acceptance**:
- Pi tab in browser A → rearrange → close A → open B at same URL: layout matches.
- Same in webapp via tunnel: layout matches.
- After first load post-deploy, localStorage `papercusp:pi-dock-layout:*` keys are gone.
- Optimistic concurrency: two-tab simultaneous edit → second tab sees 409, refetches, applies, retries.

**Risk**: medium — first PG-canonical layout. Get the API contract right here.

---

### Phase 3 — Dashboard internals → nested DockviewReact — ~1.5 days
**Scope**: keep top-level "Dashboard / Docs / VSCode / Pi / Design" tab strip exactly as-is, but
inside the Dashboard panel, the `react-resizable-panels` 4-way split becomes a nested dock.

**Changes**:
- New `DashboardDock` component. Components: `data:git`, `data:features`, `data:issues`,
  `data:agents`, `data:logs`, `data:chat`. Each panel is a thin wrapper around the existing
  inner content — NO logic moves.
- Layout name in PG: `'dashboard'` per (workspace, user).
- Default `'dashboard'` layout = today's split shape, expressed as dockview tree.
- `react-resizable-panels` import removed from `HarnessDashboard.tsx`. **Dependency stays in
  `package.json`** (still used by ProposalsPanel internals and elsewhere — phased out separately).
- `FeaturePeekPanel` and `IssueDetail` drawers stay as overlays, NOT in the dock. Verify the
  recent "instant-open peek" fix still works (the drawers mount once at `ChromeShell` level).

**Acceptance**:
- All 5 dashboard panels render in starting positions matching today's UX.
- Drag any panel → new position → reload → restored.
- Click feature row → `FeaturePeekPanel` opens instantly (the fix from earlier this session).
- All e2e tests in `apps/operator/tests/` still pass.
- Keyboard shortcuts (Cmd+/, Cmd+K, etc.) still work and are not swallowed by dockview's own
  handlers (audit dockview key handling first).
- No layout flicker on cold load — dock blocks render until PG layout fetched (loading spinner).

**Risk**: medium-high — most-trafficked screen. Pause paperclip during this PR.

---

### Phase 4 — Harness-overview panel + selector to sidebar — ~1 day
**Scope**: unbundle the `.h-header` block per §B.

**Changes**:
- New `view:harness-overview` panel with `params: { harnessSlug, phase }`. Renders phase tabs,
  alive/idle chip, project path, progress %, todo/blocked/passed counts. Phase tabs mutate
  `params.phase` via `panel.api.updateParameters({ phase })`, NOT the URL.
- `HarnessSelectorChip` lives in `OperatorChatSidebar` header (or sub-row, per §D decision D2).
  Reads/writes `defaultSlug` via nuqs (`?slug=`) — same key kept for compat.
- `.h-header` block in `HarnessDashboard.tsx` deleted.
- Default `'dashboard'` layout updated to include one `view:harness-overview` panel pinned to the
  left rail.
- `/harness/sheets` deep links: middleware hydrates default layout with one overview panel for
  `slug=sheets`, `phase=staging`. The `?slug=` param stays as the chip's source of truth.

**Acceptance**:
- `/harness/sheets` cold load → overview panel for sheets visible by default.
- Sidebar chip shows `sheets`. Changing to `other` does NOT mutate open panels; new panels default to `other`.
- Open a 2nd overview panel with `params.slug='other', params.phase='production'` via catalog →
  both visible side-by-side, phase tabs independent.
- Voice mode "summarize harness state": uses focused panel's `params.harnessSlug` if a panel is focused,
  else `defaultSlug`. (Add a smoke step.)

**Risk**: medium — semantic shift from "one harness per page" to "default for new panels".

---

### Phase 5 — Collapse top-level strip + agent UI dispatch update — ~2 days
**Scope**: the current Dashboard / Docs / VSCode / Pi / Design tab strip disappears. Everything
becomes a panel in one root `<DockviewReact>`. **This PR also ships the agent `ui:dispatch` /
`ui:get_state` rewrite** — hard requirement, not deferred. Without it, agent UI control breaks
on the day this lands.

**Changes**:
- Root `<DockviewReact>` replaces all content area in `ChromeShell.tsx`.
- All former tabs become panel types; openable via:
  - `Cmd+K` palette: "Open: <Panel Type>"
  - Right-click empty group: "Add panel" submenu
  - "+ tab" affordance on group tab strip (dockview v6's `getContextMenuItems`)
- `PiTerminalsDock` becomes a nested dock inside `view:pi-terminals` (verify nested-drag boundary;
  see §D.5).
- `ProposalsPanel` keeps its internal `react-resizable-panels` split — no change to its internals.
- Agent contract: new `ui:dispatch` actions per §B.4. `ui:get_state` extended with `panels[]`.
- `?slug=` URL param remains a compat alias; first-load middleware hydrates default layout.
- Document URL changes in `apps/operator/docs/url-state-migration.md` (new file): which params went away.

**Acceptance**:
- All former tabs reachable via Cmd+K. Drag Docs next to Features in one group works.
- Multiple `view:harness-overview` panels with different slugs+phases simultaneously.
- FloatingGroup: drag a panel out → floats inside the window. Re-dock by drag-back works.
- Layout reloads correctly across operator restart.
- Agent SDK smoke: `ui:dispatch({type:'openPanel', component:'data:features', params:{slug:'sheets'}})`
  works. `ui:get_state()` returns the new panels array.
- Hard-reset escape hatch: Shift+Esc held 1s → clears `'default'` layout in PG, reloads with built-in
  default. Documented in `/dev/dock-debug` page.

**Risk**: medium-high — largest visible UX change. Pause paperclip during this PR. Per-turn commits
non-negotiable.

---

### Phase 6 — Plugin panels + Pin-as-panel — ~0.5 day
**Changes**:
- Plugin manifest gains `panels: PluginPanel[]`. Deprecate `dashboardTabs` (warn in dev only).
- Plugin host's `onLoad` calls `registerPanel(type, component)`. PANEL_REGISTRY becomes reactive.
- Right-click feature row → "Pin as panel" → `dockApi.addPanel({ component: 'pin:feature', params: { slug, featureId } })`.
- Same for issues.
- `MissingPanel` fallback for unknown / loading-plugin types.

**Acceptance**:
- A test plugin registers a panel; appears in Cmd+K, draggable, persists.
- Pin F-FIND-002 from sheets and F-PEEK-003 from sheets simultaneously → both pinned panels open.
- Uninstall a plugin → existing pinned panels of its type become `MissingPanel("unknown")` with
  "Remove from layout" button.

**Risk**: low (additive).

---

### Phase 7 — DEFERRED. Mobile / compact fallback — out of scope for this milestone
Mobile breakpoint < 720px: render a vertical accordion of panels instead of a dock. Track separately.

---

## §D. Open decisions for review

These are choices the user (you) should make before phase 1 starts. Default answers in parentheses
— I'll proceed with defaults if not told otherwise.

1. **D1. Plugin migration deadline.** `dashboardTabs` deprecated alias: warn forever, or hard-fail
   at some date? (Default: warn forever, never break — pre-alpha but plugin authors are external
   contributors who should not be surprise-broken.)

2. **D2. Harness selector chip placement.** Three options:
   - (a) Inline on existing 286px control row → requires shrinking voice/active controls again. Tight.
   - (b) New sub-row in sidebar header → +20px header height. Less tight but reverses today's
     "make header smaller" change.
   - (c) Icon-only chip + popover dropdown → fits in existing row, but slug name not visible at glance.
   (Default: (b) — header was 63px, becomes 83px. Small enough.)

3. **D3. Default layout panel composition.** Three rails (Git left, dashboard middle, telemetry
   right) vs. (Features/Issues left, Overview middle, Telemetry right). (Default: first option —
   closest to today's UX, minimizes muscle-memory churn.)

4. **D4. Phase ordering.** As written: 0 → 1 → 2 → 3 → 4 → 5 → 6. Alternative: 0 → 1 → 2 → **4 → 3**
   → 5 → 6 (selector move before dashboard internals dockify). (Default: as written — internals
   first validates dockview at scale; selector move is independent.)

5. **D5. Nested-dock drag boundary.** When a user drags a tab inside `view:pi-terminals` (the nested
   dock), should it be allowed to leave the nested dock and dock into the outer one? Dockview v6
   supports this but the drag preview clipping at the boundary is rough. (Default: NO — nested dock
   is a contained system; drag-out is blocked. Users can close in pi then re-open in outer.)

6. **D6. Optimistic concurrency vs. last-writer-wins for layout PUT.** Optimistic adds 409-handling
   complexity but prevents silent overwrites between two tabs. (Default: optimistic, with
   `?force=1` opt-out for the "reset layout" flow.)

7. **D7. Cold-load behavior when PG layout fetch is in flight.** Show spinner (default), show
   last-known cached layout from sessionStorage, or render built-in default and overlay-load?
   (Default: spinner — simplest, no flicker. Latency typically <100ms on local PG.)

8. **D8. ProposalsPanel internal `react-resizable-panels`.** Leave as-is (default), or convert to
   nested dockview in a follow-up? (Default: leave — it's a stable 2-pane split, doesn't need drag.)

9. **D9. Agent `ui:dispatch` versioning.** New actions in phase 5 break agents that call old shape.
   Bump dispatch protocol version, or coexist? (Default: bump to v2; old shape returns 410 Gone with
   migration hint in error body.)

10. **D10. Layout schema version 1 → 2 migration path.** If dockview v7 changes layout JSON shape
    later, do we run JSON migrations server-side on read, or refuse to load and force rebuild?
    (Default: server-side migration with `schema_version` bump; refusing loses user work.)

---

## §E. Effort revision

| Phase | v2 est. | v3 est. | Delta |
|---|---|---|---|
| 0 POC | — | 0.5d | NEW |
| 1 pi-tab upgrade | 0.5d | 0.5d | — |
| 2 pi-tab → PG | 0.5d | 0.5d | — |
| 3 dashboard internals | 1d | 1.5d | +0.5d (audit additions: SSR, layout fetch race, peek-drawer interaction tests) |
| 4 selector + overview panel | 1d | 1d | — |
| 5 collapse strip + agent dispatch | 1.5d | 2d | +0.5d (agent contract was understated) |
| 6 plugin panels + pin | 0.5d | 0.5d | — |
| **Total** | **5d** | **6.5d** | **+1.5d** |

7 PRs. Most days are short, low-risk. Phases 3 and 5 are the two paperclip-pause windows.

---

## §F. Notes for the implementer (future me, or whoever inherits)

- **Paperclip discipline**: `pgrep -af paperclip` before every PR. The doc directory is safe
  (not a harness UI hot path), but phases 3, 4, 5 edit `apps/operator/app/_components/ChromeShell.tsx`
  and `app/harness/*` which are paperclip's territory. Explicitly request paperclip pause for those.
- **Per-turn commits**: every phase commits + pushes every turn, even WIP. Coord entries reference
  head SHA. Per memory.
- **Use `mcp__pi__edit` for code edits**, not regex. Greedy `[^)]*` has bit this codebase three
  times. Especially relevant for the `react-resizable-panels` → dockview swap in phase 3.
- **No TS deletion** in `apps/operator/` or `libs/papercusp/` beyond explicit replacement targets.
  This plan explicitly intends to delete `.h-header` block in phase 4 and `RPanelGroup` usage in
  HarnessDashboard.tsx in phase 3. Anything else is out of scope.
- **Performance budget**: spike test at end of phase 2 — open 10 simultaneous pi-tab terminals,
  watch dev-tools memory and frame timing. Decide whether to add `keepAlive` opt-out for heavy
  panels before phase 3 scales up the surface.
- **Submodule coordination**: migration 070 lives in `libs/papercusp/libs/db/sql/`. Bump submodule
  pointer in `papercup` in the same PR as the operator change that consumes it.
- **Migration runner**: this session shipped the operator-boot migration runner. Phase 0's
  migration 070 should apply automatically. Verify by checking `schema_migrations` after operator
  start — if missing, the runner is the gap, not the migration.

---

End of plan v3. Awaiting greenlight on §D decisions before phase 0 starts.
