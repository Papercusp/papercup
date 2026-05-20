---
title: nuqs audit — state that would benefit from URL serialization
slug: nuqs-audit-2026-05-11
status: active
created: 2026-05-11
updated: 2026-05-20
owner: pandawamble@gmail.com
---

## Now

**State:** **Date:** 2026-05-11 **Context:** Followup to the agent → UI control surface (ui-control-plan.md). The presence + dispatch system reads URLs to know what the user is looking at and writes URLs to drive nuqs-state changes — so every panel/tab/selection/filter that lives in `useState` instead of nuqs is invisible to agents and undriveable without a feature-registered intent.

**Next:** Owner: review current state and replace this auto-generated Now block (backfilled 2026-05-20).


# nuqs audit — state that would benefit from URL serialization

**Date:** 2026-05-11
**Context:** Followup to the agent → UI control surface (ui-control-plan.md). The presence + dispatch system reads URLs to know what the user is looking at and writes URLs to drive nuqs-state changes — so every panel/tab/selection/filter that lives in `useState` instead of nuqs is invisible to agents and undriveable without a feature-registered intent.

**Scope:** Walked `apps/operator/app/**/*.tsx`, filtered to files with ≥5 useStates, then to states that match UI navigation / selection / filter / modal-open patterns. Loading/error/saving/draft-input state intentionally excluded — those are transient by nature.

## High-value migrations (agent-relevant, deep-linkable, refresh-survivable)

### `apps/operator/app/dev/_components/SessionsTab.tsx`
- **L84 `expanded` (selected spawn_id)** — currently `useState<string | null>(null)`. This is the "drilled-into" spawn. Agent asking "what spawn is the user inspecting?" gets nothing back today. → `useQueryState('spawn', parseAsString)`.

### `apps/operator/app/dev/_components/ApiTab.tsx`
- **L62 `filter`** — free-text filter over tool list. Worth deep-linking ("send me the dev page filtered to harness:list"). → `useQueryState('q', parseAsString.withDefault(''))`.
- **L63 `showBuiltins`, L64 `showPlugins`** — visibility toggles. Combine into one `kinds` param. → `useQueryState('kinds', parseAsArrayOf(parseAsString).withDefault(['builtin','plugin']))`.
- **L70–73 `ctxHarness`, `ctxRun`, `ctxSpawn`** — debug-mode context preset. Worth saving in URL so reload restores the context. → individual nuqs params with `withDefault('dev-page')` for the run/spawn pair.

### `apps/operator/app/harness/IntelPanel.tsx`
- **L497 `query`** — search input on a panel. → `useQueryState('intelQuery', parseAsString.withDefault(''))`.
- **L498 `taskContext`** — context override. Worth deep-linking when an agent says "look at this with context X".
- **L504 `showAdvanced`** — panel collapse. → `useQueryState('intelAdvanced', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/harness/ProposalsPanel.tsx`
- **L313 `selected` (proposal id)** — agent should be able to ask "which proposal is highlighted?". → `useQueryState('proposal', parseAsString)`.
- **L333 `query`** — filter input. → `useQueryState('proposalQuery', parseAsString.withDefault(''))`.
- **L316 `editingGoal`** — edit-mode toggle. Subtle: edit mode usually shouldn't survive reload (loses unsaved draft). Skip.
- **L332 `replanOnAccept`** — sticky toggle the user keeps changing. → `useQueryState` worth it for the persistence; but could also live in localStorage.

### `apps/operator/app/harness/ExpertsPanel.tsx`
- **L75 `showSpawn`** — modal-open. Modals being URL-driven means an agent can open them. → `useQueryState('spawn', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/harness/PiPanel.tsx`
- **L180 `showFind`, L184 `findQuery`** — find-in-panel modal. → `useQueryState` pair.
- **L189 `showTools`, L191 `showSessions`** — additional modal toggles. → boolean nuqs.

### `apps/operator/app/harness/FeatureEditor.tsx`
- **L109 `historyOpen`** — sidepanel open. → `useQueryState('history', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/harness/[slug]/projects/[id]/ProjectDetail.tsx`
- **L83 `editing`** — edit mode toggle. (Same draft-loss caveat as ProposalsPanel.editingGoal; if you care about preserving the draft, leave it.)
- **L87 `showRevisions`** — revisions panel. → `useQueryState('revisions', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/settings/plugins/page.tsx`
- **L68 `activeHarness`, L69 `activePlugin`** — drilldown selection. Strong candidate; agent should know which plugin row the user is on. → two string params.
- **L417 `advanced`** — disclosure toggle for the OAuth section. → `useQueryState('advanced', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/installed/templates/[slug]/edit/page.tsx`
- **L61 `activePath`** — selected file in the tree. Strong deep-link candidate.
- **L67 `manifestRawMode`** — view mode toggle. → `useQueryState('manifestRaw', parseAsBoolean.withDefault(false))`.
- **L68 `addFileOpen`** — modal toggle. → `useQueryState('addFile', parseAsBoolean.withDefault(false))`.

### `apps/operator/app/settings/voice/page.tsx`
- **L72 `showLeakWarning`** — dismissible notice; sometimes-helpful in URL but more naturally localStorage-backed.
- **L953 `addRole`** — selection within a panel. → `useQueryState('addRole', parseAsString.withDefault('worker'))`.

---

## Loose principle (what NOT to migrate)

| Pattern | Example | Why local-only |
|---|---|---|
| Loading/saving/busy/streaming | `setSaving(true)` | Internal lifecycle, no user value in URL |
| Error messages | `setError('...')` | Lifecycle-bound; cleared on retry |
| Mid-edit input drafts | `setDraft(text)` | Spams history; lost-data risk on reload |
| Transient toasts | `setToast('done')` | Auto-dismisses; URL pollution |
| Just-copied indicator | `setCopied(true)` | 2-second highlight |
| Optimistic-update flags | various | Cleared by next server response |
| Modal validation/dirty | `setHasUnsavedChanges` | Local to the modal's lifecycle |

---

## Update — 2026-05-11 (later that day)

Original 24-param batch shipped, then a deeper audit identified **22 more** candidates across 17 files. All shipped in commit `dc62eb03`:

**Batch 3 — panels/dropdowns/banners (10 params, 9 files)**

| File | State | URL param |
|---|---|---|
| `_components/RecentActionsCenter` | `open` | `?recent` |
| `_components/NotificationCenter` | `open` | `?notifications` |
| `_components/BacklinksPanel` | `open` (default true) | `?backlinks` |
| `_components/WorkspaceSwitcher` | `open` | `?wsSwitch` |
| `harness/PlanReviewBanner` | `open`/`dismissed` | `?planReview`/`?planDismissed` |
| `harness/EscalationBanner` | `showNotes` | `?escalationNotes` |
| `harness/FeaturePeekPanel` | `showDebug`/`showTimeline` | `?peekDebug`/`?peekTimeline` |
| `harness/issues/IssueDetail` | `showTimeline` | `?issueTimeline` |
| `harness/DecisionsPanel` | `hideGhosts` | `?hideGhosts` |

**Batch 4 — tabs/views (9 params, 7 files)**

| File | State | URL param |
|---|---|---|
| `harness/HarnessDashboard:1902` | `mode: 'fields'\|'json'` | `?editorMode` |
| `harness/HarnessDashboard:4782` | `tab: 'issues'\|'report'\|'tests'` | `?validationTab` |
| `harness/ExpertsPanel:219` | `tab: 'spec'\|'feedback'\|'chat'\|'identity'` | `?expertTab` |
| `harness/ExpertsPanel:881` | `open` (dispatch list, default true) | `?dispatchList` |
| `design/[slug]/RegressionPane` | `filter: 'all'\|'regressions'\|'clean'` | `?regressionFilter` |
| `design/[slug]/SketchPane` | `tool: 'pen'\|'eraser'` | `?sketchTool` |
| `settings/operator/page` | `statsOpen` | `?stats` |
| `harness/SpecEditor` | `envRevealed` | `?showEnv` |
| `harness/brainstorm/BrainstormPanel` | `chatOpen` | `?chat` |

**Batch 5 — selections (3 params, 3 files)**

| File | State | URL param |
|---|---|---|
| `harness/HarnessDashboard:2301` | `activeSlug` | `?slug` |
| `design/[slug]/DesignDashboard` | `selectedFeatureId` | `?feature` |
| `harness/ExpertsPanel:74` | `selection` (discriminated union) | `?expertSel` (JSON-encoded, shape-guarded) |

**Skipped from batch 6 (per caller decision):** `ProposalsPanel.shortlistOnly`, `ProposalsPanel.replanOnAccept` — preferences; localStorage is a more natural fit.

**Confirmed NOT migratable (still local state):**

| Pattern | Where | Why |
|---|---|---|
| `OracleDock.activeHarnessSlug` | derived from URL via `slugFromUrl()` | already URL-bound |
| `PiPanel.showFind` | ref-coupled to xterm search addon | sync ref reads break |
| `ProposalsPanel.editingGoal`, `ProjectDetail.editing` | mid-edit modes | would lose drafts |

**Session totals**

- 46 params migrated (24 original + 22 follow-up)
- 26 files touched (12 original + 17 follow-up, with overlap)
- End-to-end re-verified: agent drove a real Playwright tab through `?recent=true&validationTab=report&backlinks=false&planReview=true` via MCP `ui:dispatch`
- All 5 integration suites green on both `:3055` (64/0) and `:3070` (64/0)

---

## Estimated effort to migrate the high-value set

| File | New params | LOC | Notes |
|---|---|---|---|
| SessionsTab | 1 | ~5 | trivial |
| ApiTab | 4 | ~20 | multi-param panel state |
| IntelPanel | 3 | ~15 | |
| ProposalsPanel | 2 | ~10 | (skip editingGoal) |
| ExpertsPanel | 1 | ~5 | |
| PiPanel | 4 | ~20 | several toggles + a query |
| FeatureEditor | 1 | ~5 | |
| ProjectDetail | 1 | ~5 | (skip editing) |
| settings/plugins | 3 | ~15 | |
| templates/edit | 3 | ~15 | |
| settings/voice | 1 | ~5 | |
| **Total** | **24** | **~120** | half a day |

## Recommendation

Do the **high-value-set in two batches**: drilldown selections (SessionsTab.expanded, ProposalsPanel.selected, settings/plugins.{activeHarness,activePlugin}, templates/edit.activePath) first — these unlock "what is the user looking at?" answers immediately. Then the toggle/filter batch.

Skip everything in the "what NOT to migrate" table; the URL becomes noisy and history-spammy otherwise.

After the first batch, agents using `ui:get_state` will see selection state for free, and `set_url` can deep-link any of these. No new tool work needed.

## Out-of-scope state that the spec called out (the "5–10% of cases" gap)

Some state genuinely doesn't belong in the URL but agents might still want to read it:
- focused element / active selection range
- inflight mutation state ("saving…")
- scroll position
- form-dirty state

If these become relevant, add a `client_id`-keyed scratchpad row (jsonb `extras` column on `ui_clients`, or a sibling `ui_client_extras` table) and a `useUiExtra(name, value)` hook. Mirror the same registry pattern, different storage. Don't ship this until the use case is concrete — the migration set above is the bigger lever.
