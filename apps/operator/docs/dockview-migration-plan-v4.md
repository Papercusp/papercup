# Dockview migration plan — v4 (consolidated)

**Status:** spec, ready for greenlight.
**Supersedes:** v3 (`dockview-migration-plan-2026-05-13.md`) and v4 audit brief (`dockview-migration-plan-v4-brief.md`). Both stay in-repo as history; v4 is the source of truth.
**Author trail:** v1/v2 in-session drafts, v3 written by handoff agent, audit brief written by original, decisions resolved by user, v4 consolidated.
**Target:** `apps/operator` (Tauri desktop + dev webapp). Out of scope: webapp duplicate in `libs/papercusp`.

---

## 1. Goal

Make every long-lived workspace view a draggable, splittable, floatable panel inside one dockview tree. Eliminate the inconsistency between the pi tab's drag-and-drop and the rest of the dashboard's fixed splits. Persist layouts per-user in PG so they follow the user across machines and surfaces. Give agents a stable dispatch surface to navigate the dock.

## 2. Non-goals

- Replacing app chrome (operator chat sidebar, top HUD strip, command palette, toasts, workspace switcher).
- Replacing transient overlays (FeaturePeekPanel, IssueDetail, brainstorm canvas, modals).
- Real-time cross-tab layout sync — last-writer-wins per session is the v1 contract.
- Multi-OS-window tab tear-off — FloatingGroup (same-window floating) is the substitute.
- Mobile layouts — operator is desktop-only by deployment model (Tauri primary).
- Webapp copy in `libs/papercusp/apps/web/app/harness` — migrated separately if/when needed.
- ProposalsPanel's internal `react-resizable-panels` split — stays as is; dep keeps for now.

## 3. Architecture

### 3.1 Mount point

DockviewReact mounts in `apps/operator/app/_components/ChromeShell.tsx`, conditioned on pathname:

```
ChromeShell
├── WorkspaceSwitcher (top-level, stays)
├── OperatorChatSidebar (left chrome, stays — gets a HarnessSelectorChip sub-row in Phase 4)
├── HarnessHudOverlay (top chrome, stripped down in Phase 5 — see §3.5)
├── if pathname matches /harness/* → <DockviewReact components={PANEL_REGISTRY} … />
│   else                              → existing static layout (untouched)
├── FeaturePeekPanel / IssueDetail (overlay drawers, stay outside dock)
├── BrainstormCanvas (full-viewport overlay, stay outside dock)
├── CommandPalette / Toaster (overlays, stay)
```

Other routes (`/settings/*`, `/admin/*`, `/dev/*`, `/installed/*`) keep their existing static layout. The dock is for workspace surfaces with arrangeable side-by-side content; linear flows don't get drag UX.

### 3.2 PANEL_REGISTRY

```ts
const PANEL_REGISTRY = {
  // Absorbs the .h-header block — phase tabs, status chip, project path, progress
  'view:harness-overview':   HarnessOverviewPanel,

  // Former top-level "main tabs"
  'view:dashboard-overview': DashboardOverviewPanel,
  'view:docs':               DocsPanel,
  'view:vscode':             VSCodePanel,        // iframe via portal pattern (§5)
  'view:pi-terminals':       PiTerminalsDock,    // nested dock
  'view:design':             DesignPanel,
  'view:proposals':          ProposalsPanel,
  'view:summary':            SummaryPanel,
  'view:insights':           InsightsPanel,
  'view:config':             ConfigPanel,

  // Former intra-dashboard splits — now top-level draggable panels
  'data:features':           FeaturesPanel,
  'data:issues':             IssuesPanel,
  'data:agents':             AgentsPanel,
  'data:logs':               LogsPanel,
  'data:git':                GitGraphPanel,
  'data:chat':               ChatPanel,

  // Pin-as-panel (right-click → Pin)
  'pin:feature':             PinnedFeaturePanel,
  'pin:issue':               PinnedIssuePanel,

  // Dynamic — registered at plugin onLoad
  'plugin:<id>:<panel-id>':  // late-bound via registerPanel(type, component)

  // Fallback when registry doesn't know the type yet
  '__missing__':             MissingPanel,
};
```

Every panel receives `props.api.params: { workspaceId, harnessSlug, ...specific }`. Two panels with the same `type` and different `params.harnessSlug` are independent instances — that's how side-by-side multi-harness compare falls out for free.

### 3.3 Default layout (seeded)

Recreates today's UX. Shipped as a static JSON blob in `apps/operator/lib/dock-default-layout.ts`, seeded on first read miss (§4.5):

```
┌─────────────┬─────────────────────────────────────┬──────────────┐
│ context     │ main (tabs)                         │ telemetry    │
│ rail 280px  │ ┌─────────┬─────────┬─────────────┐ │ rail 320px   │
│             │ │ overview│ features│ issues … etc│ │              │
│  data:git   │ ├─────────┴─────────┴─────────────┤ │ data:agents  │
│  view:      │ │                                 │ │ data:logs    │
│  harness-   │ │   Active panel content          │ │              │
│  overview   │ │                                 │ │              │
└─────────────┴─────────────────────────────────────┴──────────────┘
```

### 3.4 Harness selector relocation (Phase 4)

Current state: the harness selector lives in `HarnessDashboard.tsx`'s `.h-header` and is bound to `?slug=`. After Phase 4:

- **`HarnessSelectorChip`** moves to a 24px sub-row in `OperatorChatSidebar` header. Total header grows from ~63px to ~90px. Existing 3-button control row (Active/Voice/Settings) stays untouched.
- The chip drives `?focusSlug=` (a new nuqs key), which is the **default slug for new panels** and the **agent-context default**. It does NOT retroactively change open panels.
- **`?slug=`** is retained as a first-load deep-link hint: opening `/harness/sheets` seeds the default layout with one `view:harness-overview` panel pre-loaded for `sheets`, then the URL key is dropped from active runtime use.
- **Phase state** (`?phase=staging`) is removed as a URL key and becomes **per-panel `params.phase`**. Each `view:harness-overview` panel carries its own phase. Two overviews for the same slug, one at `staging` and one at `testing`, can sit side by side.
- **`harness_phase_last_used`** side table (migration 071, Phase 4) remembers the last phase per `(workspace_id, slug, user_id)`, so reopening an overview for `sheets` defaults to whatever phase you last had it in.
- **WorkspaceSwitcher** stays in ChromeShell top-level — global concept, not harness-scoped.

### 3.5 HarnessHudOverlay disposition

Today the HUD surfaces: alive/idle status, active panel name, lane count, mission state, build status pill, voice indicator. After Phase 5:

- **Stays in HUD:** mission state, build status pill, voice indicator (truly global)
- **Moves to per-panel:** alive/idle status, active panel name, lane count (these were dashboard-scoped, not global)
- HUD shrinks accordingly.

---

## 4. Data model

### 4.1 New table — migration 070

```sql
-- libs/papercusp/libs/db/sql/070-dock-layouts.sql
CREATE TABLE harness_shared.harness_dock_layouts (
  workspace_id    text    NOT NULL,
  user_id         text    NOT NULL,     -- '_local' in loopback dev, real id in webapp
  layout_name     text    NOT NULL DEFAULT 'default',
  schema_version  int     NOT NULL DEFAULT 1,
  layout_json     jsonb   NOT NULL,
  updated_ts      bigint  NOT NULL,
  created_ts      bigint  NOT NULL,
  PRIMARY KEY (workspace_id, user_id, layout_name)
);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.harness_dock_layouts TO harness_admin;
```

Column types are `text` not `uuid`: workspace IDs are literals like `'default'`; `user_id` is `'_local'` in loopback dev and a string identifier in webapp auth.

### 4.2 Auxiliary table — migration 071 (Phase 4)

```sql
-- libs/papercusp/libs/db/sql/071-harness-phase-last-used.sql
CREATE TABLE harness_shared.harness_phase_last_used (
  workspace_id  text   NOT NULL,
  harness_slug  text   NOT NULL,
  user_id       text   NOT NULL,
  phase         text   NOT NULL,
  updated_ts    bigint NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, user_id)
);
```

Reopening an overview panel for `sheets` consults this table; falls back to `'staging'` on miss.

### 4.3 Auto-apply

This session shipped operator-boot migration runner (`apps/operator/instrumentation-node.ts` calls `applyPendingMigrations`). 070 and 071 apply automatically on next operator restart. **No manual `apply-NNN.sh` scripts.** Phase 0 verifies the runner is intact and applies cleanly.

### 4.4 Logical layout schema (storage shape)

Stored in `layout_json`, NOT raw dockview JSON. The boundary adapter converts.

```ts
type LayoutDoc = {
  schemaVersion: 1;
  root: GroupNode;
  floating: FloatingGroup[];
};

type GroupNode = {
  kind: 'group';
  id: string;
  direction?: 'row' | 'col';     // for splits
  children: (GroupNode | TabStrip)[];
  size?: number;                 // 0..1, relative
};

type TabStrip = {
  kind: 'tabs';
  id: string;
  activePanelId: string;
  panels: PanelInstance[];
};

type PanelInstance = {
  id: string;                    // stable across saves
  type: string;                  // PANEL_REGISTRY key
  title?: string;                // override; default from registry
  params: Record<string, unknown>; // includes harnessSlug, phase, history, etc.
  keepAlive?: boolean;           // overrides registry default
};

type FloatingGroup = {
  id: string;
  x: number; y: number;
  width: number; height: number;
  panels: PanelInstance[];
  activePanelId: string;
};
```

**Why logical, not raw dockview JSON:**
- Schema versioning is ours, not dockview's
- Survives dockview API churn between minor versions
- Programmatic creation (default seed, agent dispatch) is far easier
- Validation at PUT (reject malformed shapes before persisting)
- Adapter cost: ~100 lines, one-time

### 4.5 Seed flow (first-time user)

On first GET for `(workspace_id, user_id, 'default')`:
1. Server checks PG → miss
2. Server reads `apps/operator/lib/dock-default-layout.ts` (static JSON)
3. INSERTs row with seeded layout, returns it
4. All subsequent GETs hit the row

User never sees a blank dock. "Reset to default" overwrites the row with the same seed JSON, preserving the row identity (etag/updated_ts still bumps).

### 4.6 Schema migration

`schema_version` on the row. When code bumps the constant beyond what's stored, `apps/operator/lib/dock-layout-migrators.ts` runs in-process migrators (e.g. v1→v2 renames). Unknown future versions: return seed default + warn, don't crash.

### 4.7 Concurrency

Last-writer-wins. Client passes `If-Match: <updated_ts>` on PUT; server rejects with 409 if stale. Client refetches and the user's most recent local layout is dropped (rare — same user editing in two tabs at once). Per §2 non-goals, real-time cross-tab sync is intentionally out.

### 4.8 Authorization

`getUserIdForLayouts(req)` resolver returns `{ workspaceId, userId }` or throws 403.
- Loopback dev: returns `{ workspaceId: 'default', userId: '_local' }` (matches §3.5 of operator auth)
- Webapp: verifies authenticated user, checks workspace membership, returns real IDs

### 4.9 API endpoints

```
GET    /api/dock-layouts/:name        → LayoutDoc            (seeds on miss)
PUT    /api/dock-layouts/:name        → 200 | 409            (If-Match required)
DELETE /api/dock-layouts/:name        → 204                  (reseeds on next GET)
GET    /api/dock-layouts              → [{ name, updated_ts }]
```


---

## 5. URL state inventory & disposition

HarnessDashboard currently has 22+ `useQueryState` calls. Each must be classified before Phase 3 ships.

| Current key | Today | After |
|---|---|---|
| `slug` | scopes the whole page | **Deep-link hint only** — opens default layout pre-loaded for slug, then dropped from runtime URL |
| `panel` | which main tab | **Removed** — superseded by dock layout focus |
| `phase` | which phase tab | **Per-panel `params.phase`** (Phase 4) |
| `triage` | issues triage view | **Per-panel `params.triage`** on IssuesPanel |
| `gitCollapsed` | git rail width | **Per-panel `params.collapsed`** on GitGraphPanel |
| `editorMode` | inline editor mode | **Per-panel `params.editorMode`** on relevant panels |
| `showTriage` | triage modal | **Per-panel transient state** (not persisted) |
| `peekFeature` | peek drawer feature id | **Stays chrome-global** — drawer is an overlay, one at a time |
| `peekIssue` | peek drawer issue id | **Stays chrome-global** — same reason |
| `hooks` | hooks visibility | **Per-panel transient** |
| `intervene` | intervention modal | **Stays chrome-global** — modal |
| `expandedAgent` | agent expansion | **Per-panel transient** on AgentsPanel |
| `focusSlug` (new) | default for new panels | **New chrome-global** — drives selector chip |
| `layout` (new) | named layout id | **New chrome-global** |
| `focus` (new) | keyboard-focused panel id | **New chrome-global, transient** |

The remaining ~10 keys (audit in Phase 0): `bottomTab`, `chunkExpanded`, `assertExpanded`, `phaseTab`, `replicaTab`, `mcpTool`, `agentLane`, `logFilter`, `issuesFilter`, `featureFilter`. Default disposition: per-panel transient unless they're cross-panel concerns. Phase 0 produces the final table.

**Migration ergonomics:** existing bookmarks like `/harness/sheets?phase=testing&panel=features` should hydrate sensibly. First-load adapter:
1. Read legacy keys
2. Seed default layout
3. Mutate seed: set `view:harness-overview` `params.phase = 'testing'`, focus `data:features`
4. Strip legacy keys from URL via `replaceState`

---

## 6. Per-panel back/forward navigation

User-requested. Browser-like Cmd+[ / Cmd+] scoped per panel, not global. Panels with their own internal routes (Docs, VSCode, Pin, plugin iframes) opt in. Panels without internal navigation (live-tailing logs, agents list, features list) don't show chevrons at all — no disabled buttons.

### 6.1 Hook contract

```ts
type NavEntry = { route: unknown; ts: number };

interface NavHistory<T> {
  current: T;
  back(): void;
  forward(): void;
  push(route: T): void;
  replace(route: T): void;
  canBack: boolean;
  canForward: boolean;
}

function useNavHistory<T>(initial: T): NavHistory<T>;
```

Hook reads/writes `params.history: { stack: T[]; cursor: number }`. Cap = 50; oldest entries dropped FIFO. Pushed via panel internal navigation (e.g. Docs panel: `nav.push({ doc: 'getting-started' })`).

### 6.2 Chrome rendering

When `canBack || canForward`, the panel's dockview tab area renders ◀ ▶ chevrons (left-aligned, before the title). Disabled-state styling for unavailable direction. Cmd+[ / Cmd+] dispatch to the currently-focused panel's history.

### 6.3 "Open in new panel" semantics

Opens a fresh panel instance with the new route as `params.initial`. **Does NOT push history** on the originating panel. The new panel starts with an empty history (or just the one entry).

### 6.4 Persistence

History is in `params`, so it survives layout save/restore. Long-running sessions where the user has explored deeply through Docs get their nav state preserved across reloads.

---

## 7. Iframe portal pattern (avoids reload on reparent)

Dockview unmounts and remounts a panel's React component when the panel moves between groups. For iframe-hosted panels (VSCode/code-server, Drizzle Studio, plugin iframes), remount = iframe reload = lost editor state, lost scroll, lost cursor. Daily regression.

### 7.1 Mechanism

A fixed off-DOM container hosts the actual iframe nodes. When dockview asks the panel component to render, the component opens a React portal to attach the iframe's DOM node into the active dockview slot.

```tsx
// apps/operator/app/harness/iframe-host.ts
const iframeRegistry = new Map<string, HTMLIFrameElement>();
const offDomContainer = (() => {
  const c = document.createElement('div');
  c.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;';
  document.body.appendChild(c);
  return c;
})();

function getOrCreateIframe(panelId: string, src: string): HTMLIFrameElement {
  let f = iframeRegistry.get(panelId);
  if (!f) {
    f = document.createElement('iframe');
    f.src = src;
    f.style.cssText = 'width:100%;height:100%;border:0;';
    iframeRegistry.set(panelId, f);
    offDomContainer.appendChild(f);
  }
  return f;
}
```

### 7.2 Panel component

```tsx
function VSCodePanel({ api }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const iframe = getOrCreateIframe(api.id, `/embed/vscode?...`);
    containerRef.current?.appendChild(iframe);  // moves DOM node, doesn't recreate
    return () => {
      offDomContainer.appendChild(iframe);       // move back, not destroy
    };
  }, [api.id]);
  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
```

### 7.3 Lifecycle

- Panel mount: iframe moves from off-DOM to dockview slot (preserves all state)
- Panel hidden tab: stays in DOM; not visible but not unmounted — same JS context
- Panel unmount (drag to new group): iframe moves back to off-DOM container, then to new slot
- Panel close: iframe removed from registry and destroyed
- Layout save: iframe URL captured in `params.src`; closing the panel and reopening later DOES recreate

### 7.4 Applies to

`view:vscode`, `view:design` (if iframe-backed), plugin iframe panels (`plugin:*` with `type: 'iframe'`), `view:pi-terminals` (the xterm-hosting iframes inside). Portal-hosted panels override the registry's keep-alive policy (they're effectively always-alive while open).

---

## 8. Plugin contract

### 8.1 Manifest extension

Existing `dashboardTabs[]` keeps working as a back-compat alias (warn-only forever — no hard break). New canonical field is `panels[]`:

```jsonc
{
  "id": "linear-sync",
  "panels": [
    {
      "id": "projects",
      "title": "Linear Projects",
      "icon": "...",
      "type": "react",      // or "iframe"
      "src": "/p/linear/projects",
      "defaultGroup": "main",                // or "floating"
      "defaultFloating": { "w": 480, "h": 360 },
      "keepAlive": true
    }
  ]
}
```

Plugin's `onLoad` calls `registerPanel('plugin:linear-sync:projects', Component)`. Registered panel becomes draggable like any built-in, multi-instance, layoutable, history-aware (if it opts into `useNavHistory`).

### 8.2 `replaces` legacy field

After Phase 5, top-level tabs don't exist. Plugins setting `pluginTab.replaces: 'pi' | 'docs' | 'vscode'` get a console warn and the field is ignored. Their panel still registers normally.


### 8.3 Hot-swap when plugin registers late

Layout hydration races plugin onLoad. Two phases:

1. **Hydration**: dockview instantiates each panel. Any type not in registry → `MissingPanel` rendered with `state='loading'`.
2. **Plugin registration**: each `registerPanel(type, component)` call notifies the `PanelRegistry` event emitter. `MissingPanel` instances subscribe; on registry change, they re-render and the dockview API swaps in the real component.

```ts
class PanelRegistry {
  private map = new Map<string, Component>();
  private subs = new Set<() => void>();

  register(type: string, component: Component) {
    this.map.set(type, component);
    this.subs.forEach(fn => fn());
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get(type: string): Component | undefined { return this.map.get(type); }
}
```

`MissingPanel` subscribes on mount, unsubscribes on unmount, triggers re-render on notify.

### 8.4 Timeout

`MissingPanel` switches from `state='loading'` to `state='not-installed'` after 10s if registry still missing the type. UI: "Plugin not installed — Remove panel" button. User can close it from the dock without errors.

### 8.5 Plugin onLoad ordering

Plugin loader fires synchronously on app boot when possible. Dock hydration is async (waits for layout PG fetch) and naturally waits 100–500ms for the first plugin-batch to register. Hot-swap covers the residual race; no explicit barrier.

---

## 9. Agent dispatch surface

Phase 5 removes the top-level tab strip, which was the only navigation surface agents currently have via URL manipulation. Phase 5 ships replacements before the tab strip is removed.

### 9.1 New `ui:dispatch` actions

| Action | Payload | Effect |
|---|---|---|
| `openPanel` | `{ type, params, group?, floating? }` | Adds a new panel; returns its id |
| `focusPanel` | `{ panelId }` | Makes panel active; brings group to front |
| `closePanel` | `{ panelId }` | Removes panel; group may collapse |
| `setPanelParams` | `{ panelId, params }` | Merges params (e.g. change phase) |
| `setFocusSlug` | `{ slug }` | Updates `?focusSlug=` for default-slug behavior |
| `loadLayout` | `{ name }` | Switches named layout (Phase 6+) |
| `resetLayout` | `{}` | Reseeds default layout |

### 9.2 `ui:get_state` extensions

| Read | Returns |
|---|---|
| `layout` | LayoutDoc shape |
| `focusedPanel` | `{ id, type, params }` |
| `panels` | flat list of all open panels with ids/types/params |

### 9.3 Voice mode integration

Voice handler reads focused panel's `params.harnessSlug` (if set) or chrome `focusSlug` as default scope. Explicit phrasing ("show sheets features") overrides. Voice "open features" creates a new panel via `openPanel`; does NOT replace focused panel.

---

## 10. Phased delivery

Each phase is an independently revertable PR. Migration files are additive; no destructive changes.

### Phase 0 — Pre-flight (½ day)

**Scope:** prove the foundation works before any visible change.

- Confirm migration 070 number free (069 is highest applied as of 2026-05-13)
- Apply 070 via operator-boot runner; verify table exists, types correct
- Run `drizzle-kit pull` to regenerate `generated.ts` with new tables
- Upgrade `dockview` and `dockview-react` to 6.2.2 in `apps/operator/package.json`
- Verify dockview v6 breaking changes addressed:
  - Explicit CSS import (`import 'dockview-react/dist/styles/dockview.css'`) wired into ChromeShell
  - `TabGroupColor` → `DockviewTabGroupColor` if referenced anywhere
  - Theme class moved to root element
  - `getContextMenuItems` API present in 6.2.2 (verify in dockview-core source)
- Add `ResizeObserver` polyfill to `apps/operator/vitest.setup.ts` (jsdom doesn't ship it)
- Write `apps/operator/scripts/smoke-dockview.md` — manual test checklist
- Confirm `pgrep -af paperclip` workflow documented in phase plan
- Audit remaining ~10 `useQueryState` keys and finalize §5 table

**Acceptance:** migration applies on clean boot, `dockview-react` imports without runtime errors in a smoke component, vitest can mount a DockviewReact in jsdom.

**Risk:** very low. No user-visible changes.

### Phase 1 — Pi-tab dockview 5 → 6 (½ day)

**Scope:** smallest blast radius. Validates v6 against existing real usage.

- Update `PiTerminalsDock.tsx` for v6 API changes (mostly imports + CSS)
- Verify existing localStorage layouts rehydrate
- Add a FloatingGroup smoke test — drag a terminal tab outside its group → floating panel within window
- Run `apps/operator/scripts/smoke-dockview.md` against pi tab

**Acceptance:** all existing pi-tab interactions work; FloatingGroup confirmed working.

**Risk:** low. Pi tab is isolated, only used when opened.

### Phase 2 — Pi-tab persistence → PG (½ day + perf spike)

**Scope:** validate persistence contract before scaling.

- Implement `apps/operator/lib/dock-layouts.ts` with `getLayout / saveLayout / listLayouts / resetLayout`
- Add API endpoints (§4.9) in `apps/operator/app/api/_hono/dock-layouts.ts`
- Migrate `PiTerminalsDock` from localStorage to PG calls
- One-time client-side migration: read old `papercusp:pi-dock-layout:*` localStorage, write to PG, delete localStorage key
- **Performance spike:** 10 pi terminals open, drag/split/save/reload, measure drag latency, memory delta, mount time

**Targets:**
- Drag latency ≤ 16ms p95 (60fps interaction)
- Memory delta ≤ 80MB for 10 terminals
- Panel mount time ≤ 50ms p95

**If targets breach:** freeze at "Phase 1+2 only" — pi-tab on v6 + PG-backed layouts. Defer Phase 3+ until perf work splits into its own phase.

**Acceptance:** layouts roundtrip; webapp and desktop see same layout for same `(workspace, user)`; perf targets met.

**Risk:** medium. First PG-backed layout. Schema mistakes here cascade.

### Phase 3 — Dashboard internal dockify (1 day)

**Scope:** inside Dashboard tab, replace `react-resizable-panels` with nested DockviewReact. Top-level tab strip (Dashboard/Docs/VSCode/Pi/Design) stays as a normal tab strip.

- New `DashboardDock` component wrapping DockviewReact
- Register: `data:git`, `data:features`, `data:issues`, `data:agents`, `data:logs`, `data:chat`
- Each panel = thin wrapper around existing inner content (no logic changes)
- Layout name in PG: `'dashboard'` per `(workspace_id, user_id)`
- Default dashboard layout = today's split shape, expressed as logical layout JSON
- Remove `react-resizable-panels` from `HarnessDashboard.tsx`; keep dep for ProposalsPanel

**Paperclip pause window** required — phase touches `apps/operator/app/harness/HarnessDashboard.tsx` heavily.

**Acceptance:**
- All 5 panels render in expected starting positions
- User can drag any panel to a new position; reload restores
- FeaturePeekPanel drawer still triggers correctly (outside the dock)
- All existing keyboard shortcuts still work
- No regressions in feature/issue/git interaction flows

**Risk:** medium-high — touches the most-trafficked screen.


### Phase 4 — Selector relocation + per-panel phase + focusSlug (1 day)

**Scope:** harness selector chip moves to chat sidebar; `?phase=` becomes per-panel param; `?focusSlug=` introduced.

- New `HarnessSelectorChip` in `OperatorChatSidebar` (24px sub-row, header grows to ~90px)
- Chip drives `?focusSlug=` (new nuqs key)
- New `view:harness-overview` panel — phase tabs, status chip, project path, progress
- Migration 071 (`harness_phase_last_used`)
- Remove `.h-header` block from `HarnessDashboard.tsx`
- Per-panel `params.phase`; default `'staging'` falling back to `harness_phase_last_used` lookup
- All `?phase=` reads in HarnessDashboard refactored to read from focused panel's params
- Deep-link adapter: `?slug=X&phase=Y` → seed default layout with overview pinned to X@Y, strip keys

**Acceptance:**
- Two `view:harness-overview` panels, same slug, different phases, side-by-side works
- Switching chip changes default-for-new-panels but not open panels
- Reopening overview for a slug defaults to last-used phase
- Existing `/harness/sheets?phase=testing` bookmark hydrates correctly

**Risk:** medium — semantic shift from "one selected harness" to "default for new panels."

### Phase 5 — Top-level collapse + iframe portal + agent dispatch (2 days)

**Scope:** the largest visible change. Top-level tab strip disappears; everything is panels in one dock root. Iframe portal pattern lands. Agent dispatch actions ship in this phase as a hard dependency.

- One root `DockviewReact` in ChromeShell (conditioned on `/harness/*`)
- Default layout = §3.3 shape
- All former top-level tabs become panel types
- `ReactActivity`-based switching removed; replaced by dockview `keepAlive` settings per panel type
- Iframe portal infrastructure (§7) wired for `view:vscode`, `view:design` (iframe variant), `view:pi-terminals` xterm hosts, plugin iframes
- Agent dispatch actions (§9.1) implemented and tested
- `ui:get_state` extensions (§9.2)
- HUD overlay stripped per §3.5
- Brainstorm canvas stays overlay; launch button in chat sidebar
- Right-click context menu via `getContextMenuItems`: Close, Float, Move to group, Pin
- Tab-strip context menu: Close all, Close others, Split right
- Empty-group catalog: "+ Open panel" button shows registered panel types
- Cmd+K command palette adds "Open: <Panel Type>" entries
- Shift+Esc long-press (1s) hard-reset shortcut → reseeds default layout

**Paperclip pause window** required.

**Acceptance:**
- All formerly-top-level views reachable (catalog, command palette, default layout)
- Multiple harness-overview panels with different slugs supported
- VSCode iframe survives drag-reparent without reload
- Drizzle Studio survives drag-reparent
- Floating group works; clamps to viewport on reload (handles missing monitor)
- Layout corruption recoverable via Shift+Esc
- All agent actions in §9.1 functional via `ui:dispatch`

**Risk:** high — largest UX shift. Mitigation: per-turn commits, paperclip paused, smoke test after each significant change.

### Phase 6 — Plugin panels + pin actions + back/forward nav (1 day)

**Scope:** plugin contract extension and user-affordance polish.

- Plugin manifest schema gets optional `panels[]` (§8.1)
- Plugin host wires plugin panels into PANEL_REGISTRY at onLoad via `registerPanel`
- `dashboardTabs` deprecation warning (warn-only forever)
- `pluginTab.replaces` warn-and-ignore (§8.2)
- New panel types `pin:feature` and `pin:issue`
- Right-click → "Pin as panel" on feature/issue rows
- `useNavHistory` hook implementation
- Back/forward chevrons in panel tab chrome (only when `canBack || canForward`)
- Cmd+[ / Cmd+] dispatch to focused panel
- Docs panel wired to use `useNavHistory`
- VSCode panel optionally wired

**Acceptance:**
- Plugin panels appear in catalog, drag like built-ins
- Pinned feature/issue panels persist across reload
- Multiple pinned features side-by-side compare
- Cmd+[ / Cmd+] navigate Docs history; chevrons appear/disappear correctly
- History capped at 50; oldest entries dropped

**Risk:** low. Additive.

### Phase 6.5 — Onboarding (½ day, optional)

- One-time "Welcome to the new layout" tooltip on first dock render
- 3-step intro overlay: drag tab → split here → save layout
- Stored in `harness_dock_layouts` as a sentinel value or a separate `user_prefs` row

**Risk:** very low.

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Perf regression at scale (10+ panels) | M | H | Phase 2 spike with stop-gate; Phase 1+2 freeze if breached |
| Iframe state loss on drag | H without portal | H | Portal pattern (§7) mandatory in Phase 5 |
| Paperclip stomps Phase 3/5 edits | M | M | Explicit pause windows; per-turn commit + push |
| Layout JSON schema future churn | M | M | `schema_version` + migrators (§4.6) |
| Plugin late-register race | M | L | Hot-swap (§8.3) + 10s timeout fallback |
| Layout corruption (empty dock) | L | H | Seed default on miss (§4.5) + Shift+Esc reset (§10 Phase 5) |
| Agent UI dispatch missing in Phase 5 | M | H | Hard-required in Phase 5 scope, not deferred |
| Drawer × dockview drag conflict | M | M | Disable drag handles when drawer open (§7 nominal; verify Phase 5) |
| Deep-link bookmarks break | H | L | First-load adapter rewrites legacy URLs (§5) |
| vitest jsdom can't mount dockview | M | L | ResizeObserver polyfill in Phase 0 |

---

## 12. Decisions (resolved)

All open questions from v3/brief now resolved by user (2026-05-13):

| Decision | Outcome |
|---|---|
| Dock scope | `/harness/*` only; admin/settings/dev keep static layout |
| Iframe reparent | Portal pattern (Option B); no reload on drag |
| Back/forward | Per-panel, opt-in via `useNavHistory`; cap 50; Cmd+[/]; chevrons hidden when N/A |
| Brainstorm canvas | Stays overlay with launch button; not a panel |
| Cross-tab layout sync | Last-writer-wins per session; no Zero subscription |
| Selector chip placement | New 24px sub-row in chat sidebar; header grows to ~90px |
| WorkspaceSwitcher | Stays in ChromeShell top-level |
| Phase order | 0 → 1 → 2 → 3 → 4 → 5 → 6 → (6.5 optional) |
| Mobile fallback | Cut entirely, not tracked |
| `dashboardTabs` deprecation | Warn-forever, no hard break |
| Telemetry | Defer past v1 |
| Last-used phase | Yes, ship as table 071 in Phase 4 |
| Perf-replan target | If breached: freeze at Phase 1+2, perf work as own phase |
| v4 first vs implement-then-doc | v4 first (this doc) |
| Empty-state seed | Server seeds default layout JSON on PG read miss; never blank dock |

---

## 13. Effort estimate

| Phase | Effort | Cumulative |
|---|---|---|
| 0 — Pre-flight | 0.5d | 0.5d |
| 1 — Pi-tab v6 upgrade | 0.5d | 1.0d |
| 2 — PG persistence + perf spike | 0.5d | 1.5d |
| 3 — Dashboard internal dockify | 1.0d | 2.5d |
| 4 — Selector + per-panel phase + focusSlug | 1.0d | 3.5d |
| 5 — Root dock + iframe portal + agent dispatch | 2.0d | 5.5d |
| 6 — Plugin + pin + back/forward | 1.0d | 6.5d |
| 6.5 — Onboarding (optional) | 0.5d | 7.0d |
| Buffer for paperclip pauses, paperclip stomp recovery, surprises | 1.0d | 8.0d |

**Total: 8 days nominal, 9–10 days with realistic friction.**

---

## 14. Implementer notes

- Always `pgrep -af paperclip` before editing `apps/operator/app/harness/*`
- Per-turn commit + push (do NOT batch days of work)
- Use `mcp__pi__edit` with full strings; never regex-rewrite function arg lists (memory `[[no-regex-for-func-args]]`)
- Submodule discipline: migrations in `libs/papercusp/libs/db/sql/`; Hono routes in outer `apps/operator/app/api/_hono/`
- Operator boot auto-applies migrations (`instrumentation-node.ts`) — no manual `apply-NNN.sh` scripts
- Workspace `'default'` is text; user `'_local'` in loopback is text — column types text not uuid
- After migration 070, run drizzle regen so `harness_dock_layouts` types appear in `generated.ts`
- jsdom: add ResizeObserver polyfill before any dockview test runs
- dockview 6.2.2 needs explicit CSS import: `import 'dockview-react/dist/styles/dockview.css'` in ChromeShell
- Write large planning docs in chunks (this v4 was written in 5 chunks to dodge stream stalls in long sessions)

---

## 15. Out of scope (documented for clarity)

- Webapp duplicate at `libs/papercusp/apps/web/app/harness` — keep TS intact per memory `[[no-ts-deletion]]`, migrate separately
- ProposalsPanel's `react-resizable-panels` internal split — stays
- `/p-testing` shop prototype — different app tree
- claude-code IDE integration — unsupported per memory `[[claude-code-unsupported]]`
- Real-time cross-tab sync — documented non-goal

---

**End of v4.**
