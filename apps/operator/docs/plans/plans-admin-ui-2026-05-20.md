---
title: Plans admin tab — browse and edit the plan system from the operator
slug: plans-admin-ui-2026-05-20
created: 2026-05-20
updated: 2026-05-21
status: shipped
owner: aviynw3@gmail.com
---

# Plans admin tab

A human-facing UI for the markdown-canonical plan system defined by
[`agent-plan-tracking-2026-05-20`](./agent-plan-tracking-2026-05-20.md).
Agents browse plans through the `plans:*` MCP surface; this is the
equivalent surface for the human — a new **Plans** tab under the
operator's `/admin` route. It is the *visible projection* of the same
tools, not a second way into the data.

## Now

**State:** Complete — all 25 items `done`. Phases 0–3 shipped and
verified live in the desktop app (Vite `:3055` + Hono `:3070` + Tauri
shell). The last external blocker is gone: `agent-plan-tracking`
Phase 5 shipped `plans:set-content` + `plans:set-frontmatter` +
`plans:get`'s `contentHash` (that plan's P-501–P-504), so P-301
(raw-prose Edit save, CAS-guarded) and P-302 (legacy-conversion
triage) are now live — both verified end-to-end through the real UI:
a raw edit Saved through `set-content` and persisted; a legacy plan
ratified in triage and promoted through `set-frontmatter`. P-305
closed.

The Plans tab is dual-homed for the in-flight Next→Vite migration —
both `app/admin/plans/page.tsx` (Next) and
`operator-vite/src/routes/admin/plans.tsx` (TanStack Router) exist, so
the tab survives Phase H (D-010).

**Next:** nothing — the plan is done. Q3 (git history as a `plans:*`
tool) was resolved 2026-05-21: `plans:history` + `plans:diff` shipped,
backed by the same shared helper the UI route now thin-wraps. Standing
follow-up if wanted: commit `app/admin/plans/` (still untracked).

## Background

The companion plan, `agent-plan-tracking-2026-05-20`, builds a
markdown-canonical plan format plus a `plans:*` tool surface
(`list` / `get` / `items` / `search` reads; `new` / `set-status` /
`set-now` / `add-decision` / `add-item` assisted writes; `lint`). Plans
are markdown files in `apps/operator/docs/plans/`, canonical on disk.
That plan is `status: shipped` — all ten tools are registered and live.

That plan serves *agents*. Humans currently have nothing — they open
the `.md` files in an editor. This plan builds the human surface: a
**Plans** tab beside `run`, `testing`, `features` under `/admin`.

The design was settled over a review thread that produced three
non-obvious conclusions, recorded as decisions below: (1) a two-pane
layout — not three — because a structured middle pane just re-rendered
the markdown a second time; (2) in-editor interactivity comes from
Lute renderer hooks, not DOM patching; (3) structured actions are
vditor toolbar buttons, not a React chrome strip. A second review pass
corrected a stale dependency framing and one transport assumption —
see D-009 and the Dependencies section.

## Goals / non-goals

### Goals

- **One place to browse every plan** — the dispersal problem
  `agent-plan-tracking` fixes for agents, fixed for humans too.
- **Read at a glance** — plan status, item counts by `effectiveStatus`,
  the `## Now` `Next:` line, without opening the file.
- **Edit without hand-typing markdown** — flip a status, add a
  decision, add an item, rewrite the `## Now` block via UI affordances
  that call the assisted-write verbs.
- **The markdown stays the visible truth** — the editor shows the
  canonical file, not a synthesized projection of it.
- **Lean on vditor** — use vditor's own extension points wherever they
  exist; only wrap what vditor genuinely cannot do.

### Non-goals

- A second source of truth. The UI never reads or writes the
  filesystem directly — only the `plans:*` surface (D-002).
- A Linear/Jira board — no velocity, burndown, swimlanes, charts.
- Live multi-user collaboration. The lock banner is the concurrency
  UX; there is no CRDT, no presence (D-008).
- A mobile layout. `/admin` is desktop-only.
- Re-implementing markdown editing, outline, undo, find — all vditor
  native (see §"Integration architecture", Group 5).

## Routes & layout

New route at `apps/operator/app/admin/plans/`, sibling to `run/`,
`testing/`, `features/`. A single Next.js route with a nuqs-driven
client shell mirroring `app/admin/testing/TestingClient.tsx`; views
switch on a `view` URL param, not separate filesystem routes (D-006).

- `view=list` (default) — the browser: rail + detail.
- `slug=<plan>` — a plan open in the two-pane detail view.
- `view=inbox` — flat `needs-human` items across all plans.
- `view=actionable` — flat actionable items across all plans.
- `view=triage` — the legacy-conversion screen.

Two-pane detail layout — rail + decorated vditor. No structured middle
pane (D-001):

```
┌──────────────┬──────────────────────────────────────────────┐
│  Plan rail   │  Pinned "Now" strip  ·  lock / lint banners   │
│              ├──────────────────────────────────────────────┤
│  filters     │  Vditor toolbar  (defaults + custom buttons)  │
│  search      ├──────────────────────────────────────────────┤
│  inbox badge │                                              │
│  plan list   │  Vditor  (outline='left', IR mode)            │
│              │  · status tokens → click to flip             │
│              │  · P-NNN / D-NNN refs → click to scroll      │
│              │  · effective-status badge inline             │
└──────────────┴──────────────────────────────────────────────┘
```

## Integration architecture

The vditor strategy, from the research pass on vditor 3.11.2. Every
piece of functionality falls into one of five groups.

| Group | Mechanism | Items |
|---|---|---|
| 1 — In-editor decorations | Lute renderers: `Vditor.preview({ renderers })` for read mode (documented, zero-risk); `vditor.vditor.lute.SetJSRenderers({ renderers: { Md2VditorIRDOM } })` for edit mode | status pill, effective-status badge, `P-NNN`/`D-NNN` refs |
| 2 — Vditor extension points | Custom toolbar buttons (`IMenuItem.click(event, vditor)`); `keydown` hook; native `setValue` / `disabled()` / `enable()` | +Decision / +Item / Set Now / Lint / History buttons; read/edit toggle; editor shortcuts; value sync |
| 3 — Chrome wraps | React components beside the editor — vditor offers nothing | "Now" hero strip, lock banner, lint banner, jump-to-item typeahead, status-flip popover |
| 4 — Rail & routes | React + nuqs, no vditor | plan list, filters, search, inbox, actionable, triage |
| 5 — Vditor-native, untouched | — | markdown render, IR preview, `outline='left'`, default toolbar, undo/redo, Ctrl-F find, cursor/scroll/focus, dark theme + KaTeX + hljs |

Decoration mechanism (Group 1): a Lute `renderCodeSpan` hook emits
`<code data-plan-status="todo">` for tokens matching the status enum;
`renderListItem` emits `<li data-plan-item="P-NNN" data-blocked-by="…">`
and appends the effective-status badge when the parsed model says
`effectiveStatus ≠ storedStatus`; `renderText` wraps `P-NNN`/`D-NNN`
tokens in `<a data-plan-ref>`. One delegated `click` listener on the
editor element handles all three. Read mode uses the documented static
`Vditor.preview({ renderers })`; edit mode registers the same renderers
into the `Md2VditorIRDOM` pipeline slot on the instance's Lute object.

The existing `apps/operator/app/_components/MarkdownEditor.tsx` wrapper
is reused unmodified (D-005); the Plans tab adds a thin `PlanEditor`
component around it that supplies the renderers, the custom toolbar
buttons, and the delegated listener.

## Data flow

- `plans:*` are `defineTool` agent-tools; their only HTTP projection is
  the superuser-bearer-authed MCP endpoint, which a browser admin
  client cannot present a token for. So the Plans tab calls thin
  `/api/admin/plans/*` Next.js route handlers that invoke the `plans:*`
  endpoints **in-process** under the admin principal — the same pattern
  every existing `/admin` tab uses (`/api/admin/llm-tests/*`,
  `/api/admin/testing/*`). This does not weaken D-002: the route
  handler still reaches the data only through `plans:*`, never the
  filesystem. See D-009.
- Writes run under the admin principal (the `/admin` route is
  loopback/admin-gated). Each write verb owns its `locks:acquire`
  contract internally; the UI does not manage locks — it only *reads*
  `locks:queue` to render the lock banner.
- Every assisted write returns the full new markdown; the `PlanEditor`
  pushes it through the wrapper's existing value-sync effect
  (`setValue` with cursor/scroll preservation). No optimistic patching.
- v1 is request/response: fetch-on-focus, refetch-after-write, manual
  refresh. No SSE/live-sync (D-008).
- Failure handling: every `plans:*` call can fail — a lint rejection, a
  held lock, a route-handler/operator error. The UI surfaces each
  inline and never leaves a half-written file: a lint rejection shows
  in the lint banner, a held lock in the lock banner, a transport error
  as a dismissible toast with retry. Assisted writes are atomic
  server-side (the verb's `locks:acquire` + write), so a failed call
  changes nothing on disk.
- The one surface with no `plans:*` endpoint is git history (`P-303`);
  v1 uses a small operator route handler running `git log` — see Q3.

## Dependencies on agent-plan-tracking

`agent-plan-tracking-2026-05-20` **shipped 2026-05-20** — `status:
shipped`, all ten `plans:*` tools registered and live (P-110 and P-208
both `done`). Phases 1 and 2 of this plan are therefore unblocked
today; nothing gates them.

Two earlier-suspected asks turned out already satisfied — verified in
source, not assumed:

- `plans:list` already returns `itemCounts` keyed by `effectiveStatus`
  (`list.ts`), so the rail's inbox/actionable badges derive client-side
  (`needs-human > 0`; effective-`todo > 0`) — no new field.
- `plans:get` already returns each item with its `lineNumber`
  (`parser.ts` stamps it, `get.ts` passes it through) — scroll-to-item
  needs nothing new.

**One genuine gap remains:** there is no `plans:write-raw` verb. The
assisted writers (`set-status`, `set-now`, `add-decision`, `add-item`)
cannot touch free-prose sections like `## Background`. Raw-prose Edit
mode (Phase 3, `P-301`) needs that verb filed as a new item in
`agent-plan-tracking`. If it is not added, `P-301` is dropped and the
UI stays structured-edits-only (see Q2).

## Phase 0 — Spike & scaffold

Neither item needs the `plans:*` tools — both can start immediately.

- **P-001** `done` **Spike: GREEN.** Drove inline against the live
  `PlanEditor` in `/admin/plans` (no separate `editor-demo` run
  needed). Reached the `Vditor` instance via React-fiber walk on
  `MarkdownEditor`'s hook #1 (the `useRef<Vditor>`), called
  `inst.vditor.lute.SetJSRenderers({ renderers: { Md2VditorIRDOM:
  { renderCodeSpan: (n, entering) => entering ? ['<code
  data-pc-spike="x">', 0] : ['</code>', 0] } } })`, then forced an IR
  re-spin via `inst.setValue(getValue() + '\n').setValue(getValue())`.
  Result: renderer-invocation counter went 0 → 2, `data-pc-spike`
  reached the live DOM, vditor 3.11.2. D-003's primary path is
  confirmed; the read-mode-only fallback is NOT needed. P-202 / P-203
  unblocked.  → D-003
- **P-002** `done` Scaffold shipped at
  `app/admin/plans/{page.tsx, PlansClient.tsx, plans.css}`. nuqs view
  enum (`list / inbox / actionable / triage`), `slug`, and `q` URL
  keys wired via `useQueryState`. Mirrors `admin/testing/`.
- **P-003** `done` `PlanEditor.tsx` wraps `MarkdownEditor` for edit
  mode and `MarkdownPreview` for read mode (D-005 — wrapper reused
  unmodified bar an additive `onInstance` prop on `MarkdownEditor`).
  `PLAN_TOOLBAR` config in place.  → D-005

## Phase 1 — Read-only browser

Shippable as a standalone increment (see Q4); fully unblocked.

- **P-101** `done` Read client hooks (`fetchPlanList` / `fetchPlan` /
  `fetchPlanItems` / `searchPlans` plus `usePlanList` / `usePlan` /
  `usePlanItems` / `usePlanSearch`) in `plans-api.ts`. Server proxy at
  `lib/endpoint-route/routes/admin/plans.ts` dispatches both `GET`
  reads (via `bodyFromSearchParams`) and `POST` writes through
  `handleHttpToolRequest` under the admin principal.  → D-009
- **P-102** `done` `PlanRail.tsx` fed by `usePlanList`; renders status
  pill, per-status item-count chips (`needs-human`, `wip`, `blocked`,
  `todo`, `done`), `Next:` line, `updated` date. Active-first sort
  with `updated` as secondary key.  blocked-by: P-101, P-002
- **P-103** `done` `PlanFilters.tsx` exposes all seven filters as
  separate nuqs keys — status (`pStatus`), date window (`pDate`:
  today / 7d / 30d), owner (`pOwner`), archived (`pArchived`),
  hide-legacy (`pHideLegacy`), has-needs-human (`pInbox`),
  has-actionable (`pActionable`); `PlanRail` reads the same keys for
  client-side filtering. Date filtering uses the shared
  `withinDateWindow` predicate (unit-tested); the owner dropdown is
  populated from the plan list's `owner` field (added to
  `plans:list`'s `ListRow` — frontmatter `owner` was already parsed)
  and only renders when ≥2 distinct owners exist.  blocked-by: P-102
  → D-006
- **P-104** `done` `PlanSearchResults.tsx` — debounced input (250 ms),
  six scope chips (`all / title / now / items / decisions / prose`),
  results with per-match snippets, click opens plan. State preserved
  in `q` + `qScope` nuqs keys.  blocked-by: P-101
- **P-105** `done` `PlanDetail.tsx` — two-pane shell (`DetailShell` +
  `pc-plan-editor-scope`) with `PlanEditor` in read mode by default
  (D-007). Header with title + back button; loading / error / not-
  found states; `data.legacy` banner.  blocked-by: P-101, P-003  → D-001
- **P-106** `done` Read-mode decorations — status pill, effective
  badge, `P-NNN`/`D-NNN` refs via `Vditor.preview({ renderers })`.
  blocked-by: P-105  → D-003
- **P-107** `done` `NowHero` component in `PlanDetail.tsx` renders the
  parsed `data.now.state` + `data.now.next` lines above the editor
  with `.pc-now-hero__kicker`.  blocked-by: P-105
- **P-108** `done` `PlanItemsList.tsx` — flat cross-plan aggregation
  for `view=inbox` (`plans:items { needsHuman: true }`) and
  `view=actionable` (`plans:items { actionable: true }`); items grouped
  by plan slug; click navigates to detail.  blocked-by: P-101
- **P-109** `done` Jump-to-item typeahead above the editor.
  blocked-by: P-106
- **P-110** `done` **Verify**: drove `/admin/plans` against all 66
  real plans via the `tauri-agent-tools` bridge — rail rendered 66
  rows from the live `plans:list`, status/legacy filters bound to
  nuqs and refilter correctly (`pStatus=active` → 52 rows;
  `pHideLegacy=true` URL-tracked), Inbox view rendered `Needs human`
  header with empty state, Actionable view rendered 15 items from
  this plan with a 31-row group structure, cross-plan `plans:search`
  for "vditor" returned 5 scored hits with snippet matches in
  decisions scope, detail view opened with the live `plans:get`
  payload (Now hero strip 1324 bytes, 29 `[data-plan-status]` pills
  from P-106, 103 `[data-plan-ref]` cross-refs, 25 `[data-plan-item]`
  anchors), a ref click on `P-106` scrolled the target into viewport
  and applied `.pc-plan-highlight`, P-109 typeahead resolved `P-204`
  to the right item and scrolled to it, **zero console errors**.

## Phase 2 — Structured writes

- **P-201** `done` `plans:*` write client hooks — `set-status` /
  `set-now` / `add-decision` / `add-item` via the `/api/admin/plans/*`
  route handlers.  → D-009
- **P-202** `done` Edit-mode decorations via the proven IR-renderer
  path: `MarkdownEditor` gained an `onInstance` callback; `PlanEditor`
  uses it to call `inst.vditor.lute.SetJSRenderers({ renderers: {
  Md2VditorIRDOM: ... } })` with a `renderCodeSpan` that emits
  `<code data-plan-status="X" class="pc-plan-status pc-plan-status--X">X</code>`
  for status-enum tokens (with `WalkSkipChildren`) and falls through to
  vditor's default for non-status spans (with `WalkContinue`). Scoped
  the existing pill CSS to `.vditor-ir code.pc-plan-status` so edit-
  mode pills look identical to read-mode. The same delegated click
  handler is attached to the IR pane element so P-203 works in edit
  mode too. Verified live: 29 pills decorated in edit mode (matching
  read-mode count), 5 distinct statuses, identical visual.  blocked-by:
  P-201, P-106  → D-003
- **P-203** `done` Status-flip popover. New `PlanStatusPopover.tsx` —
  fixed positioning anchored to the clicked pill's bounding rect; six
  buttons (todo / wip / blocked / needs-human / done / dropped) calling
  `plans:set-status`. `resolveItemId(target)` walks up to the parent
  `<li>` and reads either `data-plan-item` (read mode) or the leading
  `<strong>P-NNN</strong>` (edit mode IR). Esc and outside-click close
  it. Verified live: clicked P-002's `todo` pill → popover opened with
  kicker "P-002" + correct current status; clicked `wip` → server set
  status → plan refetched → pill re-rendered as `wip`; flipped back to
  `todo` to leave the plan file unchanged.  blocked-by: P-202
- **P-204** `done` Structured-action chrome — +Decision, +Item, Set Now
  → modal composers → `plans:add-decision` / `add-item` / `set-now`.
  Ships in read mode as a React strip (D-004); vditor-toolbar variant
  follows once Edit mode lands (P-202+).  blocked-by: P-201  → D-004
- **P-205** `done` Lock-state banner — `usePlanLock` polls
  `locks:queue` for the open plan's path (30s + focus +
  visibilitychange); `LockBanner` shows holder / intent / TTL. While a
  lock is held the editor is forced read-only **even in edit mode**
  (`readOnly={!editing || locked}` in `PlanDetail`) — the draft is
  preserved so editing resumes intact on release; Save stays disabled.
  Verified live with a real `locks:acquire` on the plan file: in
  `pane=edit` the editor rendered `.vditor-reset` (read-only preview),
  not `.vditor-ir`, banner + disabled Save shown.  blocked-by: P-105
- **P-206** `done` Lint banner — run `plans:lint` after each write and
  on focus; click a warning to scroll to the offending item.
  blocked-by: P-201
- **P-207** `done` **Verify**: full Phase 2 surface verified live in
  the desktop app. P-204 React-strip — Set Now / + Decision / + Item
  all open `.pc-plan-dialog` modals with proper fields and Esc-close.
  P-205 lock banner correctly hidden with no concurrent lock holder.
  P-206 lint banner correctly hidden (plan in clean-70 bucket). P-203
  status-flip — opened popover on P-002, clicked `wip`, server set the
  status, plan refetched, pill re-rendered as `wip`; flipped back to
  `todo` to leave the file unchanged. P-202 edit-mode decorations
  cross-verified: 29 pills present in IR edit mode, 5 distinct
  statuses, visual identical to read mode.

## Phase 3 — Prose editing, triage, polish

- **P-301** `done` Raw-prose Edit mode — read/edit toggle (`pane` nuqs
  key), draft buffer, Save through `plans:set-content { slug, content,
  expectedHash }`, the CAS `{ error: 'stale' }` path wired to
  `PlanConflictModal`, structured-action lockout while editing (D-007).
  The `plans:set-content` verb shipped as `agent-plan-tracking` Phase 5
  P-501; `plans:get` now returns `contentHash` (P-503) as the CAS
  baseline. Verified live in the desktop app: opened a plan in edit
  mode, edited via vditor, Save round-tripped through `set-content` and
  returned to read mode, the edit landed on disk.
- **P-302** `done` `view=triage` — `PlanTriage`: a table of the
  still-legacy plan files with a slug-derived proposed frontmatter
  mapping (`title` / `status` / `created` / `owner`), per-row edit +
  ratify checkboxes, and a submit that calls `plans:set-frontmatter`
  per ratified row with per-row result. The `plans:set-frontmatter`
  verb shipped as `agent-plan-tracking` Phase 5 P-502 — named
  `set-frontmatter`, **not** `promote` (`plans:promote` is an unrelated
  coordination tool, see D-011). Verified live: ratified a legacy plan
  in the triage screen, submitted, the row promoted out of the legacy
  list and the file gained a valid frontmatter block. Not a closer for
  `agent-plan-tracking` P-303 — that shipped light-touch and most
  fragment families remain unconverted; this is the ongoing conversion
  tool.  blocked-by: P-201
- **P-303** `done` Git-history strip + diff modal (operator route
  handler running `git log --follow` / `git diff`).  blocked-by: P-105
- **P-304** `done` Keyboard shortcuts — rail/route nav via a
  document-level handler (`/`, `J/K`, `gL/gI/gA`, `Esc`); editor-
  context shortcuts via vditor's `keydown` hook land with P-202+.
  blocked-by: P-105
- **P-305** `done` **Verify**: drove the full Phase 3 surface live in
  the desktop app. P-301 — edited a plan's prose in raw Edit mode,
  Save round-tripped through `plans:set-content` (CAS + lint passed),
  returned to read mode, the change persisted to disk. The set-content
  verb was also exercised directly for its stale (wrong `expectedHash`)
  and `lint_failed` (missing `## Now`) rejection paths. P-302 — ratified
  a legacy plan in the triage screen and promoted it; `plans:set-frontmatter`
  wrote a valid frontmatter block and the plan dropped out of the
  legacy list. Keyboard shortcuts (P-304) verified in earlier rounds.
  blocked-by: P-301, P-302, P-304

## Verification

`P-110`, `P-207`, `P-305` are real items, done before the next phase
starts. Overall acceptance: a human opens `/admin/plans`, finds any
plan, reads its current state at a glance, flips an item's status, and
appends a decision — without ever editing raw markdown or touching the
filesystem. Phase 1 alone must be independently shippable and useful
(Q4).

## Decisions

### D-001 — Two-pane layout, no structured middle pane
Date: 2026-05-20
Decision: The detail view is rail + decorated vditor. An earlier design
had a third, middle pane rendering items/decisions as structured
widgets. It was cut: vditor's IR mode already renders the items as a
list, and Group-1 decorations make them interactive in place. A middle
pane would render the same structured content a second time — a
synthesized projection drifting from the canonical markdown.

### D-002 — UI goes through `plans:*` only, never the filesystem
Date: 2026-05-20
Decision: All reads and writes go through the `plans:*` endpoint
surface. The UI never reads `apps/operator/docs/plans/` directly.
Reading the filesystem would re-create, on the human side, exactly the
dispersal the companion plan exists to remove, and would let the UI
drift from what agents see.

### D-003 — In-editor decorations via Lute renderers
Date: 2026-05-20
Decision: Decorations use Lute renderer hooks — the documented static
`Vditor.preview({ renderers })` for read mode, and
`vditor.vditor.lute.SetJSRenderers({ renderers: { Md2VditorIRDOM } })`
for edit mode, registered on the instance's Lute object. Not the
`preview.renderers` option (ambiguous whether it reaches the IR
pipeline). If the P-001 spike shows the `Md2VditorIRDOM` slot does not
re-apply on re-spin, the fallback is **not** a MutationObserver
(re-running decoration on every editor mutation is a perf and
correctness risk): instead, keep inline decorations read-mode-only —
the documented, zero-risk `Vditor.preview` path — and in edit mode drop
inline click-to-flip, driving status changes from the rail and the
toolbar buttons instead. Read mode is zero-risk regardless; only
live-edit inline decoration depends on the spike.

### D-004 — Structured actions live in two parallel chrome surfaces
Date: 2026-05-20
Updated: 2026-05-20 (reconciled with D-003/D-007 during P-204)
Decision: +Decision, +Item, Set Now, Lint, History each open the same
modal composer regardless of where invoked. They render in **two**
chrome surfaces:

- **Read mode (default, D-007):** a React strip above the editor.
  Read mode mounts `MarkdownPreview` (per D-003's zero-risk static
  path), which has no vditor toolbar to hang `IMenuItem` entries on —
  so the strip is the only available surface. This is the surface that
  ships in v1 because read mode is the default.
- **Edit mode (Phase 2 P-202+):** ALSO available as custom
  `IMenuItem.click(event, vditor)` entries appended to `PLAN_TOOLBAR`
  for native styling + real hotkeys. Each toolbar item opens the same
  modal composer — no duplicate handler logic.

The earlier framing of "vditor toolbar only" was wrong: the actions
work fully in read mode (D-007), and read mode doesn't mount a full
editor. The strip carries the v1 burden; the toolbar items piggyback
once the editor is mounted. Result panels (lint banner, git diff
modal) remain React wraps regardless of surface.

### D-005 — Reuse `MarkdownEditor.tsx` unmodified
Date: 2026-05-20
Decision: The existing wrapper at
`apps/operator/app/_components/MarkdownEditor.tsx` is reused as-is. Its
four lifecycle invariants (config-only mount deps, value-sync without
remount, disabled-toggle without remount, cache disabled) are exactly
what this UI needs. The Plans tab adds a thin `PlanEditor` around it for
renderers + toolbar config; the wrapper itself is not forked.

### D-006 — All user-meaningful state in nuqs
Date: 2026-05-20
Decision: Selected plan, pane mode, search query and scope, every
filter, the current view — all nuqs URL state, never `useState`.
Matches the project default and `admin/testing/TestingClient.tsx`.
`useState` is reserved for transient lifecycle (loading, mid-edit
drafts, hover).

### D-007 — Read mode is the default; editing is opt-in
Date: 2026-05-20
Decision: Opening a plan lands in read mode. Status flips and the
structured-action buttons are tool calls, not text edits — they work
fully in read mode. Raw-prose Edit mode is a deliberate, separate
toggle. The common path (browse, flip a status, add a decision) never
enters raw-text editing. While raw-prose Edit mode is active with
unsaved changes, the structured-action buttons and inline status-flip
are disabled — an assisted write returns fresh markdown and `setValue`
would clobber the unsaved edit; the user saves or discards first, then
the actions re-enable.

### D-008 — v1 is request/response, no live sync
Date: 2026-05-20
Decision: No SSE/live-sync in v1 — fetch-on-focus, refetch-after-write,
manual refresh. The harness page already demonstrates SSE connection-
pool exhaustion; adding plan-file streams would spend that budget for
little gain on a low-churn surface. A filesystem-watcher → SSE feed is
deferred; revisit only if stale views become a real problem.

### D-009 — UI reaches `plans:*` via `/api/admin/plans/*` route handlers
Date: 2026-05-20
Decision: The Plans tab calls thin Next.js route handlers under
`/api/admin/plans/*` that invoke the `plans:*` endpoints in-process
under the admin principal. The direct-HTTP-projection idea from the
first draft was wrong: `plans:*` project HTTP only through the
superuser-bearer-authed MCP endpoint, and a browser admin client has
no token for it. Bespoke admin route handlers are also the established
pattern — every existing `/admin` tab (`/api/admin/llm-tests/*`,
`/api/admin/testing/*`) works this way. D-002 is unaffected: the
handler still reaches the data only through `plans:*`. This decision
corrects a first-draft claim and was made during the second review
pass.

### D-010 — The Plans tab is dual-homed across the Next→Vite migration
Date: 2026-05-20
Decision: A parallel `operator-vite` migration (TanStack Router, plan
`operator-vite-migration-2026-05-20`) is porting `/admin` route by
route. Phase B-2 ported the 5 admin pages that existed then
(`run/features/testing/tables/index`) — the Plans tab postdates it, so
without action it would be silently dropped when Next.js is retired in
Phase H. The Plans tab is therefore dual-homed:

- **Next.js:** `apps/operator/app/admin/plans/page.tsx` — live operator.
- **Vite:** `apps/operator-vite/src/routes/admin/plans.tsx` — a thin
  `createFileRoute('/admin/plans')` wrapper, mirroring
  `admin/features.tsx`. It reuses `PlansClient` and its whole subtree
  **directly** via the `@/` alias — no Vite-flavored fork needed,
  because the components carry zero `next/*` imports and operator-vite
  already mounts `NuqsAdapter` from `nuqs/adapters/tanstack-router`.
  (`admin/testing.tsx` needed a forked client only because the
  original used `next/dynamic`; the Plans subtree does not.)

The data layer is migration-agnostic: `PlansClient` fetches the
`/api/admin/plans/*` `defineRoute`s on the shared Hono app — one
backend for both operator front-ends. When Phase H removes
`apps/operator/app/`, only the Next `page.tsx` is deleted; the Vite
route and the (alias-resolved) component subtree carry forward.

### D-011 — Phase 3 write verbs: `plans:set-content` + `plans:set-frontmatter`
Date: 2026-05-20
Decision: Phase 3's two companion-plan asks were reviewed and accepted
by the owner of `agent-plan-tracking`, to land as that plan's Phase 5.
Two verbs, not one — prose editing and legacy conversion are different
problems and the second must stay structured:

**`plans:set-content { slug, content, expectedHash }`** — the one
genuinely unstructured verb, for P-301's whole-document Edit-mode save.
Contract:
- **Compare-and-swap (mandatory).** Inside the lock, hash the current
  file; if it ≠ `expectedHash`, reject `{ code: 'stale',
  currentContent }` — do not write. The structured verbs are safe
  because they read-modify-write inside the lock; a UI edit session
  holds the lock only for the write, not the minutes of editing, so
  CAS is what prevents a concurrent agent write being silently
  clobbered.
- **Legacy-boundary guard.** `plans:lint` exempts legacy plans, so a
  payload that drops `slug:` would degrade the plan to legacy and lint
  would pass vacuously. If the input was a non-legacy plan, reject if
  the result would be legacy.
- **Reject on lint errors** (allow with warnings); return findings
  either way so the UI shows them inline. The editor keeps the user's
  text on rejection so they fix and re-save.

**`plans:set-frontmatter { slug, title, status, created?, owner? }`** —
a structured frontmatter writer for P-302's legacy conversion,
extending the surgical-frontmatter technique already in
`with-plan-lock.ts` (`bumpUpdatedDate`). Legacy conversion does NOT
route through `set-content` — a sledgehammer for what is a structured
edit. The earlier `set-plan-status` idea was rejected as too narrow: a
legacy plan lacks `slug` and usually `title`/`created`, not just
`status`.

**Verb-name correction (2026-05-21 audit):** D-011 first named this
verb `plans:promote`. That name is **already taken** —
`apps/operator/lib/agent-tools/coordination/tools/promote.ts`
registers a `plans:promote` tool that promotes a plan *into a harness*
(args `harness_slug` + `features[]`), an entirely unrelated operation.
Registering a second `plans:promote` in Phase 5 would collide. The
frontmatter writer is therefore named **`plans:set-frontmatter`** —
the alternative the D-011 owner already offered, and a better fit for
the `set-status` / `set-now` / `set-content` family anyway.
`agent-plan-tracking` Phase 5 must register it under that name. The
admin route's `WRITE_VERBS` and the `promotePlan` client both target
`set-frontmatter`; `promote` is deliberately not exposed on the admin
plans route (it would reach the wrong tool).

**UI-contract refinement (this plan's side):** `plans:get` — and every
write verb's success envelope — must return a `contentHash`, so the UI
has a server-defined value to send back as `expectedHash` rather than
re-hashing `raw` and risking an algorithm/encoding mismatch. This is
requested of `agent-plan-tracking` Phase 5 alongside the two verbs.

Naming: `set-content` over the first-draft `write-raw` — the verb
locks, CAS-checks, and lints, so "raw" (= unchecked) is a misnomer;
`set-content` also matches the `set-status` / `set-now` family.

### D-012 — PlanDetail is keyed on slug + a dirty-nav guard
Date: 2026-05-21
Decision: `PlansClient` renders `<PlanDetail key={slug}>` so a plan
switch fully remounts the detail view, and routes every navigation
that abandons the open plan (rail click, view switch, search/inbox/
actionable/triage pick, back button, J/K and g-combo shortcuts)
through a single `leaveGuard()` that prompts when the plan has unsaved
edits. PlanDetail reports its dirty state up via `onDirtyChange`.

Rationale: a second-pass audit found that without the `key`, switching
plans mid-edit kept the previous plan's `draft` buffer in PlanDetail's
`useState` (the component was reused, not remounted) — a Save would
then write plan A's draft to plan B's file, and the `expectedHash`
compare-and-swap could not catch it because the hash was plan B's. The
`key` makes the remount structural; the guard makes the discard
explicit instead of silent. Do not remove the `key` or inline the
nav calls past the guard — both halves are load-bearing.

## Open questions

1. **Nav entry or URL-only?** `/admin` today redirects to `/admin/run`
   and has no global nav link — it is reachable by URL only. The Plans
   tab is added to the in-`/admin` tab strip regardless; the question is
   whether `/admin/plans` also gets a global ChromeShell nav entry. It
   is more user-facing than the rest of `/admin`. (Leaning: yes.)
2. **Companion-plan verbs for Phase 3 — RESOLVED.** The owner of
   `agent-plan-tracking` accepted two new verbs as that plan's Phase 5
   (see D-011 for the full contract): `plans:set-content` — whole-
   document write, guarded by `expectedHash` compare-and-swap, a
   legacy-boundary check, and reject-on-lint-error — and
   `plans:set-frontmatter` — a structured legacy→frontmatter writer
   (renamed from the first-draft `plans:promote`, which collides with
   an existing coordination tool — see D-011). `P-301` and `P-302` are
   unblocked once that Phase 5 lands; both stay `blocked` until then.
   The first-draft asks (per-item line numbers, list flags) were
   already satisfied and dropped; the `set-plan-
   status` idea was dropped as too narrow (a legacy plan lacks `slug`
   and `title`/`created` too, not just `status`).
3. **Git history surface — RESOLVED.** Promoted from the UI-only route
   handler to a pair of `plans:*` tools so agents get plan history
   too: `plans:history { slug, archived?, limit? }` (`git log
   --follow`) and `plans:diff { slug, hash, archived? }` (`git diff
   <hash>^!`). The shared logic lives in
   `lib/agent-tools/plans/git-history.ts` — the existing UI route
   (`/api/admin/plans/git/:op`) now thin-wraps the same helper, so the
   two surfaces cannot drift. Slug/hash regex-validated before reaching
   `execFile`; an untracked plan returns an empty list/diff, not an
   error. Unit-tested incl. a real-git integration test that read
   commits from this plan's companion (`agent-plan-tracking-2026-05-20`).
4. **Ship Phase 1 standalone?** Phase 1 (read-only browser) is useful
   on its own and is unblocked today. Ship it as its own release ahead
   of Phases 2–3? (Default: yes.)

## Out of scope (v1)

- Live SSE sync of plan files (D-008).
- A `blocked-by` dependency-graph / DAG visualization.
- `hint`-based `P-NNN`/`D-NNN` autocomplete while editing — vditor
  supports it (`hint.extend`), but it needs a single-character trigger
  and the plan format is deliberately sigil-free. Deferred to a format
  decision in `agent-plan-tracking`.
- Velocity, burndown, metrics, charts.
- A mobile layout.
- Multi-user presence / CRDT editing — the lock banner is the
  concurrency UX.
