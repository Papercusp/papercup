---
title: Dockview migration plan — v4 audit brief (handoff)
slug: dockview-migration-plan-v4-brief-2026-05-13
status: superseded
created: 2026-05-13
updated: 2026-05-30
owner: pandawamble@gmail.com
---

## Now

**State:** Status: v3 is at `apps/operator/docs/dockview-migration-plan-2026-05-13.md` (HEAD, 633 lines). This brief lists everything v4 needs to fix or add. Treat v3 as the structural baseline; rewrite into v4 by folding in the corrections + new feature below.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# Dockview migration plan — v4 audit brief (handoff)

Status: v3 is at `apps/operator/docs/dockview-migration-plan-2026-05-13.md` (HEAD, 633 lines). This brief lists everything v4 needs to fix or add. Treat v3 as the structural baseline; rewrite into v4 by folding in the corrections + new feature below.

## 1. Concrete errors in v3 (must fix)

### 1.1 `current_phase` column does NOT exist
v3 implies a single per-harness "current phase" pointer. Reality: `harness_phases` has composite PK `(harness_slug, phase)` — multiple rows per harness, no "current" column. Today the UI reads `phase` from the URL (`useQueryState('phase', parseAsStringEnum([...]).withDefault('staging'))` in `HarnessDashboard.tsx`). v4 should:
- Drop any "default to harness's current phase" language
- New `view:harness-overview` panels default `params.phase = 'staging'`
- Optionally add `last_used_phase` to a side table if "remember per-harness phase" is desired (call out as a Phase 4 decision)

### 1.2 URL state inventory in v3 is incomplete
v3 lists ~5 nuqs keys. Actual count in `HarnessDashboard.tsx` is **22+** `useQueryState` calls. Each needs explicit disposition. Categories:
- **Move to per-panel `params`**: `phase`, `panel`, `triage`, `gitCollapsed`, `editorMode`, `showTriage`
- **Move to per-panel transient state (not persisted)**: `peekFeature`, `peekIssue`, `hooks`, `intervene`, `expandedAgent`, etc.
- **Stay global (chrome-level)**: `slug` (deep-link compat), `focusSlug` (new — default for new panels), `layout` (which named layout), `focus` (which panel has keyboard focus)
- **Audit needed**: 10+ more not enumerated. v4 must include the full table.

### 1.3 MainPanel type values incomplete in v3
v3 lists ~6 main-panel values. Reality (from HarnessDashboard MainPanel union): 9+ — includes `brainstorm`, `proposals`, `git`, `dashboard`, `summary`, `insights`, `config`, `settings`, plus dynamic plugin tab IDs. The legacy aliases (`pi`, `docs`, `vscode`) are also routed through plugin tab replacement. v4's PANEL_REGISTRY must enumerate all of these.

### 1.4 Mount point named wrong (already fixed in v3 partially)
Confirmed: `apps/operator/app/_components/ChromeShell.tsx`. v3 has this right but a few sections still say "HarnessShell" — sweep and fix.

### 1.5 `react-resizable-panels` is in 2 places, not 3
Only `HarnessDashboard.tsx` and `ProposalsPanel.tsx`. v3 implies it's elsewhere. Removing it from HarnessDashboard does NOT orphan the dep — ProposalsPanel still uses it. State explicitly: dep stays until ProposalsPanel migrates (out of scope).

### 1.6 `ReactActivity` is React 19's `<Activity>`, not a custom component
Imported directly from `react`. Used in HarnessDashboard to keep tabs alive in `mode="hidden"`. v3 calls for "removing ReactActivity-based switching" — correct conceptually, but the rewrite must replace it with dockview's `keepAlive` semantics, not just delete it.

### 1.7 Migration number
Confirmed: **070**. (067/068/069 taken; 062 duplicate exists but unrelated.)

### 1.8 Column types
Confirmed: `workspace_id text`, `user_id text`. Not uuid. (workspace IDs are literals like `'default'`; user_id is `'_local'` in loopback dev.) v3 has this right — flag if anything regressed.

### 1.9 dockview v6 breaking changes
- CSS no longer auto-injects — explicit import required (`import 'dockview-react/dist/styles/dockview.css'`)
- `TabGroupColor` → `DockviewTabGroupColor`
- Theme class applied to root element, not via global stylesheet
- `contain: layout` removed from core CSS
- `getContextMenuItems` API (panel header right-click) — **verify presence in 6.2.2** before relying on it; v3 assumes it exists

### 1.10 OperatorChatSidebar header geometry
v3 cites "63px tall, 286px control row." These are this-session-accurate but should be marked "approximate, verify in Phase 4 design pass." Adding a HarnessSelectorChip means either shrinking Voice further or adding a second sub-row. **WorkspaceSwitcher is in ChromeShell at top-level, not in the sidebar** — v3 implies it's in the sidebar; correct that.

### 1.11 Brainstorm canvas is full-screen takeover
Not a normal panel — uses `brainstorm-full` CSS class to take over the entire viewport. v3 lists it as a regular panel type. v4 must decide: (a) keep as overlay outside the dock with a launch button, or (b) make it a panel that, when focused, applies a "maximize entire dock" CSS treatment. Recommend (a) — overlays are correct for full-screen modal-ish flows.

### 1.12 Plugin `dashboardTabs` field exists
Confirmed in plugin schema validator with `capability: 'ui:dashboard-tab'`. v3 calls it a deprecation alias — that's correct, but the deprecation timeline needs to be explicit. Either: warn forever (additive `panels: PluginPanel[]` superset), or hard-break in pre-alpha. Recommend the former — pre-alpha freedom doesn't require gratuitous churn.

### 1.13 `?slug=` deep-link compat: v3 is inconsistent
Some sections say "drop cleanly," others say "retain as fallback." Pick one. Recommend: keep `?slug=` as a hint that on first load, opens a default layout with one `view:harness-overview` panel pre-loaded for that slug. Drop it from the active-runtime URL once layout is hydrated.

## 2. Gaps v3 doesn't address (must add)

### 2.1 Per-tab forward/back navigation (NEW user requirement)
User asked for browser-like back/forward "scoped per top-level tab." After Phase 5 there are no top-level tabs — there are panels. Design:
- Each panel can opt into a `useNavHistory()` hook → maintains its own history stack stored in `params.history: { stack: string[], cursor: number }`
- Panel chrome renders back/forward chevrons when `history.stack.length > 1`
- Cmd+[ / Cmd+] keyboard shortcuts dispatch to the focused panel's history
- Panels without internal navigation (live-tailing logs, agents list) don't opt in and don't show buttons
- History entries are panel-internal route descriptors (e.g. for Docs panel: `{ doc: 'getting-started' }`); the panel's own component interprets them
- History survives layout save/restore (it's in `params`)
- Decision needed: cap history depth (suggest 50)
- Decision needed: should "Open in new panel" push history, or open a fresh panel? Recommend fresh panel.

### 2.2 Iframe reparent reload
Dockview unmounts/remounts the React component when a panel moves between groups. Iframes (VSCode/code-server, Drizzle Studio, plugin iframes) lose state on remount. v4 needs an explicit choice:
- **Option A (simpler)**: accept reload, document the limitation, warn user before drag of an iframe panel
- **Option B (correct)**: portal pattern — render iframe into a fixed off-DOM container, use a stable React portal to mount its DOM node into whichever dockview slot is active. ~80 lines, but reload-free.

Recommend B. Add to Phase 5 scope.

### 2.3 Plugin hot-swap when registry registers late
v3 mentions `MissingPanel` fallback when a panel type isn't registered yet but a layout references it. Missing: the **subscription mechanism** that re-renders the dock when `registerPanel(type, component)` is called later. Need:
- `PanelRegistry` exposes `subscribe(callback)` for late-arrival notifications
- `MissingPanel` subscribes; on registry change it triggers a re-render of itself (which now finds the real component)
- Timeout: if plugin hasn't registered after 10s, MissingPanel switches from "Loading…" to "Plugin not installed — remove panel?"

### 2.4 Per-panel keep-alive policy
Dockview supports `keepAlive: true|false` per panel. v4 must enumerate:
- **Keep alive**: Pi terminals (xterm state), VSCode iframe (editor state), Drizzle Studio, plugin iframes, brainstorm (if panelized)
- **Unmount when hidden**: Features/Issues lists, Git graph, Logs (re-mount is cheap, saves memory)
- **Decision per panel type** — bake into PANEL_REGISTRY metadata

### 2.5 Floating group default geometry
v6's `addFloatingGroup` needs initial x/y/w/h. v4 specs:
- Default: 480×360, positioned 80px from cursor at drag-release
- On hydrate: clamp to viewport (handle missing monitors / smaller window than at save-time)
- Persist position + size in layout JSON

### 2.6 Authorization on layout PUT
Loopback dev: no auth — `'_local'` user. Webapp (Plan 4): must verify `user_id` matches authenticated user AND user has access to `workspace_id`. v4 spec: `requireAuthForLayouts(req)` returns `{ userId, workspaceId }` or 403.

### 2.7 Dock-mount scoping in ChromeShell
DockviewReact must NOT render on routes like `/settings/billing`, `/dev/builds`, `/admin/*`. v4 spec: ChromeShell renders dock only when pathname matches `/harness/*` (or whatever the harness route prefix becomes). Other routes get the existing static layout.

### 2.8 vaul Drawer × dockview drag interaction
FeaturePeekPanel and IssueDetail are vaul drawers — they lock body scroll and capture pointer events. v4 spec: when any drawer is open, dockview's drag handles are disabled (CSS `pointer-events: none` on `.dv-tab-handle` while `[data-vaul-drawer-open]` is on body). Alternative: drawer is dismissed on drag-start. Recommend the disable approach.

### 2.9 Drizzle schema regen step in Phase 0
After migration 070 applies, `drizzle-kit pull` (or equivalent) must regenerate `generated.ts` so the new `harness_dock_layouts` table is typed. v3 doesn't list this explicitly. Add as Phase 0 step.

### 2.10 Voice-mode integration
User: "show me X" with multiple panels open and no obvious target. v4 spec: voice handler reads `focusSlug` (or focused panel's slug if it carries one) as the default scope, but explicit user phrasing ("show sheets features") overrides. Voice "open features panel" creates a new panel — does NOT replace the focused one.

### 2.11 Cross-tab sync of layouts
If user has the operator open in two browser tabs (or webapp + desktop), edits in tab A should propagate. v4 decision:
- **Option A**: layouts are intentionally tab-local — last-writer-wins on close; reload to see other tab's changes. Simplest.
- **Option B**: subscribe via Zero (`harness_dock_layouts` added to Zero schema). Real-time sync. More work, also more confusing UX (your layout shifts while you're using it).

Recommend **A** for v1, callable as "Layout follows session, not realtime." Add as decision §D.

### 2.12 Acceptance criteria gaps
v3's per-phase acceptance lists pass/fail for layout behavior but skip:
- Accessibility: keyboard nav between panels (Tab/Shift+Tab), focus visible, panel headers as proper landmarks
- Screen-reader announce when active panel changes
- Reduced-motion respect for floating-group animations
- Performance budget (TTI on first dock paint, mem ceiling for N=10 panels)

Add explicit non-functional acceptance to each phase.

### 2.13 Onboarding for the new UX
Users will be surprised the first time their dashboard becomes drag-rearrangeable. v4 should add a Phase 6.5: one-time "Welcome to the new layout" tooltip on first dock render, with "Show me how" link to a 3-step intro overlay (drag this tab → split here → save layout).

### 2.14 Plugin onLoad ordering
If a plugin's `onLoad` calls `registerPanel(...)`, that must happen before dock hydration tries to instantiate any of its panels. If hydration races, the hot-swap from §2.3 handles it. v4 should still spec: plugin loader fires synchronously on app boot if possible; dock hydration is async and waits up to 500ms for first plugin-batch to register before instantiating MissingPanels.

### 2.15 Empty-state UX
First-time user, no layout in PG: what do they see? v4 spec: shipped-with-app default layout JSON (~Section 4.2 in v3) seeded on first PG read miss. NOT an empty dock — that's user-hostile. Also: a "Reset to default" item in the layouts menu.

### 2.16 Test plan
v3's testing section is thin. v4 needs:
- Unit: dock-layouts persistence (round-trip, multi-user isolation, name uniqueness, schema version fallback)
- Integration: dockview-react in jsdom requires `ResizeObserver` polyfill — add to vitest setup
- E2E (playwright): drag-out floating, persist-reload, cross-machine sync (loopback simulated), iframe panel survives reparent (after §2.2 fix)
- Manual smoke per phase — write `apps/operator/scripts/smoke-dockview-phaseN.md` lists

### 2.17 Migration-runner is already automatic
v3 may imply manual `apply-070.sh`. Reality: this session shipped the operator-boot migration runner (`apps/operator/instrumentation-node.ts` calls `applyPendingMigrations`). Migration 070 applies automatically on next operator boot. State this clearly so the implementer doesn't write an apply script.

### 2.18 Paperclip pause windows
Phases 3 and 5 edit `apps/operator/app/harness/*` heavily. Paperclip historically stomps these. v4 must:
- Tell user to pause paperclip explicitly before Phase 3 and Phase 5
- Implementer checks `pgrep -af paperclip` before each editing session
- Per-turn commit + push to make stomps recoverable

### 2.19 Telemetry (optional)
Track panel-open / panel-close / panel-float / layout-save events to tool_invocations or a new lightweight table. Useful for understanding which panels users actually engage with. Not blocking — mark optional in v4.

### 2.20 Mobile fallback
v3 includes a mobile phase. Recommend cutting unless explicitly requested: pre-alpha desktop-only is OK, and the dockview model doesn't fit small viewports. Mark as out-of-scope or much-later phase.

### 2.21 Performance threshold replan-target
v3 says "replan before Phase 3 if metrics breach." Missing: replan to what? v4 spec: if 10-pi-terminal smoke breaches 16ms drag latency, 80MB delta, or 50ms panel mount, fall back to "Phase 1+2 only, defer Phase 3+ until perf work."

### 2.22 Plugin tab legacy alias migration
`pluginTab.replaces: 'pi' | 'docs' | 'vscode'` exists today. After Phase 5, top-level tabs don't exist. v4 must spec: `replaces` becomes meaningless; plugins that set it get logged-warn-and-ignore, with the panel still registering as a normal `plugin:<id>` panel.

### 2.23 dockview keep-alive vs offscreen iframe
If iframe panels use the §2.2 portal pattern, dockview keep-alive setting becomes irrelevant for them (iframes stay mounted regardless). Spec this explicitly: portal-hosted panels override keep-alive.

### 2.24 Hard-reset shortcut details
v3 has `Shift+Esc` long-press (1s) for layout corruption recovery. Missing: what the reset target is. v4 spec: resets to the seeded default layout (§2.15), keeps the `harness_dock_layouts` row but overwrites `layout_json`. Logged for debugging.

### 2.25 Default layout JSON
v3 describes the default layout in prose. v4 should include the actual JSON snippet so the implementer can paste it. ~40 lines of dockview JSON.

## 3. Things v3 got right (preserve)

- 7-phase delivery structure, Phase 0 as pre-flight
- Logical schema between dockview JSON and PG, with adapter at the boundary
- `MissingPanel` fallback (just need §2.3 details added)
- `getUserIdForLayouts` resolver pattern
- `schema_version` on the layout row
- Operator runs migrations on boot (this session shipped that)
- `?focusSlug=` semantic separation from `?slug=`
- Floating groups are in-process; popout would be a separate JS heap
- Plugin contract gets a `panels[]` superset; `dashboardTabs` deprecates warn-only
- Each phase is an isolated revertable PR
- Per-turn commits during implementation (rust-port precedent)

## 4. Recommended phase order revision

v3 order: Phase 0 (pre-flight) → 1 (pi-tab v6 bump) → 2 (PG-backed layouts) → 3 (dashboard internals) → 4 (selector move) → 5 (top-level dock collapse) → 6 (plugin contract) → 7 (mobile).

Suggested v4 order:
- **Phase 0**: pre-flight (migration 070, runner verify, dockview v6 POC verifying CSS imports + getContextMenuItems presence, drizzle regen, vitest ResizeObserver polyfill, paperclip-pause documentation)
- **Phase 1**: pi-tab dockview 5→6 upgrade (smallest blast radius — validates v6 against existing real usage)
- **Phase 2**: pi-tab persistence localStorage→PG (validates the contract)
- **Phase 3**: HarnessDashboard internal dockify (Features/Issues/Git/Agents/Logs become drag panels; top-level tab strip stays)
- **Phase 4**: Harness selector move + per-panel `params.phase` migration + `?focusSlug=` introduction
- **Phase 5**: Top-level tab collapse into root dock + ReactActivity removal + iframe portal pattern (§2.2)
- **Phase 6**: Per-panel back/forward (§2.1) + plugin contract `panels[]` superset + `replaces` deprecation
- **Phase 6.5**: Onboarding tooltip + telemetry (optional)
- **Phase 7**: (cut — mobile fallback deferred)

Estimated total: **9–10 days** (up from v3's 8). Per-panel back/forward adds ~1 day; portal pattern + onboarding add ~half-day each.

## 5. Decisions awaiting user input (must include in v4 §D)

1. Layout sync: tab-local last-writer-wins (recommended) vs Zero-subscribed realtime
2. `dashboardTabs` deprecation timeline: warn-forever (recommended) vs hard-break now
3. Iframe reparent: accept-reload vs portal pattern (recommended)
4. Back/forward history depth cap (suggest 50)
5. Brainstorm canvas: stays overlay (recommended) vs becomes panel with maximize behavior
6. Last-used phase per harness: add side table (yes/no)
7. Telemetry table: ship with v1 (yes/no)
8. Mobile phase: include or defer (recommend defer)
9. Workspace switcher placement after sidebar selector chip added (stays in ChromeShell vs moves into sidebar)
10. Default layout content: confirm Section 4.2 shape, or pick alternative

## 6. Implementer notes (carry forward from v3, augment)

- Always run `pgrep -af paperclip` before editing `apps/operator/app/harness/*`
- Per-turn commit + push (do NOT batch days of work)
- Use `mcp__pi__edit` with full strings; never regex-rewrite function arg lists (memory: no-regex-for-func-args)
- Submodule discipline: migrations live in `libs/papercusp/libs/db/sql/`; Hono routes live in outer `apps/operator/app/api/_hono/`
- Operator boot auto-applies migrations (no manual apply scripts)
- Workspace `'default'` is text; user `'_local'` in loopback is text — column types text not uuid
- After migration 070, run drizzle regen so `harness_dock_layouts` types appear in `generated.ts`
- jsdom: add ResizeObserver polyfill to vitest setup before any dockview test runs
- dockview 6.2.2 needs explicit CSS import: `import 'dockview-react/dist/styles/dockview.css'`

## 7. What NOT to change from v3 unless explicitly told

- The PANEL_REGISTRY shape (component-per-type)
- The 3-listener pattern for layout-change persistence (onDidLayoutChange + onDidAddPanel + onDidRemovePanel)
- The `harness_dock_layouts` table primary key shape `(workspace_id, user_id, layout_name)`
- The transient `?focus=panel:<id>` URL key for keyboard-focused panel
- Per-phase revert strategy (each PR independently revertable; migration 070 is additive and safe to leave on rollback)

---

**End of brief.** v4 implementer: read v3 as the structural skeleton, then apply each §1 correction and each §2 gap as edits/additions, then expose the §5 decisions. v3 file is at HEAD; this brief is at the same docs directory.
